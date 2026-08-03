import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_ENV_SOURCE, PRODUCTION_MCP_URL, writePackagedEnvFiles } from "./packaged-env.mjs";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const downloadsDir = resolve(agentRoot, "../public/downloads/agent");

describe("packaged-env", () => {
  it("ships .env and .env.example with production MCP URL and sample keys", async () => {
    const stage = await mkdtemp(join(tmpdir(), "imemory-packaged-env-"));
    try {
      const body = await writePackagedEnvFiles(stage, agentRoot);
      expect(body).toContain(`IMEMORY_MCP_URL=${PRODUCTION_MCP_URL}`);
      expect(body).toMatch(/IMEMORY_API_KEY=imk_/);
      expect(body).toContain("IMEMORY_WORKSPACE_ALLOWLIST=");

      const env = await readFile(join(stage, ".env"), "utf8");
      const example = await readFile(join(stage, ".env.example"), "utf8");
      expect(env).toBe(body);
      expect(example).toBe(body);
      expect(env).toContain(PRODUCTION_MCP_URL);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("keeps the package source file in the agent root", async () => {
    const src = await readFile(join(agentRoot, PACKAGE_ENV_SOURCE), "utf8");
    expect(src).toContain(PRODUCTION_MCP_URL);
  });

  it("published download zips include .env.example with sample data and real app URL", async () => {
    if (!existsSync(downloadsDir)) return;
    const zips = (await readdir(downloadsDir)).filter((name) => name.endsWith(".zip"));
    expect(zips.length).toBeGreaterThan(0);
    for (const name of zips) {
      const zip = join(downloadsDir, name);
      const listed = spawnSync("unzip", ["-l", zip], { encoding: "utf8" });
      expect(listed.status).toBe(0);
      expect(listed.stdout).toMatch(/(^|\s)\.env\.example(\s|$)/m);
      const example = spawnSync("unzip", ["-p", zip, ".env.example"], { encoding: "utf8" });
      expect(example.status).toBe(0);
      expect(example.stdout).toMatch(/IMEMORY_MCP_URL=https:\/\/(projectm\.dev|projectmind\.lifenode\.app)\/api\/mcp/);
      expect(example.stdout).toMatch(/IMEMORY_API_KEY=imk_/);
      expect(example.stdout).toContain("IMEMORY_WORKSPACE_ALLOWLIST=");
    }
  });
});
