import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { main } from "./cli.ts";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = path.join(mkdtempSync(path.join(tmpdir(), "pn-bundle-")), "personal-node.mjs");

beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    [path.join(agentRoot, "scripts/build-personal-node.mjs"), "--outfile", BUNDLE],
    { encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
}, 60_000);

describe("personal-node standalone bundle", () => {
  it("rejects a bad session id the same way the CLI does", async () => {
    const args = [
      "pair",
      "--server",
      "http://127.0.0.1:9",
      "--session-id",
      "not-a-uuid",
      "--code",
      "ABCD-EFGH",
      "--state-dir",
      path.join(tmpdir(), "pna-bundle-test"),
    ];
    let err = "";
    const code = await main(
      args,
      {},
      {
        stderr: (line) => {
          err += line;
        },
      },
    );
    expect(code).toBe(1);
    expect(err).toContain("session id must be a UUID.");

    const child = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: "utf8" });
    expect(child.status).toBe(code);
    expect(child.stderr).toContain("session id must be a UUID.");
    expect(child.stdout).not.toContain("ABCD-EFGH");
    expect(child.stderr).not.toContain("ABCD-EFGH");
  });

  it("includes the saved-state run path", () => {
    const body = readFileSync(BUNDLE, "utf8");
    expect(body).toContain("Saved personal node state has no server origin");
    expect(body).toContain("https://github.com/cloudflare/cloudflared/releases/download/");
    expect(body).toContain("2026.10.3");
    expect(body).toContain("cloudflared_checksum_mismatch");
    expect(body).toContain("/tunnel");
    expect(body).toContain("tunnel_not_configured");
    expect(body).not.toContain("CLOUDFLARE_API_TOKEN=");
    expect(body).not.toContain("CLOUDFLARE_TUNNEL_TOKEN=");
  });

  it("prints a version stamped with the package version and build hash", () => {
    const pkg = JSON.parse(readFileSync(path.join(agentRoot, "package.json"), "utf8"));
    const child = spawnSync(process.execPath, [BUNDLE, "version"], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(
      `projectmind-agent@${pkg.version}+${child.stdout.trim().split("+")[1]}\n`,
    );
    expect(child.stdout).toMatch(/^projectmind-agent@[0-9.]+\+[0-9a-f]{8}\n$/);
    expect(child.stdout.trim().length).toBeLessThanOrEqual(40);
  });
});
