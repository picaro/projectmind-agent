import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEASE_RENEW_MS } from "./lease-keepalive.js";
import { resetProviderPacing } from "./provider-pacing.js";
import { resetRunnerOverride } from "./runners/resolve.js";

const callToolJson = vi.hoisted(() => vi.fn());
const prepareWorkspace = vi.hoisted(() => vi.fn());
const assertPathInsideManagedRoot = vi.hoisted(() => vi.fn());
const restoreWorkspaceDefaultBranch = vi.hoisted(() => vi.fn());
const setActiveGitCredentials = vi.hoisted(() => vi.fn());
const commitAndPushAfterTask = vi.hoisted(() => vi.fn());
const ensurePullRequest = vi.hoisted(() => vi.fn());
const startChildJobWatch = vi.hoisted(() => vi.fn());
const runnerControl = vi.hoisted(() => ({
  attempts: ["cursor_cli"] as string[],
  calls: [] as string[],
  mcp: [] as unknown[],
  impl: async (_name: string, _input: { signal: AbortSignal; mcp?: unknown }) =>
    ({
      status: "succeeded" as const,
      summary: "did the work",
      model: "composer",
    }),
}));
const claudeState = vi.hoisted(() => ({
  close: false,
  snapshot: null as { note: string; sessionPercent: number; weekPercent: number } | null,
}));

vi.mock("./mcp-client.js", () => ({
  callToolJson: (...args: unknown[]) => callToolJson(...args),
}));

vi.mock("./workspace-manager.js", () => ({
  prepareWorkspace: (...args: unknown[]) => prepareWorkspace(...args),
}));

vi.mock("./managed-workspace.js", async () => {
  const actual = await vi.importActual<typeof import("./managed-workspace.js")>(
    "./managed-workspace.js",
  );
  return {
    ...actual,
    assertPathInsideManagedRoot: (...args: unknown[]) => assertPathInsideManagedRoot(...args),
    restoreWorkspaceDefaultBranch: (...args: unknown[]) => restoreWorkspaceDefaultBranch(...args),
  };
});

vi.mock("./task-worktree.js", () => ({
  TASK_WORKSPACE_DIR_NAME: ".pm-task-workspaces",
  isDisposableTaskWorkspacePath: () => false,
  shouldEnsureTaskWorktree: () => false,
  ensureTaskWorktree: vi.fn(),
  pruneStaleTaskWorktrees: vi.fn(async () => ({ removed: [] })),
  formatTaskWorktreePruneLog: () => null,
  removeTaskWorktree: vi.fn(async () => ({ ok: true, removed: false })),
}));

vi.mock("./visual-capture.js", () => ({
  readGitMeta: async () => ({ commit: null, branch: null }),
  listChangedFilesFromHead: async () => [],
  listChangedFilesBetween: async () => [],
  captureAndSaveVisualState: async () => ({ attempted: false, detail: "" }),
}));

vi.mock("./git-publish.js", () => ({
  setActiveGitCredentials: (...args: unknown[]) => setActiveGitCredentials(...args),
  commitAndPushAfterTask: (...args: unknown[]) => commitAndPushAfterTask(...args),
  ensurePullRequest: (...args: unknown[]) => ensurePullRequest(...args),
  shortCommitMessage: (summary: string) => summary.slice(0, 72),
}));

vi.mock("./llm-stats.js", () => ({
  recordLlmUsage: async () => ({ byLlm: {}, updatedAt: new Date(0).toISOString() }),
}));

vi.mock("./child-job-watch.js", () => ({
  startChildJobWatch: (...args: unknown[]) => startChildJobWatch(...args),
}));

vi.mock("./claude-usage.js", () => ({
  getClaudeUsageSnapshot: async () => claudeState.snapshot,
  isClaudeUsageClose: () => claudeState.close,
}));

vi.mock("./runners/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("./runners/resolve.js")>("./runners/resolve.js");
  return {
    ...actual,
    resolveRunnerAttempts: async () => runnerControl.attempts,
    resolveAutoRunnerChainWithDiagnostics: async () => ({ chain: [], diagnostics: [] }),
    createRunnerByName: (name: string) => ({
      name,
      run: async (input: { signal: AbortSignal; mcp?: unknown }) => {
        runnerControl.calls.push(name);
        runnerControl.mcp.push(input.mcp ?? null);
        return runnerControl.impl(name, input);
      },
    }),
  };
});

import { executeClaimedJob, hasAnyAvailableRunner, type ClaimedJob } from "./jobs.js";

function toolCalls(name: string): Array<Record<string, unknown>> {
  return callToolJson.mock.calls
    .filter((call) => call[1] === name)
    .map((call) => call[2] as Record<string, unknown>);
}

describe("executeClaimedJob", () => {
  let tmp: string;
  const envAllowlist = process.env.IMEMORY_WORKSPACE_ALLOWLIST;
  const envMinGap = process.env.IMEMORY_PROVIDER_MIN_GAP_MS;
  const envJitter = process.env.IMEMORY_PROVIDER_GAP_JITTER_MS;
  const envClaudeCooldown = process.env.IMEMORY_CLAUDE_USAGE_COOLDOWN_MS;
  let jobPhase: string | null = "implement";
  let renewError: string | null = null;
  const childStop = vi.fn(async () => {});

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pm-job-exec-"));
    process.env.IMEMORY_WORKSPACE_ALLOWLIST = tmp;
    process.env.IMEMORY_PROVIDER_MIN_GAP_MS = "0";
    process.env.IMEMORY_PROVIDER_GAP_JITTER_MS = "0";
    process.env.IMEMORY_CLAUDE_USAGE_COOLDOWN_MS = "1";
    jobPhase = "implement";
    renewError = null;
    runnerControl.attempts = ["cursor_cli"];
    runnerControl.calls = [];
    runnerControl.mcp = [];
    runnerControl.impl = async () => ({
      status: "succeeded",
      summary: "did the work",
      model: "composer",
    });
    claudeState.close = false;
    claudeState.snapshot = null;
    callToolJson.mockReset();
    callToolJson.mockImplementation(async (_client: unknown, name: string) => {
      if (name === "getAgentJob") return { job: { status: "running", phase: jobPhase } };
      if (name === "renewAgentJobLease") {
        if (renewError) throw new Error(renewError);
        return {};
      }
      if (name === "findProjectByLocalDirectory") return { projectId: "proj-1" };
      if (name === "releaseAgentJob") return {};
      return {};
    });
    prepareWorkspace.mockReset();
    prepareWorkspace.mockResolvedValue({
      ok: true,
      path: tmp,
      created: false,
      headSha: null,
      action: "refreshed",
    });
    assertPathInsideManagedRoot.mockReset();
    assertPathInsideManagedRoot.mockReturnValue({ ok: false, reason: "outside" });
    restoreWorkspaceDefaultBranch.mockReset();
    restoreWorkspaceDefaultBranch.mockResolvedValue({ ok: true, restored: false, detail: "clean" });
    setActiveGitCredentials.mockReset();
    commitAndPushAfterTask.mockReset();
    commitAndPushAfterTask.mockResolvedValue({
      ok: true,
      attempted: false,
      detail: "nothing to commit",
    });
    ensurePullRequest.mockReset();
    startChildJobWatch.mockReset();
    childStop.mockReset();
    startChildJobWatch.mockReturnValue({ stop: childStop });
    resetProviderPacing();
    resetRunnerOverride();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetProviderPacing();
    resetRunnerOverride();
    if (envAllowlist === undefined) delete process.env.IMEMORY_WORKSPACE_ALLOWLIST;
    else process.env.IMEMORY_WORKSPACE_ALLOWLIST = envAllowlist;
    if (envMinGap === undefined) delete process.env.IMEMORY_PROVIDER_MIN_GAP_MS;
    else process.env.IMEMORY_PROVIDER_MIN_GAP_MS = envMinGap;
    if (envJitter === undefined) delete process.env.IMEMORY_PROVIDER_GAP_JITTER_MS;
    else process.env.IMEMORY_PROVIDER_GAP_JITTER_MS = envJitter;
    if (envClaudeCooldown === undefined) delete process.env.IMEMORY_CLAUDE_USAGE_COOLDOWN_MS;
    else process.env.IMEMORY_CLAUDE_USAGE_COOLDOWN_MS = envClaudeCooldown;
    rmSync(tmp, { recursive: true, force: true });
  });

  function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
    return {
      id: "job-12345678",
      project_id: "proj-1",
      task_id: "task-1",
      target_agent_key: "host:test",
      status: "leased",
      runner: "cursor_cli",
      local_directory: tmp,
      prompt: "implement the assigned task",
      phase: "implement",
      model: "composer",
      ...overrides,
    };
  }

  it("completes a successful run and clears git credentials", async () => {
    await executeClaimedJob(
      {} as never,
      job(),
      "agent-1",
      null,
      null,
      null,
      { username: "git", token: "tok", expiresAt: "", scope: "repo" },
    );
    expect(runnerControl.calls).toEqual(["cursor_cli"]);
    expect(toolCalls("completeAgentJob")).toEqual([
      expect.objectContaining({ status: "succeeded", updateTask: true }),
    ]);
    expect(prepareWorkspace.mock.calls[0]?.[0]).toMatchObject({ containment: "allowlisted" });
    const creds = setActiveGitCredentials.mock.calls.map((call) => call[0]);
    expect(creds[0]).toEqual({ username: "git", token: "tok" });
    expect(creds.at(-1)).toBeNull();
  });

  it("fails the job when workspace preparation fails and still clears credentials", async () => {
    prepareWorkspace.mockResolvedValue({ ok: false, reason: "clone failed" });
    await executeClaimedJob(
      {} as never,
      job(),
      "agent-1",
      null,
      null,
      null,
      { username: "git", token: "tok", expiresAt: "", scope: "repo" },
    );
    expect(runnerControl.calls).toEqual([]);
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({
      status: "failed",
      error: "clone failed",
      updateTask: false,
    });
    expect(setActiveGitCredentials.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("fails before preparation when the cwd is a task leaf without claim prep", async () => {
    await executeClaimedJob(
      {} as never,
      job({ local_directory: `${tmp}/.pm-task-workspaces/leaf` }),
      "agent-1",
    );
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(runnerControl.calls).toEqual([]);
    expect(String(toolCalls("completeAgentJob")[0]?.error)).toMatch(/taskWorkspace/);
  });

  it("fails when the workspace is registered to another project", async () => {
    callToolJson.mockImplementation(async (_client: unknown, name: string) => {
      if (name === "getAgentJob") return { job: { status: "running", phase: "implement" } };
      if (name === "findProjectByLocalDirectory") {
        return { projectId: "proj-other", name: "Other", slug: "other" };
      }
      return {};
    });
    await executeClaimedJob({} as never, job(), "agent-1");
    expect(runnerControl.calls).toEqual([]);
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({ status: "failed", updateTask: false });
    expect(String(toolCalls("completeAgentJob")[0]?.error)).toMatch(/Other \(other\)/);
  });

  it("continues when the project lookup only returns a warning", async () => {
    callToolJson.mockImplementation(async (_client: unknown, name: string) => {
      if (name === "getAgentJob") return { job: { status: "running", phase: "implement" } };
      if (name === "findProjectByLocalDirectory") throw new Error("network down");
      return {};
    });
    await executeClaimedJob({} as never, job(), "agent-1");
    expect(runnerControl.calls).toEqual(["cursor_cli"]);
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({ status: "succeeded" });
  });

  it("rejects a workspace outside the allowlist before invoking a runner", async () => {
    await executeClaimedJob(
      {} as never,
      job({ local_directory: join(tmp, "missing-child") }),
      "agent-1",
    );
    expect(runnerControl.calls).toEqual([]);
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({ status: "failed" });
  });

  it("releases the job when every runner is paced out", async () => {
    runnerControl.attempts = [];
    await executeClaimedJob({} as never, job(), "agent-1");
    expect(toolCalls("releaseAgentJob")).toHaveLength(1);
    expect(toolCalls("completeAgentJob")).toHaveLength(0);
    expect(runnerControl.calls).toEqual([]);
  });

  it("aborts on the first fatal lease renewal and does not run", async () => {
    renewError = "Not the lease owner";
    await executeClaimedJob(
      {} as never,
      job(),
      "agent-1",
      null,
      null,
      null,
      { username: "git", token: "tok", expiresAt: "", scope: "repo" },
    );
    expect(runnerControl.calls).toEqual([]);
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({
      status: "failed",
      updateTask: false,
    });
    expect(String(toolCalls("completeAgentJob")[0]?.error)).toMatch(/lease owner/i);
    expect(setActiveGitCredentials.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("aborts after a second non-fatal lease failure while the runner is in flight", async () => {
    vi.useFakeTimers();
    const errors = ["temporary blip", "temporary blip"];
    renewError = null;
    callToolJson.mockImplementation(async (_client: unknown, name: string) => {
      if (name === "getAgentJob") return { job: { status: "running", phase: "implement" } };
      if (name === "renewAgentJobLease") {
        const next = errors.shift();
        if (next) throw new Error(next);
        return {};
      }
      if (name === "findProjectByLocalDirectory") return { projectId: "proj-1" };
      return {};
    });
    let started = false;
    runnerControl.impl = async (_name, input) => {
      started = true;
      return await new Promise((resolve) => {
        if (input.signal.aborted) {
          resolve({ status: "cancelled", summary: "Cancelled" });
          return;
        }
        input.signal.addEventListener("abort", () => {
          resolve({ status: "cancelled", summary: "Cancelled" });
        });
      });
    };

    const pending = executeClaimedJob({} as never, job(), "agent-1");
    for (let i = 0; i < 400 && !started; i += 1) await Promise.resolve();
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
    await pending;
    const completes = toolCalls("completeAgentJob");
    expect(completes.some((call) => call.status === "failed" && /temporary blip/.test(String(call.error)))).toBe(
      true,
    );
  });

  it("returns early when the job is already cancelled at the first renew", async () => {
    callToolJson.mockImplementation(async (_client: unknown, name: string) => {
      if (name === "getAgentJob") return { job: { status: "cancelled", phase: "implement" } };
      return {};
    });
    await executeClaimedJob({} as never, job(), "agent-1");
    expect(runnerControl.calls).toEqual([]);
    expect(toolCalls("completeAgentJob")).toHaveLength(0);
  });

  it("skips Claude when usage is close and another runner remains", async () => {
    runnerControl.attempts = ["claude_cli", "codex_cli"];
    claudeState.close = true;
    claudeState.snapshot = { note: "Session: 95%", sessionPercent: 95, weekPercent: 10 };
    await executeClaimedJob({} as never, job({ runner: "auto" }), "agent-1");
    expect(runnerControl.calls).toEqual(["codex_cli"]);
  });

  it("runs Claude anyway when it is the last attempt and usage is close", async () => {
    runnerControl.attempts = ["claude_cli"];
    claudeState.close = true;
    claudeState.snapshot = { note: "Session: 95%", sessionPercent: 95, weekPercent: 10 };
    await executeClaimedJob({} as never, job({ runner: "claude_cli" }), "agent-1");
    expect(runnerControl.calls).toEqual(["claude_cli"]);
  });

  it("fails over a retryable runner error and stops on a non-retryable one", async () => {
    runnerControl.attempts = ["cursor_cli", "codex_cli"];
    runnerControl.impl = async (name) => {
      if (name === "cursor_cli") {
        return { status: "failed", summary: "", error: "command not found" };
      }
      return { status: "succeeded", summary: "recovered", model: "codex" };
    };
    await executeClaimedJob({} as never, job(), "agent-1");
    expect(runnerControl.calls).toEqual(["cursor_cli", "codex_cli"]);
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({ status: "succeeded" });

    runnerControl.calls = [];
    runnerControl.impl = async () => ({
      status: "failed",
      summary: "",
      error: "the patch does not compile",
    });
    await executeClaimedJob({} as never, job(), "agent-1");
    expect(runnerControl.calls).toEqual(["cursor_cli"]);
    expect(toolCalls("completeAgentJob").at(-1)).toMatchObject({ status: "failed" });
  });

  it("fails a plan-phase run that does not return a plan or questions", async () => {
    runnerControl.impl = async () => ({ status: "succeeded", summary: "too short", model: "m" });
    await executeClaimedJob({} as never, job({ phase: "plan" }), "agent-1");
    expect(toolCalls("awaitAgentJobUserInput")).toHaveLength(0);
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({
      status: "failed",
      error: "Plan phase did not return a plan or questions payload",
    });
  });

  it("waits for answers when the live job phase is plan", async () => {
    jobPhase = "plan";
    runnerControl.impl = async () => ({
      status: "succeeded",
      summary: JSON.stringify({
        type: "questions",
        questions: [{ prompt: "Which API?" }],
      }),
      model: "m",
    });
    await executeClaimedJob({} as never, job({ phase: null }), "agent-1");
    expect(toolCalls("completeAgentJob")).toHaveLength(0);
    expect(toolCalls("awaitAgentJobUserInput")[0]).toMatchObject({
      interaction: { type: "questions" },
    });
  });

  it("keeps a git publish failure in the summary and still completes successfully", async () => {
    commitAndPushAfterTask.mockResolvedValue({
      ok: false,
      attempted: true,
      detail: "push rejected",
    });
    await executeClaimedJob({} as never, job(), "agent-1");
    expect(toolCalls("completeAgentJob")[0]).toMatchObject({ status: "succeeded" });
    expect(String(toolCalls("completeAgentJob")[0]?.resultSummary)).toContain("push rejected");
  });

  it("records a thrown pull-request failure on an improvement contract", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    ensurePullRequest.mockRejectedValue(new Error("gh missing"));
    const contract = {
      schemaVersion: "1.0",
      jobId: "job-12345678",
      executionRunId: "run-1",
      projectId: "proj-1",
      projectSlug: "alpha",
      planId: "plan-1",
      propositionId: "prop-1",
      localDirectory: tmp,
      branchName: "improve/alpha",
      baseBranch: "main",
      createPullRequest: true,
      mergePullRequest: false,
      deployProduction: false,
      prompt: "fix it",
      acceptanceCriteria: ["tests pass"],
      protectedPaths: [],
      allowDatabaseMigrations: false,
      requiredCommands: [],
      callback: {
        baseUrl: "https://projectm.dev",
        token: "tok",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      timeoutMs: 60_000,
    };
    await executeClaimedJob(
      {} as never,
      job({ prompt: "```json\n" + JSON.stringify(contract) + "\n```" }),
      "agent-1",
    );
    expect(String(toolCalls("completeAgentJob")[0]?.resultSummary)).toContain("gh missing");
    expect(fetchMock).toHaveBeenCalled();
    expect(setActiveGitCredentials.mock.calls.at(-1)?.[0]).toBeNull();
    vi.unstubAllGlobals();
  });

  it("starts child-job watch without handing MCP to the runner when no grant is present", async () => {
    await executeClaimedJob({} as never, job(), "agent-1", null, null, null, null, null, {
      delegation: { allowed: true },
    });
    expect(startChildJobWatch).toHaveBeenCalledWith(
      expect.objectContaining({ parentJobId: "job-12345678" }),
    );
    expect(runnerControl.mcp).toEqual([null]);
    expect(childStop).toHaveBeenCalled();
  });

  it("forces managed containment when the path is inside the managed root", async () => {
    assertPathInsideManagedRoot.mockReturnValue({ ok: true, path: tmp });
    await executeClaimedJob({} as never, job(), "agent-1", null, null, {
      localPath: tmp,
      status: "available",
      projectSlug: "alpha",
      containment: "allowlisted",
      mode: "clone",
    });
    expect(prepareWorkspace.mock.calls[0]?.[0]).toMatchObject({ containment: "managed" });
    expect(toolCalls("reportManagedWorkspaceReady")[0]).toMatchObject({ status: "available" });
  });

  it("reports no available runner when the attempt list is empty", async () => {
    runnerControl.attempts = [];
    await expect(hasAnyAvailableRunner()).resolves.toBe(false);
    runnerControl.attempts = ["cursor_cli"];
    await expect(hasAnyAvailableRunner()).resolves.toBe(true);
  });
});
