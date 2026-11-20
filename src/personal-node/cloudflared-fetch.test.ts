import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUDFLARED_RELEASE,
  cloudflaredAssetUrl,
  cloudflaredBinaryPath,
  cloudflaredTarget,
  downloadPinnedCloudflared,
  ensureCloudflaredBinary,
  extractCloudflaredBinary,
  type CloudflaredRelease,
} from "./cloudflared-fetch.js";
import { PayloadRejected } from "./validate.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tarFile(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  const writeOctal = (value: number, offset: number, length: number) => {
    header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "utf8");
    header[offset + length - 1] = 0;
  };
  header.write(name, 0, Math.min(name.length, 100), "utf8");
  writeOctal(0o755, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(content.length, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 48;
  header.write("ustar", 257, 5, "utf8");
  header[262] = 0;
  header.write("00", 263, 2, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "utf8");
  header[154] = 0;
  header[155] = 0x20;
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(pad), Buffer.alloc(1024)]);
}

describe("pinned cloudflared download", () => {
  it("pins the official GitHub release URL and the checksums of those files", () => {
    expect(CLOUDFLARED_RELEASE.version).toBe("2026.10.3");
    expect(CLOUDFLARED_RELEASE.urlPrefix).toBe(
      "https://github.com/cloudflare/cloudflared/releases/download/",
    );
    expect(cloudflaredAssetUrl(CLOUDFLARED_RELEASE, "darwin/arm64")).toBe(
      "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-darwin-arm64.tgz",
    );
    expect(cloudflaredAssetUrl(CLOUDFLARED_RELEASE, "darwin/amd64")).toBe(
      "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-darwin-amd64.tgz",
    );
    expect(cloudflaredAssetUrl(CLOUDFLARED_RELEASE, "linux/amd64")).toBe(
      "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-linux-amd64",
    );
    expect(CLOUDFLARED_RELEASE.assets["darwin/arm64"].sha256).toBe(
      "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
    );
    expect(CLOUDFLARED_RELEASE.assets["darwin/amd64"].sha256).toBe(
      "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
    );
    expect(CLOUDFLARED_RELEASE.assets["linux/amd64"].sha256).toBe(
      "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
    );
    expect(cloudflaredTarget("darwin", "arm64")).toBe("darwin/arm64");
    expect(cloudflaredTarget("darwin", "x64")).toBe("darwin/amd64");
    expect(cloudflaredTarget("linux", "x64")).toBe("linux/amd64");
    expect(cloudflaredTarget("linux", "amd64")).toBe("linux/amd64");
    expect(cloudflaredTarget("linux", "arm64")).toBeNull();
    expect(cloudflaredTarget("darwin", "ia32")).toBeNull();
    expect(cloudflaredTarget("win32", "amd64")).toBeNull();
  });

  it("rejects a download URL that is not the pinned GitHub release", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-url-"));
    dirs.push(dir);
    let called = false;
    await expect(
      downloadPinnedCloudflared({
        url: "https://evil.example/cloudflared",
        version: CLOUDFLARED_RELEASE.version,
        urlPrefix: CLOUDFLARED_RELEASE.urlPrefix,
        destination: path.join(dir, "cloudflared"),
        fetchImpl: async () => {
          called = true;
          return new Response("no");
        },
      }),
    ).rejects.toBeInstanceOf(PayloadRejected);
    expect(called).toBe(false);

    let downloaded = false;
    const bad: CloudflaredRelease = {
      ...CLOUDFLARED_RELEASE,
      urlPrefix: "https://evil.example/cloudflare/cloudflared/releases/download/",
    };
    await expect(
      ensureCloudflaredBinary({
        stateDir: dir,
        platform: "linux",
        arch: "amd64",
        release: bad,
        download: async () => {
          downloaded = true;
        },
      }),
    ).rejects.toMatchObject({ code: "cloudflared_download_rejected" });
    expect(downloaded).toBe(false);
  });

  it("follows a GitHub asset redirect and rejects any other host", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-redir-"));
    dirs.push(dir);
    const official = cloudflaredAssetUrl(CLOUDFLARED_RELEASE, "linux/amd64");
    const good = path.join(dir, "good");
    const seen: string[] = [];
    await downloadPinnedCloudflared({
      url: official,
      version: CLOUDFLARED_RELEASE.version,
      urlPrefix: CLOUDFLARED_RELEASE.urlPrefix,
      destination: good,
      fetchImpl: async (input, init) => {
        const url = String(input);
        seen.push(url);
        expect(init?.redirect).toBe("manual");
        if (url === official) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/asset" },
          });
        }
        return new Response(Buffer.from("pinned-bytes"), { status: 200 });
      },
    });
    expect(seen[0]).toBe(official);
    expect(seen[1]).toBe("https://release-assets.githubusercontent.com/asset");
    expect(await readFile(good, "utf8")).toBe("pinned-bytes");

    const bad = path.join(dir, "bad");
    await expect(
      downloadPinnedCloudflared({
        url: official,
        version: CLOUDFLARED_RELEASE.version,
        urlPrefix: CLOUDFLARED_RELEASE.urlPrefix,
        destination: bad,
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/cloudflared?token=secret" },
          }),
      }),
    ).rejects.toMatchObject({ code: "cloudflared_download_rejected" });
    await expect(access(bad)).rejects.toThrow();
  });

  it("stores a checksum-matched binary and reuses it without downloading again", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-bin-"));
    dirs.push(dir);
    const bytes = Buffer.from("#!/bin/sh\necho cloudflared\n");
    const release: CloudflaredRelease = {
      ...CLOUDFLARED_RELEASE,
      version: "test-bin",
      assets: {
        ...CLOUDFLARED_RELEASE.assets,
        "linux/amd64": {
          filename: "cloudflared-linux-amd64",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          format: "binary",
        },
      },
    };
    let calls = 0;
    const download = async ({ destination }: { url: string; destination: string }) => {
      calls += 1;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(destination, bytes);
    };
    const first = await ensureCloudflaredBinary({
      stateDir: dir,
      platform: "linux",
      arch: "x64",
      release,
      download,
    });
    const second = await ensureCloudflaredBinary({
      stateDir: dir,
      platform: "linux",
      arch: "amd64",
      release,
      download,
    });
    expect(first).toBe(cloudflaredBinaryPath(dir));
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(await readFile(first)).toEqual(bytes);
    const mode = await stat(first);
    expect(mode.mode & 0o111).not.toBe(0);
    await expect(access(path.join(dir, "bin", ".cloudflared.partial"))).rejects.toThrow();
  });

  it("extracts a Darwin tarball only after the archive checksum matches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-tgz-"));
    dirs.push(dir);
    const inner = Buffer.from("#!/bin/sh\necho darwin\n");
    const archive = gzipSync(tarFile("cloudflared", inner));
    const release: CloudflaredRelease = {
      ...CLOUDFLARED_RELEASE,
      version: "test-tgz",
      assets: {
        ...CLOUDFLARED_RELEASE.assets,
        "darwin/arm64": {
          filename: "cloudflared-darwin-arm64.tgz",
          sha256: createHash("sha256").update(archive).digest("hex"),
          format: "tgz",
        },
      },
    };
    const installed = await ensureCloudflaredBinary({
      stateDir: dir,
      platform: "darwin",
      arch: "arm64",
      release,
      download: async ({ url, destination }) => {
        expect(url).toBe(
          "https://github.com/cloudflare/cloudflared/releases/download/test-tgz/cloudflared-darwin-arm64.tgz",
        );
        const { writeFile } = await import("node:fs/promises");
        await writeFile(destination, archive);
      },
    });
    expect(await readFile(installed)).toEqual(inner);
  });

  it("rejects a tarball that is not the single cloudflared binary", () => {
    const inner = Buffer.from("nope");
    expect(() => extractCloudflaredBinary(gzipSync(tarFile("../cloudflared", inner)))).toThrow(
      PayloadRejected,
    );
    const combined = gzipSync(
      Buffer.concat([tarFile("cloudflared", inner).subarray(0, 1024), tarFile("other", inner)]),
    );
    expect(() => extractCloudflaredBinary(combined)).toThrow(PayloadRejected);
  });

  it("deletes a mismatched download and does not leave an executable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-bad-"));
    dirs.push(dir);
    await expect(
      ensureCloudflaredBinary({
        stateDir: dir,
        platform: "darwin",
        arch: "amd64",
        download: async ({ destination }) => {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(destination, Buffer.from("wrong"));
        },
      }),
    ).rejects.toMatchObject({ code: "cloudflared_checksum_mismatch" });
    await expect(access(path.join(dir, "bin", "cloudflared"))).rejects.toThrow();
    await expect(access(path.join(dir, "bin", ".cloudflared.partial"))).rejects.toThrow();
  });

  it("does not download an unsupported arch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-arch-"));
    dirs.push(dir);
    let downloaded = false;
    await expect(
      ensureCloudflaredBinary({
        stateDir: dir,
        platform: "linux",
        arch: "arm64",
        download: async () => {
          downloaded = true;
        },
      }),
    ).rejects.toMatchObject({ code: "cloudflared_unsupported_arch" });
    await expect(
      ensureCloudflaredBinary({
        stateDir: dir,
        platform: "darwin",
        arch: "unknown",
        download: async () => {
          downloaded = true;
        },
      }),
    ).rejects.toMatchObject({ code: "cloudflared_unsupported_arch" });
    expect(downloaded).toBe(false);
  });
});
