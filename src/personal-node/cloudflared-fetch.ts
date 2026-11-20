import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { PayloadRejected } from "./validate.ts";

/**
 * Pinned Cloudflare cloudflared release.
 *
 * The download URL is `urlPrefix + version + "/" + filename` and nothing else.
 * SHA256 is of that downloaded file. Darwin assets are gzip tarballs of a
 * single `cloudflared` binary. Linux amd64 is the raw binary.
 *
 * These digests match the files served for 2026.10.3 (the asset sizes match
 * the GitHub release). The release-note lines for the two Darwin tarballs
 * do not match those files.
 */
export const CLOUDFLARED_RELEASE = {
  version: "2026.10.3",
  urlPrefix: "https://github.com/cloudflare/cloudflared/releases/download/",
  assets: {
    "darwin/arm64": {
      filename: "cloudflared-darwin-arm64.tgz",
      sha256: "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
      format: "tgz",
    },
    "darwin/amd64": {
      filename: "cloudflared-darwin-amd64.tgz",
      sha256: "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
      format: "tgz",
    },
    "linux/amd64": {
      filename: "cloudflared-linux-amd64",
      sha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
      format: "binary",
    },
  },
} as const satisfies CloudflaredRelease;

export const CLOUDFLARED_TARGETS = ["darwin/arm64", "darwin/amd64", "linux/amd64"] as const;
export type CloudflaredTarget = (typeof CLOUDFLARED_TARGETS)[number];

export type CloudflaredAsset = {
  filename: string;
  sha256: string;
  format: "binary" | "tgz";
};

export type CloudflaredRelease = {
  version: string;
  urlPrefix: string;
  assets: Record<CloudflaredTarget, CloudflaredAsset>;
};

export const CLOUDFLARED_CHECKSUM_MISMATCH =
  "cloudflared_checksum_mismatch: The downloaded cloudflared file did not match the pinned SHA256. The file was deleted and was not executed.";

export const CLOUDFLARED_UNSUPPORTED_ARCH =
  "cloudflared_unsupported_arch: This OS/arch has no pinned cloudflared binary. Supported targets are darwin/arm64, darwin/amd64, and linux/amd64. Nothing was downloaded.";

export const CLOUDFLARED_DOWNLOAD_FAILED =
  "cloudflared_download_failed: cloudflared could not be stored from the pinned Cloudflare GitHub release. Nothing was executed.";

export const CLOUDFLARED_DOWNLOAD_REJECTED =
  "cloudflared_download_rejected: cloudflared is downloaded only from https://github.com/cloudflare/cloudflared/releases/download/ for the pinned version. Nothing was executed.";

const DOWNLOAD_HOST = "github.com";
const RELEASE_PATH = "/cloudflare/cloudflared/releases/download/";

/**
 * GitHub answers the pinned release URL with a 302 to its own asset host.
 * The request we choose is still the github.com URL above. Any other host is rejected.
 */
const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const MAX_BYTES = 80 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const VERSION_NAME = "cloudflared.version";

const inflight = new Map<string, Promise<string>>();

export type CloudflaredDownloader = (request: {
  url: string;
  destination: string;
}) => Promise<void>;

export function cloudflaredTarget(platform: string, arch: string): CloudflaredTarget | null {
  const normalized =
    arch === "x64" || arch === "amd64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (platform === "darwin" && normalized === "arm64") return "darwin/arm64";
  if (platform === "darwin" && normalized === "amd64") return "darwin/amd64";
  if (platform === "linux" && normalized === "amd64") return "linux/amd64";
  return null;
}

export function cloudflaredAssetUrl(
  release: CloudflaredRelease,
  target: CloudflaredTarget,
): string {
  const asset = release.assets[target];
  const url = `${release.urlPrefix}${release.version}/${asset.filename}`;
  assertPinnedCloudflaredUrl(url, release);
  if (!url.endsWith(`/${asset.filename}`)) {
    throw new PayloadRejected("cloudflared_download_rejected", CLOUDFLARED_DOWNLOAD_REJECTED);
  }
  return url;
}

export function assertPinnedCloudflaredUrl(
  raw: string,
  release: Pick<CloudflaredRelease, "version" | "urlPrefix">,
): URL {
  let prefix: URL;
  let url: URL;
  try {
    prefix = new URL(release.urlPrefix);
    url = new URL(raw);
  } catch {
    throw new PayloadRejected("cloudflared_download_rejected", CLOUDFLARED_DOWNLOAD_REJECTED);
  }
  if (
    prefix.protocol !== "https:" ||
    prefix.host !== DOWNLOAD_HOST ||
    prefix.pathname !== RELEASE_PATH ||
    prefix.username ||
    prefix.password ||
    prefix.search ||
    prefix.hash
  ) {
    throw new PayloadRejected("cloudflared_download_rejected", CLOUDFLARED_DOWNLOAD_REJECTED);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(release.version)) {
    throw new PayloadRejected("cloudflared_download_rejected", CLOUDFLARED_DOWNLOAD_REJECTED);
  }
  const filename = url.pathname.slice(`${RELEASE_PATH}${release.version}/`.length);
  if (
    url.protocol !== "https:" ||
    url.host !== DOWNLOAD_HOST ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `${RELEASE_PATH}${release.version}/${filename}` ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
  ) {
    throw new PayloadRejected("cloudflared_download_rejected", CLOUDFLARED_DOWNLOAD_REJECTED);
  }
  return url;
}

function sha256Equal(actual: string, expected: string): boolean {
  const left = actual.trim().toLowerCase();
  const right = expected.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function sha256File(file: string): Promise<string> {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

function headerName(header: Buffer): string {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

/** Gzip tarball containing one regular file named `cloudflared`. */
export function extractCloudflaredBinary(archive: Buffer): Buffer {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
  }
  let offset = 0;
  let found: Buffer | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isInteger(size) || size < 0 || offset + 512 + size > tar.length) {
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    const typeflag = header[156] ?? 0;
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    // Directory, pax extended header, or pax global header.
    if (typeflag === 53 || typeflag === 120 || typeflag === 103) continue;
    if (typeflag !== 0 && typeflag !== 48) {
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    const name = headerName(header).replace(/^\.\//, "");
    if (name !== "cloudflared" || name.includes("/") || name.includes("..")) {
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    if (found || data.length === 0) {
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    found = Buffer.from(data);
  }
  if (!found) {
    throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
  }
  return found;
}

function assertRedirect(next: URL): void {
  if (
    next.protocol !== "https:" ||
    !REDIRECT_HOSTS.has(next.host) ||
    next.username ||
    next.password
  ) {
    throw new PayloadRejected("cloudflared_download_rejected", CLOUDFLARED_DOWNLOAD_REJECTED);
  }
}

export async function downloadPinnedCloudflared(input: {
  url: string;
  version: string;
  urlPrefix: string;
  destination: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  assertPinnedCloudflaredUrl(input.url, { version: input.version, urlPrefix: input.urlPrefix });
  const fetchImpl = input.fetchImpl ?? fetch;
  let current = input.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, { redirect: "manual" });
    } catch {
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new PayloadRejected("cloudflared_download_rejected", CLOUDFLARED_DOWNLOAD_REJECTED);
      }
      assertRedirect(next);
      current = next.toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
    }
    await mkdir(path.dirname(input.destination), { recursive: true, mode: 0o700 });
    await rm(input.destination, { force: true });
    await writeFile(input.destination, bytes, { mode: 0o600 });
    return;
  }
  throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
}

async function readCachedBinary(binDir: string, version: string): Promise<string | null> {
  const bin = path.join(binDir, "cloudflared");
  try {
    const marked = (await readFile(path.join(binDir, VERSION_NAME), "utf8")).trim();
    if (marked !== version) return null;
    const info = await lstat(bin);
    if (!info.isFile()) return null;
    await chmod(bin, 0o755);
    return bin;
  } catch {
    return null;
  }
}

async function installCloudflared(input: {
  stateDir: string;
  platform: string;
  arch: string;
  release: CloudflaredRelease;
  download?: CloudflaredDownloader;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const target = cloudflaredTarget(input.platform, input.arch);
  if (!target) {
    throw new PayloadRejected("cloudflared_unsupported_arch", CLOUDFLARED_UNSUPPORTED_ARCH);
  }
  if (!input.stateDir || input.stateDir.includes("\0")) {
    throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
  }
  const stateDir = path.resolve(input.stateDir);
  const binDir = path.join(stateDir, "bin");
  const cached = await readCachedBinary(binDir, input.release.version);
  if (cached) return cached;

  const url = cloudflaredAssetUrl(input.release, target);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700);
  const partial = path.join(binDir, ".cloudflared.partial");
  const staged = path.join(binDir, ".cloudflared.staged");
  const finalPath = path.join(binDir, "cloudflared");
  const download =
    input.download ??
    (async (request: { url: string; destination: string }) => {
      await downloadPinnedCloudflared({
        url: request.url,
        version: input.release.version,
        urlPrefix: input.release.urlPrefix,
        destination: request.destination,
        fetchImpl: input.fetchImpl,
      });
    });
  try {
    await download({ url, destination: partial });
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof PayloadRejected) throw error;
    throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
  }

  let actual = "";
  try {
    actual = await sha256File(partial);
  } catch {
    await rm(partial, { force: true });
    throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
  }
  const expected = input.release.assets[target].sha256;
  if (!sha256Equal(actual, expected)) {
    await rm(partial, { force: true });
    await rm(staged, { force: true });
    throw new PayloadRejected("cloudflared_checksum_mismatch", CLOUDFLARED_CHECKSUM_MISMATCH);
  }

  try {
    if (input.release.assets[target].format === "tgz") {
      const binary = extractCloudflaredBinary(await readFile(partial));
      await rm(staged, { force: true });
      await writeFile(staged, binary, { mode: 0o755 });
    } else {
      await rm(staged, { force: true });
      await rename(partial, staged);
    }
    await chmod(staged, 0o755);
    await rm(finalPath, { force: true });
    await rename(staged, finalPath);
    await chmod(finalPath, 0o755);
    const versionPath = path.join(binDir, VERSION_NAME);
    await writeFile(versionPath, `${input.release.version}\n`, { mode: 0o600 });
    await chmod(versionPath, 0o600);
  } catch (error) {
    await rm(staged, { force: true });
    await rm(partial, { force: true });
    if (error instanceof PayloadRejected) throw error;
    throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
  } finally {
    await rm(partial, { force: true });
  }
  if (path.basename(finalPath) !== "cloudflared" || !path.isAbsolute(finalPath)) {
    throw new PayloadRejected("cloudflared_download_failed", CLOUDFLARED_DOWNLOAD_FAILED);
  }
  return finalPath;
}

export function ensureCloudflaredBinary(input: {
  stateDir: string;
  platform: string;
  arch: string;
  release?: CloudflaredRelease;
  download?: CloudflaredDownloader;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const stateKey = path.resolve(input.stateDir || ".");
  const existing = inflight.get(stateKey);
  if (existing) return existing;
  const release = input.release ?? CLOUDFLARED_RELEASE;
  const promise = installCloudflared({ ...input, release }).finally(() => {
    if (inflight.get(stateKey) === promise) inflight.delete(stateKey);
  });
  inflight.set(stateKey, promise);
  return promise;
}

export function cloudflaredBinaryPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), "bin", "cloudflared");
}
