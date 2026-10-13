import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers = vi.hoisted(() => [] as string[]);
const deviceLogin = vi.hoisted(() => vi.fn());

vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_question: string, callback: (answer: string) => void) => {
      callback(answers.shift() ?? "");
    },
    close: () => {},
  }),
}));

vi.mock("./device-login.js", () => ({
  runDeviceLogin: (...args: unknown[]) => deviceLogin(...args),
}));

vi.mock("./runners/resolve.js", () => ({
  commandExists: async () => false,
  cursorApiKey: () => "",
  codexApiKey: () => "",
  claudeApiKey: () => "",
  copilotApiKey: () => "",
  codexCliBin: () => "codex",
  antigravityCliBin: () => "agy",
  claudeCliBin: () => "claude",
  copilotCliBin: () => "copilot",
}));

vi.mock("./runners/cursor-cli.js", () => ({
  resolveCursorCliCommand: async () => "cursor-agent",
}));

import { runSetupWizard, shouldRunSetupWizard } from "./setup-wizard.js";

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

describe("runSetupWizard", () => {
  let dir: string;
  let envPath: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pm-wizard-"));
    envPath = join(dir, ".env");
    answers.splice(0, answers.length);
    deviceLogin.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function fileExists(): Promise<boolean> {
    try {
      await access(envPath);
      return true;
    } catch {
      return false;
    }
  }

  it("rejects an empty or invalid pasted key and leaves an existing env file untouched", async () => {
    await writeFile(envPath, "KEEP=1\n", "utf8");
    answers.push("n", "not-a-key");
    await expect(runSetupWizard(envPath)).resolves.toMatchObject({ success: false });
    expect(await readFile(envPath, "utf8")).toBe("KEEP=1\n");
    expect(deviceLogin).not.toHaveBeenCalled();
  });

  it("stops when browser login fails and does not write a new env file", async () => {
    deviceLogin.mockResolvedValue({ success: false, envPath });
    answers.push("");
    await expect(runSetupWizard(envPath)).resolves.toMatchObject({ success: false });
    expect(await fileExists()).toBe(false);
  });

  it("stops when MCP is unreachable and the operator declines to continue", async () => {
    await writeFile(envPath, "KEEP=1\n", "utf8");
    fetchMock.mockRejectedValue(new Error("offline"));
    answers.push("n", "imk_valid", "", "n");
    await expect(runSetupWizard(envPath)).resolves.toMatchObject({ success: false });
    expect(await readFile(envPath, "utf8")).toBe("KEEP=1\n");
  });

  it("writes a production config when the operator skips browser login and extra runners", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    answers.push("n", "imk_valid", "y", dir, "n");
    const result = await runSetupWizard(envPath);
    expect(result.success).toBe(true);
    const written = await readFile(envPath, "utf8");
    expect(written).toContain("IMEMORY_API_KEY=imk_valid");
    expect(written).toContain("IMEMORY_MCP_URL=https://projectm.dev/api/mcp");
    expect(written).toContain(`IMEMORY_WORKSPACE_ALLOWLIST=${dir}`);
  });
});
