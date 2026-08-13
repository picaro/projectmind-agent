import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldRunSetupWizard } from "./setup-wizard.js";

describe("shouldRunSetupWizard", () => {
  const originalApiKey = process.env.IMEMORY_API_KEY;
  const originalMcpKey = process.env.MCP_API_KEY;
  let dir: string;

  beforeEach(async () => {
    delete process.env.IMEMORY_API_KEY;
    delete process.env.MCP_API_KEY;
    dir = await mkdtemp(join(tmpdir(), "pm-agent-setup-"));
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.IMEMORY_API_KEY;
    else process.env.IMEMORY_API_KEY = originalApiKey;
    if (originalMcpKey === undefined) delete process.env.MCP_API_KEY;
    else process.env.MCP_API_KEY = originalMcpKey;
    await rm(dir, { recursive: true, force: true });
  });

  it("skips when process env already has an imgk_ key", async () => {
    process.env.IMEMORY_API_KEY = "imgk_from_shell";
    expect(await shouldRunSetupWizard(join(dir, "missing.env"))).toBe(false);
  });

  it("skips when .env has an imgk_ key without allowlist", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "IMEMORY_API_KEY=imgk_browser_login\n", "utf8");
    expect(await shouldRunSetupWizard(envPath)).toBe(false);
  });

  it("runs when .env is missing", async () => {
    expect(await shouldRunSetupWizard(join(dir, ".env"))).toBe(true);
  });

  it("runs when .env has no usable key", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "IMEMORY_MCP_URL=https://projectm.dev/api/mcp\n", "utf8");
    expect(await shouldRunSetupWizard(envPath)).toBe(true);
  });
});
