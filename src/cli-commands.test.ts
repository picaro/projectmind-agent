import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({
  chain: [] as string[],
  rows: [] as Array<{ runner: string; available: boolean; reason: string }>,
}));

const healthResults = vi.hoisted(() => ({
  rows: [] as Array<{ runner: string; ok: boolean; durationMs: number; error?: string; model?: string }>,
}));

vi.mock("./runners/resolve.js", () => ({
  resolveAutoRunnerChainWithDiagnostics: async () => ({
    chain: diagnostics.chain,
    diagnostics: diagnostics.rows,
  }),
  formatRunnerDiagnostics: () => "",
  commandExists: async () => false,
  cursorApiKey: () => "",
  codexApiKey: () => "",
  claudeApiKey: () => "",
  copilotApiKey: () => "",
  cursorCliBin: () => "cursor-agent",
  codexCliBin: () => "codex",
  antigravityCliBin: () => "agy",
  claudeCliBin: () => "claude",
  copilotCliBin: () => "copilot",
}));

vi.mock("./health-check.js", () => ({
  runHealthCheck: async () => healthResults.rows,
}));

import { parseCliCommand, runDoctorCommand, runTestCommand, showVersion } from "./cli-commands.js";

describe("parseCliCommand", () => {
  it("treats an empty argv as the long-running agent", () => {
    expect(parseCliCommand([])).toEqual({ command: null, args: [] });
  });

  it("folds command case and keeps the remaining args", () => {
    expect(parseCliCommand(["Doctor"])).toEqual({ command: "doctor", args: [] });
    expect(parseCliCommand(["exec-job", "--jobId", "abc"])).toEqual({
      command: "exec-job",
      args: ["--jobId", "abc"],
    });
  });

  it("returns null for an unknown command and preserves the original args", () => {
    expect(parseCliCommand(["start", "--verbose"])).toEqual({
      command: null,
      args: ["start", "--verbose"],
    });
  });
});

describe("showVersion", () => {
  it("prints the build date only when one was embedded", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    showVersion("1.2.3", null);
    expect(log.mock.calls.map((call) => call[0]).join("\n")).not.toContain("Build date");
    log.mockClear();
    showVersion("1.2.3", "2026-10-01T00:00:00.000Z");
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Build date: 2026-10-01T00:00:00.000Z",
    );
    log.mockRestore();
  });
});

describe("runDoctorCommand", () => {
  let dir: string;
  const fetchMock = vi.fn();
  const originalAllowlist = process.env.IMEMORY_WORKSPACE_ALLOWLIST;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pm-doctor-"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    diagnostics.chain = ["cursor_cli"];
    diagnostics.rows = [
      { runner: "cursor_cli", available: true, reason: "found" },
      { runner: "codex_cli", available: false, reason: "missing" },
    ];
    delete process.env.IMEMORY_WORKSPACE_ALLOWLIST;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalAllowlist === undefined) delete process.env.IMEMORY_WORKSPACE_ALLOWLIST;
    else process.env.IMEMORY_WORKSPACE_ALLOWLIST = originalAllowlist;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns 1 when the env file is missing and skips the MCP probe", async () => {
    const code = await runDoctorCommand(join(dir, "missing.env"));
    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 0 when the only problems are warnings", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "IMEMORY_API_KEY=imk_test\n", "utf8");
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const code = await runDoctorCommand(envPath);
    expect(code).toBe(0);
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("IMEMORY_MCP_URL not set");
    expect(logged).toContain("1 runner(s) available");
  });

  it("returns 0 when configuration, MCP, allowlist, and a runner all check out", async () => {
    const envPath = join(dir, ".env");
    const workspace = dir;
    process.env.IMEMORY_WORKSPACE_ALLOWLIST = workspace;
    await writeFile(
      envPath,
      `IMEMORY_API_KEY=imk_test\nIMEMORY_MCP_URL=https://projectm.dev/api/mcp\nIMEMORY_WORKSPACE_ALLOWLIST=${workspace}\n`,
      "utf8",
    );
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    const code = await runDoctorCommand(envPath);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("warns on a missing allowlist path and a non-400 MCP status without failing", async () => {
    const envPath = join(dir, ".env");
    const missing = join(dir, "does-not-exist");
    process.env.IMEMORY_WORKSPACE_ALLOWLIST = `${dir}, ${missing}`;
    await writeFile(
      envPath,
      `IMEMORY_API_KEY=imk_test\nIMEMORY_MCP_URL=https://projectm.dev/api/mcp\nIMEMORY_WORKSPACE_ALLOWLIST=${dir}, ${missing}\n`,
      "utf8",
    );
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const code = await runDoctorCommand(envPath);
    expect(code).toBe(0);
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("does not exist");
    expect(logged).toContain("status 500");
  });

  it("returns 1 when the MCP endpoint cannot be reached", async () => {
    const envPath = join(dir, ".env");
    process.env.IMEMORY_WORKSPACE_ALLOWLIST = dir;
    await writeFile(
      envPath,
      `IMEMORY_API_KEY=imk_test\nIMEMORY_MCP_URL=https://projectm.dev/api/mcp\nIMEMORY_WORKSPACE_ALLOWLIST=${dir}\n`,
      "utf8",
    );
    fetchMock.mockRejectedValue(new Error("offline"));
    const code = await runDoctorCommand(envPath);
    expect(code).toBe(1);
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("Cannot connect to MCP endpoint");
  });

  it("returns 1 when no runner is available", async () => {
    const envPath = join(dir, ".env");
    process.env.IMEMORY_WORKSPACE_ALLOWLIST = dir;
    await writeFile(
      envPath,
      `IMEMORY_API_KEY=imk_test\nIMEMORY_MCP_URL=https://projectm.dev/api/mcp\nIMEMORY_WORKSPACE_ALLOWLIST=${dir}\n`,
      "utf8",
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    diagnostics.chain = [];
    diagnostics.rows = [
      { runner: "cursor_sdk", available: false, reason: "no key" },
      { runner: "copilot_cli", available: false, reason: "missing" },
    ];
    const code = await runDoctorCommand(envPath);
    expect(code).toBe(1);
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("No runners are available");
    expect(logged).toContain("copilot");
  });

  it("rejects an API key that does not use a ProjectMind prefix", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "IMEMORY_API_KEY=sk-not-ours\n", "utf8");
    const code = await runDoctorCommand(envPath);
    expect(code).toBe(1);
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("missing or invalid");
  });
});

describe("runTestCommand", () => {
  beforeEach(() => {
    healthResults.rows = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 1 when nothing is configured and when every runner fails", async () => {
    expect(await runTestCommand()).toBe(1);
    healthResults.rows = [{ runner: "cursor_cli", ok: false, durationMs: 10, error: "nope" }];
    expect(await runTestCommand()).toBe(1);
  });

  it("returns 0 when at least one runner passes", async () => {
    healthResults.rows = [
      { runner: "cursor_cli", ok: true, durationMs: 1500, model: "composer" },
      { runner: "codex_cli", ok: false, durationMs: 20, error: "missing" },
    ];
    expect(await runTestCommand()).toBe(0);
  });
});
