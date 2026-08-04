import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  commitAndPushAfterTask,
  ensurePullRequest,
  setActiveGitCredentials,
  shortCommitMessage,
} from "./git-publish.js";
import { getClaudeUsageSnapshot, isClaudeUsageClose } from "./claude-usage.js";
import {
  extractMacAgentJobContractFromPrompt,
  enforceContractSafety,
  postImprovementCallback,
  type MacAgentJobContractV1,
} from "./improvement-job.js";
import { recordLlmUsage } from "./llm-stats.js";
import { callToolJson } from "./mcp-client.js";
import {
  awaitBeforeInvoke,
  formatPacingLog,
  formatSkippedLog,
  planAttempts,
  recordInvoke,
  recordRateLimit,
  syncGlobalCooldowns,
  type ProviderName,
} from "./provider-pacing.js";
import { assertSafeWorkspace, effectiveAllowlist } from "./safety.js";
import {
  prepareWorkspace,
  type WorkspaceContainment,
  type WorkspaceMode,
} from "./workspace-manager.js";
import { ensureTaskWorktree } from "./task-worktree.js";
import { prepareEnvironment } from "./environment-manager.js";
import { errorCodeForPhase, reportPhase, type ExecutionLifecyclePhase } from "./execution-phase.js";
import {
  createRunnerByName,
  handleRunnerResult,
  isRetryableRunnerFailure,
  resolveRunnerAttempts,
  resolveAutoRunnerChainWithDiagnostics,
  formatRunnerDiagnostics,
} from "./runners/resolve.js";
import type { ExecutionModelGateway } from "./runners/gateway.js";
import type { RunnerName, RunnerResult } from "./runners/types.js";
import { extractInteractionFromText } from "./plan-interaction.js";
import {
  captureAndSaveVisualState,
  listChangedFilesBetween,
  listChangedFilesFromHead,
  readGitMeta,
} from "./visual-capture.js";

export type ClaimedJob = {
  id: string;
  project_id: string;
  task_id: string;
  target_agent_key: string;
  status: string;
  runner: RunnerName | string;
  local_directory: string;
  prompt: string | null;
  phase?: "plan" | "implement" | string | null;
  /** Model override for this job (job-level, then agent-level default). Null = runner default. */
  model?: string | null;
  /** When true, mac-agent execution strictly requires the assigned runner without fallback. */
  hard_rule?: boolean;
};

export type ClaimedJobPayload = {
  job: ClaimedJob | null;
  taskWorkspace?: {
    id: string;
    localPath: string;
    baseLocalPath: string;
    branchName: string;
    baseBranch: string;
    status: string;
  } | null;
  /** Repo identity for the project, when it has one. */
  repository?: {
    id: string;
    url: string;
    cloneUrl: string | null;
    owner: string | null;
    name: string | null;
    defaultBranch: string | null;
    provider: string | null;
    private: boolean | null;
  } | null;
  /** Present only when this workspace is agent-owned (managed). */
  managedWorkspace?: {
    localPath: string;
    status: string;
    projectSlug: string | null;
    /** Absent on older control planes, which only ever meant "clone". */
    mode?: "clone" | "empty" | "archive" | null;
    /**
     * Which boundary this path must satisfy. "managed" = under the root this
     * agent advertises; "allowlisted" = a directory a person chose, usable only
     * inside IMEMORY_WORKSPACE_ALLOWLIST. Absent on older control planes, which
     * only ever sent managed paths.
     */
    containment?: "managed" | "allowlisted" | null;
    /**
     * Short-lived signed URL for `archive` mode. Like gitCredentials it appears
     * only in the claim response, never in the persisted contract or prompt.
     */
    archiveDownloadUrl?: string | null;
  } | null;
  /**
   * Short-lived git credential. Present only in the claim response — never in
   * the job contract or prompt, which are persisted and rendered in the UI.
   */
  gitCredentials?: {
    username: string;
    token: string;
    expiresAt: string;
    scope: string;
  } | null;
  /**
   * Execution-scoped LLM gateway grant. Like gitCredentials it exists only in
   * the claim response — never in the persisted contract or prompt. The `policy`
   * it carries is advisory; the server re-enforces every limit per call.
   */
  modelGateway?: ExecutionModelGateway | null;
  cooldowns?: Array<{ runner: string; cooldown_until: string | null }>;
};

const LEASE_RENEW_MS = 60_000;
const CONSOLE_LOG_CHARS = 4_000;
const DEFAULT_CLAUDE_USAGE_LIMIT_PERCENT = 90;
const DEFAULT_CLAUDE_USAGE_COOLDOWN_MS = 30 * 60_000;

function jobTag(jobId: string): string {
  return `[job ${jobId.slice(0, 8)}]`;
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Fail when cwd is registered to a different ProjectMind project. */
export async function assertCwdMatchesJobProject(
  client: Client,
  job: Pick<ClaimedJob, "project_id" | "local_directory">,
): Promise<{ ok: true; warning?: string } | { ok: false; reason: string }> {
  try {
    const payload = await callToolJson<{
      projectId?: string;
      slug?: string;
      name?: string;
      error?: string;
    }>(client, "findProjectByLocalDirectory", {
      localDirectory: job.local_directory,
    });

    const foundId = payload.projectId?.trim();
    if (!foundId) return { ok: true };
    if (foundId === job.project_id) return { ok: true };

    const label = payload.name
      ? `${payload.name}${payload.slug ? ` (${payload.slug})` : ""}`
      : foundId;
    return {
      ok: false,
      reason:
        `Workspace ${job.local_directory} is linked to project ${label}, ` +
        `but this job belongs to project ${job.project_id}. ` +
        `Configure a runtime project path for this project (or pass an explicit path override).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No repo claims this path in the API key's search scope — allow.
    if (/project not found/i.test(message)) return { ok: true };
    return {
      ok: true,
      warning: `Could not verify workspace project (continuing): ${message}`,
    };
  }
}

export async function claimNextJob(
  client: Client,
  agentKey: string,
): Promise<{
  job: ClaimedJob;
  taskWorkspace: ClaimedJobPayload["taskWorkspace"];
  repository: ClaimedJobPayload["repository"];
  managedWorkspace: ClaimedJobPayload["managedWorkspace"];
  gitCredentials: ClaimedJobPayload["gitCredentials"];
  modelGateway: ClaimedJobPayload["modelGateway"];
  cooldowns?: ClaimedJobPayload["cooldowns"];
} | null> {
  const payload = await callToolJson<ClaimedJobPayload>(client, "claimNextAgentJob", {
    agentKey,
  });
  // Always sync cooldowns from the server, even when no job is returned.
  // This lets the polling loop know which runners are in cooldown before claiming.
  if (payload.cooldowns) {
    syncGlobalCooldowns(payload.cooldowns);
  }
  if (!payload.job) return null;
  return {
    job: payload.job,
    taskWorkspace: payload.taskWorkspace ?? null,
    repository: payload.repository ?? null,
    managedWorkspace: payload.managedWorkspace ?? null,
    gitCredentials: payload.gitCredentials ?? null,
    modelGateway: payload.modelGateway ?? null,
    cooldowns: payload.cooldowns,
  };
}

/**
 * Check whether at least one runner from the auto cascade is currently available
 * (not in cooldown and not disabled) based on the locally-synced pacing state.
 * Call this BEFORE claimNextJob to avoid wasting a claim on a job we can't run.
 */
export async function hasAnyAvailableRunner(): Promise<boolean> {
  const rawAttempts = await resolveRunnerAttempts("auto");
  const { available } = planAttempts(rawAttempts as ProviderName[], { rotate: false });
  return available.length > 0;
}

/**
 * Release a claimed job back to the queue via the MCP releaseAgentJob tool.
 * Used when the mac-agent claims a job but discovers all runners are in cooldown.
 */
export async function releaseJobToQueue(
  client: Client,
  jobId: string,
  agentKey: string,
): Promise<void> {
  try {
    await callToolJson(client, "releaseAgentJob", { jobId, agentKey });
  } catch (err) {
    // If the release tool doesn't exist (older server), fail the job instead.
    console.error(
      `[job ${jobId.slice(0, 8)}] Release failed (falling back to fail): ${err instanceof Error ? err.message : err}`,
    );
    await callToolJson(client, "completeAgentJob", {
      jobId,
      agentKey,
      status: "failed",
      error: "No runner available — all models in cooldown",
      updateTask: false,
    });
  }
}

export async function getJobStatus(client: Client, jobId: string): Promise<string | null> {
  try {
    const payload = await callToolJson<{ job: { status: string } }>(client, "getAgentJob", {
      jobId,
    });
    return payload.job?.status ?? null;
  } catch {
    return null;
  }
}

async function appendLog(
  client: Client,
  jobId: string,
  agentKey: string,
  message: string,
  kind: "log" | "error" | "status" = "log",
  extras?: { markRunning?: boolean; externalRunId?: string; realLlm?: string | null },
): Promise<void> {
  await callToolJson(client, "appendAgentJobEvent", {
    jobId,
    message: message.slice(0, 7500),
    kind,
    agentKey,
    ...(extras?.markRunning ? { markRunning: true } : {}),
    ...(extras?.externalRunId ? { externalRunId: extras.externalRunId } : {}),
    ...(extras?.realLlm ? { realLlm: extras.realLlm } : {}),
  });
}

function realLlmFromResult(runner: string | null, model?: string | null): string | undefined {
  if (!runner || runner === "auto") return undefined;
  const m = model?.trim();
  return m ? `${runner}/${m}` : runner;
}

/** Reports duration/tokens/cost for a finished run so ProjectMind can show task-level stats. */
async function appendRunStats(
  client: Client,
  jobId: string,
  agentKey: string,
  runner: string | null,
  result: RunnerResult,
  elapsedMs: number,
): Promise<void> {
  await callToolJson(client, "appendAgentJobEvent", {
    jobId,
    agentKey,
    message: "Run statistics",
    kind: "status",
    stats: {
      model: result.model,
      runner: runner ?? undefined,
      durationMs: result.stats?.durationMs ?? elapsedMs,
      inputTokens: result.stats?.inputTokens,
      outputTokens: result.stats?.outputTokens,
      cacheReadTokens: result.stats?.cacheReadTokens,
      cacheCreationTokens: result.stats?.cacheCreationTokens,
      totalTokens: result.stats?.totalTokens,
      costUsd: result.stats?.costUsd,
    },
  });
}

function logLocal(jobId: string, message: string, level: "info" | "error" = "info"): void {
  const line = `${jobTag(jobId)} ${message.slice(0, CONSOLE_LOG_CHARS)}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export async function executeClaimedJob(
  client: Client,
  job: ClaimedJob & { cooldowns?: ClaimedJobPayload["cooldowns"] },
  agentKey: string,
  taskWorkspace?: ClaimedJobPayload["taskWorkspace"],
  repository?: ClaimedJobPayload["repository"],
  managedWorkspace?: ClaimedJobPayload["managedWorkspace"],
  gitCredentials?: ClaimedJobPayload["gitCredentials"],
  modelGateway?: ClaimedJobPayload["modelGateway"],
): Promise<void> {
  const startedAt = Date.now();
  logLocal(
    job.id,
    `Starting execute: runner=${job.runner || "auto"} model=${job.model || "default"} phase=${job.phase ?? "implement"} task=${job.task_id} cwd=${job.local_directory}`,
  );

  // Tracks which internal lifecycle phase this attempt is in, purely so an
  // unexpected failure anywhere below can be tagged with the right structured
  // error code (see errorCodeForPhase) without every throw site having to know
  // it. Reported to the control plane via reportPhase at each transition.
  let currentPhase: ExecutionLifecyclePhase = "claiming";
  const gotoPhase = async (phase: ExecutionLifecyclePhase): Promise<void> => {
    currentPhase = phase;
    await reportPhase(client, job.id, agentKey, phase);
  };

  // Make the minted credential available to git/gh for this job. Cleared in the
  // finally block so it never leaks into an unrelated job.
  setActiveGitCredentials(
    gitCredentials ? { username: gitCredentials.username, token: gitCredentials.token } : null,
  );

  // Lease keepalive must start before workspace prep: clone/install often exceeds
  // AGENT_JOB_LEASE_TTL_MS (2 min) and used to expire the claim with zero renewals.
  const abort = new AbortController();
  let renewCount = 0;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let cancelPoll: ReturnType<typeof setInterval> | null = null;
  const renewLease = async (): Promise<void> => {
    try {
      const status = await getJobStatus(client, job.id);
      if (status === "cancelled" || status === "paused") {
        logLocal(
          job.id,
          `${status === "paused" ? "Pause" : "Cancel"} detected during lease renew — aborting`,
        );
        abort.abort();
        return;
      }
      renewCount += 1;
      await callToolJson(client, "renewAgentJobLease", {
        jobId: job.id,
        agentKey,
      });
      logLocal(job.id, `Lease renewed (#${renewCount}), status=${status ?? "?"}`);
    } catch (err) {
      logLocal(
        job.id,
        `Lease renew failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  };
  const stopLeaseKeepalive = (): void => {
    if (renewTimer != null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    if (cancelPoll != null) {
      clearInterval(cancelPoll);
      cancelPoll = null;
    }
  };

  try {
    await renewLease();
    renewTimer = setInterval(() => {
      void renewLease();
    }, LEASE_RENEW_MS);
    cancelPoll = setInterval(() => {
      void (async () => {
        const status = await getJobStatus(client, job.id);
        if (status === "cancelled" || status === "paused") {
          logLocal(
            job.id,
            `${status === "paused" ? "Pause" : "Cancel"} detected on poll — aborting`,
          );
          abort.abort();
        }
      })();
    }, 5_000);

    /**
     * Installation tokens live one hour and jobs routinely run longer, with the
     * push and PR happening last — re-mint immediately before publishing rather
     * than discovering the expiry as an auth failure.
     */
    const refreshGitCredentials = async (): Promise<void> => {
      if (!gitCredentials) return;
      try {
        const refreshed = await callToolJson<{
          gitCredentials?: { username: string; token: string; expiresAt: string };
        }>(client, "refreshJobGitToken", { jobId: job.id, agentKey });
        if (refreshed.gitCredentials?.token) {
          setActiveGitCredentials({
            username: refreshed.gitCredentials.username,
            token: refreshed.gitCredentials.token,
          });
          logLocal(job.id, "Refreshed git credentials before publishing");
        }
      } catch (err) {
        // Keep the existing token — it may still be valid.
        logLocal(
          job.id,
          `Could not refresh git credentials: ${err instanceof Error ? err.message : String(err)}`,
          "info",
        );
      }
    };

    // Workspace preparation. Every job that needs source code goes through this
    // before anything runs: the agent guarantees its own local checkout, rather
    // than a workflow task somewhere having promised to clone it earlier. It is
    // idempotent, so the usual cost is a fetch and a no-op fast-forward.
    //
    // This must happen before the worktree step (which needs a git repo) and
    // before assertSafeWorkspace (which needs the directory to exist).
    const workspaceTarget = managedWorkspace?.localPath || job.local_directory;
    if (workspaceTarget) {
      await gotoPhase("preparing_workspace");

      const failWorkspace = async (reason: string) => {
        // Scoped to this job only. Nothing about the project or other agents is
        // marked broken, and the next job retries preparation from scratch.
        logLocal(job.id, `Workspace preparation failed: ${reason}`, "error");
        await appendLog(
          client,
          job.id,
          agentKey,
          `Workspace preparation failed: ${reason}`,
          "error",
        );
        await callToolJson(client, "completeAgentJob", {
          jobId: job.id,
          agentKey,
          status: "failed",
          error: reason,
          errorCode: errorCodeForPhase(currentPhase),
          updateTask: false,
        });
      };

      const onLog = (line: string) => {
        logLocal(job.id, line);
        void appendLog(client, job.id, agentKey, line, "log");
      };

      // Without a binding row the path came straight from the job, which is a
      // directory a person configured — so it gets the non-destructive treatment.
      // With a binding but no `containment` (an older control plane), the path is
      // agent-owned by definition: that is all such a server ever sent.
      const containment: WorkspaceContainment = !managedWorkspace?.localPath
        ? "allowlisted"
        : managedWorkspace.containment === "allowlisted"
          ? "allowlisted"
          : "managed";
      const mode: WorkspaceMode =
        managedWorkspace?.mode === "archive"
          ? "archive"
          : managedWorkspace?.mode === "empty"
            ? "empty"
            : "clone";

      const prepared = await prepareWorkspace({
        localPath: workspaceTarget,
        containment,
        mode,
        repository: repository
          ? { cloneUrl: repository.cloneUrl, defaultBranch: repository.defaultBranch }
          : null,
        credentials: gitCredentials
          ? { username: gitCredentials.username, token: gitCredentials.token }
          : null,
        archiveDownloadUrl: managedWorkspace?.archiveDownloadUrl ?? null,
        onLog,
      });

      // Report only for agent-allocated bindings — that row is what the control
      // plane tracks, and the agent is the only party with disk truth.
      if (managedWorkspace?.localPath) {
        await callToolJson(client, "reportManagedWorkspaceReady", {
          jobId: job.id,
          agentKey,
          localPath: prepared.ok ? prepared.path : managedWorkspace.localPath,
          status: prepared.ok ? "available" : "clone_failed",
          headSha: prepared.ok ? prepared.headSha : null,
          error: prepared.ok ? null : prepared.reason,
        }).catch(() => {
          // Best-effort; never mask the underlying preparation outcome.
        });
      }

      if (!prepared.ok) {
        await failWorkspace(prepared.reason);
        return;
      }

      logLocal(job.id, `Workspace ready at ${prepared.path} (${prepared.action})`);

      // Pin the revision this attempt runs against. The workspace is only ever
      // prepared once per attempt (here), so recording it now — and letting the
      // server-side COALESCE keep the first value — is what makes "the same
      // attempt does not silently switch to a newer commit" true in practice.
      await reportPhase(client, job.id, agentKey, "preparing_workspace", {
        repositoryUrl: repository?.cloneUrl ?? null,
        branch: repository?.defaultBranch ?? null,
        commitSha: prepared.headSha,
      });
    }

    if (
      taskWorkspace &&
      (taskWorkspace.status === "pending" || taskWorkspace.status === "leased")
    ) {
      const ensured = await ensureTaskWorktree(taskWorkspace);
      if (!ensured.ok) {
        logLocal(job.id, `Task worktree failed: ${ensured.reason}`, "error");
        await appendLog(
          client,
          job.id,
          agentKey,
          `Task worktree failed: ${ensured.reason}`,
          "error",
        );
        await callToolJson(client, "completeAgentJob", {
          jobId: job.id,
          agentKey,
          status: "failed",
          error: ensured.reason,
          errorCode: errorCodeForPhase(currentPhase),
          updateTask: false,
        });
        return;
      }
      logLocal(job.id, `Task worktree: ${ensured.detail}`);
      await appendLog(client, job.id, agentKey, `Task worktree: ${ensured.detail}`, "log");
    }

    // The managed root is trusted implicitly, so operators do not have to add
    // agent-owned checkouts to IMEMORY_WORKSPACE_ALLOWLIST by hand.
    const allowlist = effectiveAllowlist(process.env);
    logLocal(job.id, `Allowlist roots (${allowlist.length}): ${allowlist.join(", ") || "(empty)"}`);

    const safety = assertSafeWorkspace(job.local_directory, allowlist);
    if (!safety.ok) {
      logLocal(job.id, `Workspace rejected: ${safety.reason}`, "error");
      await appendLog(client, job.id, agentKey, `Workspace rejected: ${safety.reason}`, "error");
      await callToolJson(client, "completeAgentJob", {
        jobId: job.id,
        agentKey,
        status: "failed",
        error: safety.reason,
        errorCode: errorCodeForPhase(currentPhase),
        updateTask: false,
      });
      return;
    }

    const projectMatch = await assertCwdMatchesJobProject(client, job);
    if (!projectMatch.ok) {
      logLocal(job.id, `Project mismatch: ${projectMatch.reason}`, "error");
      await appendLog(client, job.id, agentKey, projectMatch.reason, "error");
      await callToolJson(client, "completeAgentJob", {
        jobId: job.id,
        agentKey,
        status: "failed",
        error: projectMatch.reason,
        errorCode: errorCodeForPhase(currentPhase),
        updateTask: false,
      });
      return;
    }
    if (projectMatch.warning) {
      logLocal(job.id, projectMatch.warning, "error");
      await appendLog(client, job.id, agentKey, projectMatch.warning, "log");
    }

    const startingGit = await readGitMeta(safety.cwd).catch(() => ({
      commit: null as string | null,
      branch: null as string | null,
    }));
    if (startingGit.commit) {
      logLocal(
        job.id,
        `Git baseline: ${startingGit.commit.slice(0, 12)}${startingGit.branch ? ` on ${startingGit.branch}` : ""}`,
      );
    }

    await gotoPhase("preparing_environment");
    const environment = await prepareEnvironment({
      cwd: safety.cwd,
      onLog: (line) => {
        logLocal(job.id, line);
        void appendLog(client, job.id, agentKey, line, "log");
      },
    });
    logLocal(job.id, environment.detail);

    const prompt =
      job.prompt?.trim() ||
      `Implement the assigned ProjectMind task in this repository. Task id: ${job.task_id}`;

    const improvementContract: MacAgentJobContractV1 | null =
      extractMacAgentJobContractFromPrompt(prompt);
    if (improvementContract) {
      logLocal(
        job.id,
        `Improvement job contract schema=${improvementContract.schemaVersion} branch=${improvementContract.branchName} merge=${improvementContract.mergePullRequest} deploy=${improvementContract.deployProduction}`,
      );
      if (
        improvementContract.mergePullRequest !== false ||
        improvementContract.deployProduction !== false
      ) {
        const reason = "Improvement contract forbids merge/deploy automation";
        await appendLog(client, job.id, agentKey, reason, "error");
        await callToolJson(client, "completeAgentJob", {
          jobId: job.id,
          agentKey,
          status: "failed",
          error: reason,
          errorCode: errorCodeForPhase(currentPhase),
          updateTask: false,
        });
        return;
      }
    }

    logLocal(job.id, `Prompt length=${prompt.length} chars`);
    logLocal(job.id, `Prompt preview:\n${prompt.slice(0, 1_500)}`);

    await appendLog(
      client,
      job.id,
      agentKey,
      [
        `Workspace OK: ${safety.cwd}`,
        `Runner: ${job.runner || "auto"}`,
        `Model: ${job.model || "default"}`,
        `Task: ${job.task_id}`,
        `Prompt chars: ${prompt.length}`,
      ].join("\n"),
      "status",
      { markRunning: true },
    );
    await appendLog(client, job.id, agentKey, `Prompt preview:\n${prompt.slice(0, 800)}`, "log");

    await gotoPhase("executing");

    let result: RunnerResult;
    let finalRunner: RunnerName | null = null;
    try {
      if (job.cooldowns) {
        syncGlobalCooldowns(job.cooldowns);
      }
      const requested = job.runner || "auto";
      const hardRule = Boolean(job.hard_rule || improvementContract?.hardRule);
      const rawAttempts = await resolveRunnerAttempts(requested, undefined, { hardRule });
      // Reorder only for multi-runner cascades; explicit pins stay fixed.
      const { available: attempts, skipped } = planAttempts(rawAttempts as ProviderName[], {
        rotate: rawAttempts.length > 1,
      });

      logLocal(
        job.id,
        `Runner plan (requested=${requested}, hardRule=${hardRule}): ${rawAttempts.join(" → ")}` +
          (attempts.join(",") !== rawAttempts.join(",")
            ? ` → paced: ${attempts.join(" → ") || "(none)"}`
            : ""),
      );
      await appendLog(
        client,
        job.id,
        agentKey,
        [
          `Runner plan (requested=${requested}, hardRule=${hardRule}): ${rawAttempts.join(" → ")}`,
          attempts.length > 0 && attempts.join(",") !== rawAttempts.join(",")
            ? `Paced order: ${attempts.join(" → ")}`
            : null,
          formatSkippedLog(skipped),
        ]
          .filter(Boolean)
          .join("\n"),
        "status",
      );

      result = {
        status: "failed",
        summary: "",
        error: "No runner available",
      };

      if (attempts.length === 0) {
        // All runners are in cooldown/disabled — release the job back to the queue
        // instead of wasting it with a failure. Include diagnostics to help
        // troubleshooting why the local machine thought no runners were usable.
        logLocal(job.id, "All runners in cooldown/disabled — releasing job back to queue");
        try {
          const { diagnostics } = await resolveAutoRunnerChainWithDiagnostics();
          const diagStr = diagnostics
            .map((d) => `${d.runner}:${d.available ? "ok" : "missing"}(${d.reason})`)
            .join(", ");
          await appendLog(
            client,
            job.id,
            agentKey,
            `All runners in cooldown/disabled — releasing job back to queue\n` +
              (formatSkippedLog(skipped) ?? "(no skip details)") +
              `\nDiagnostics: ${diagStr}`,
            "status",
          );
        } catch (err) {
          await appendLog(
            client,
            job.id,
            agentKey,
            `All runners in cooldown/disabled — releasing job back to queue\n` +
              (formatSkippedLog(skipped) ?? "(no skip details)") +
              `\nDiagnostics unavailable: ${err instanceof Error ? err.message : String(err)}`,
            "status",
          );
        }

        await releaseJobToQueue(client, job.id, agentKey);
        return;
      }

      for (let i = 0; i < attempts.length; i++) {
        const name = attempts[i]!;
        if (abort.signal.aborted) {
          result = { status: "cancelled", summary: "Cancelled" };
          break;
        }

        if (name === "claude_cli") {
          const usage = await getClaudeUsageSnapshot().catch(() => null);
          if (usage) {
            logLocal(job.id, `Claude usage check: ${usage.note}`);
            await appendLog(
              client,
              job.id,
              agentKey,
              `Claude usage: ${usage.note}`,
              "status",
            ).catch(() => {});
          }

          const limitPercent = parseEnvInt(
            process.env.IMEMORY_CLAUDE_USAGE_LIMIT_PERCENT,
            DEFAULT_CLAUDE_USAGE_LIMIT_PERCENT,
          );
          if (isClaudeUsageClose(usage, limitPercent)) {
            const cooldownMs = parseEnvInt(
              process.env.IMEMORY_CLAUDE_USAGE_COOLDOWN_MS,
              DEFAULT_CLAUDE_USAGE_COOLDOWN_MS,
            );
            recordRateLimit("claude_cli", { retryAfterMs: cooldownMs });

            const hasNextAttempt = i < attempts.length - 1;
            const msg =
              `Claude usage limit close (${usage?.note ?? "unknown"}, threshold ${limitPercent}%)` +
              (hasNextAttempt
                ? " — skipping claude_cli, trying next runner"
                : " — no fallback runner, proceeding anyway");
            logLocal(job.id, msg, "error");
            await appendLog(client, job.id, agentKey, msg, "status");

            if (hasNextAttempt) continue;
          }
        }

        const wait = await awaitBeforeInvoke(name, { signal: abort.signal });
        const pacingMsg = formatPacingLog(wait);
        logLocal(job.id, pacingMsg);
        if (wait.waitMs > 0) {
          await appendLog(client, job.id, agentKey, pacingMsg, "status");
        }

        if (abort.signal.aborted) {
          result = { status: "cancelled", summary: "Cancelled" };
          break;
        }

        const runner = createRunnerByName(
          name,
          job.model,
          modelGateway?.token ? { executionId: job.id, gateway: modelGateway } : null,
        );
        finalRunner = runner.name;
        recordInvoke(runner.name);
        const targetModel = job.model?.trim() || "auto/default";
        logLocal(
          job.id,
          `Invoking runner=${runner.name} model=${targetModel} (attempt ${i + 1}/${attempts.length})`,
        );
        await appendLog(
          client,
          job.id,
          agentKey,
          `Invoking runner=${runner.name} (model=${targetModel}) (attempt ${i + 1}/${attempts.length})`,
          "status",
          { realLlm: realLlmFromResult(runner.name, targetModel) },
        );

        result = await runner.run({
          cwd: safety.cwd,
          prompt,
          signal: abort.signal,
          onLog: async (message, kind = "log") => {
            logLocal(job.id, `[${kind}] ${message}`);
            try {
              await appendLog(client, job.id, agentKey, message, kind);
            } catch (err) {
              logLocal(
                job.id,
                `Failed to upload log event: ${err instanceof Error ? err.message : err}`,
                "error",
              );
            }
          },
        });

        handleRunnerResult(runner.name, result, (msg) => {
          logLocal(job.id, msg, "error");
          void appendLog(client, job.id, agentKey, msg, "status");
        });

        try {
          const stats = await recordLlmUsage({
            runner: runner.name,
            model: result.model,
          });
          const key = `${runner.name}/${result.model?.trim() || "default"}`;
          const count = stats.byLlm[key]?.count ?? 0;
          logLocal(job.id, `LLM usage recorded: ${key} → ${count}`);
        } catch (err) {
          logLocal(
            job.id,
            `Failed to record LLM usage: ${err instanceof Error ? err.message : err}`,
            "error",
          );
        }

        if (result.status === "succeeded" || result.status === "cancelled") {
          break;
        }

        const hasNext = i < attempts.length - 1;
        if (hasNext && isRetryableRunnerFailure(result)) {
          const msg = `Runner ${runner.name} unavailable (${result.error}); trying next`;
          logLocal(job.id, msg, "error");
          await appendLog(client, job.id, agentKey, msg, "status");
          continue;
        }
        break;
      }
    } catch (err) {
      result = {
        status: "failed",
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      };
      logLocal(job.id, `Runner threw: ${result.error}`, "error");
    }

    const elapsedMs = Date.now() - startedAt;

    if (result.status !== "cancelled") {
      await gotoPhase("collecting_results");
    }

    try {
      await appendRunStats(client, job.id, agentKey, finalRunner, result, elapsedMs);
    } catch (err) {
      logLocal(
        job.id,
        `Failed to upload run stats: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }

    logLocal(
      job.id,
      `Runner finished status=${result.status} elapsed=${elapsedMs}ms` +
        (result.externalRunId ? ` externalRunId=${result.externalRunId}` : "") +
        (result.error ? ` error=${result.error}` : "") +
        (result.summary ? ` summary=${result.summary.slice(0, 500)}` : ""),
    );

    // Never let event upload failure block job completion (was leaving jobs stuck in running).
    try {
      await appendLog(
        client,
        job.id,
        agentKey,
        [
          `Runner finished: ${result.status}`,
          `Elapsed: ${elapsedMs}ms`,
          result.externalRunId ? `External run: ${result.externalRunId}` : null,
          result.summary ? `Summary:\n${result.summary.slice(0, 6_000)}` : null,
          result.error ? `Error: ${result.error}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        result.status === "failed" ? "error" : "status",
      );
    } catch (err) {
      logLocal(
        job.id,
        `Failed to upload finish event: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }

    const finalStatus = await getJobStatus(client, job.id);
    if (finalStatus === "paused") {
      logLocal(job.id, "Job paused — leaving status paused (same job id for resume)");
      try {
        await appendLog(
          client,
          job.id,
          agentKey,
          "Runner stopped after pause — job kept for resume",
          "status",
        );
      } catch {
        // ignore
      }
      return;
    }
    if (finalStatus === "cancelled") {
      logLocal(job.id, "Completing as cancelled");
      await callToolJson(client, "completeAgentJob", {
        jobId: job.id,
        agentKey,
        status: "cancelled",
        resultSummary: result.summary || "Cancelled",
        errorCode: "EXECUTION_CANCELLED",
        updateTask: false,
        externalRunId: result.externalRunId,
        realLlm: realLlmFromResult(finalRunner, result.model),
      }).catch(() => {});
      return;
    }

    // Prefer live job.phase from API — claim payloads have historically omitted `phase`.
    let phase = (job.phase ?? "implement") === "plan" ? "plan" : "implement";
    if (phase !== "plan") {
      try {
        const live = await callToolJson<{ job?: { phase?: string | null } | null }>(
          client,
          "getAgentJob",
          { jobId: job.id },
        );
        if ((live.job?.phase ?? "").trim() === "plan") {
          phase = "plan";
          logLocal(job.id, "Resolved phase=plan from getAgentJob (was missing on claim)");
        }
      } catch {
        // keep claim-time phase
      }
    }
    const isPlanPhase = phase === "plan";

    if (result.status === "succeeded" && isPlanPhase) {
      const interaction = extractInteractionFromText(result.summary || "");
      if (!interaction) {
        logLocal(job.id, "Plan phase produced no parseable plan/questions", "error");
        await callToolJson(client, "completeAgentJob", {
          jobId: job.id,
          agentKey,
          status: "failed",
          error: "Plan phase did not return a plan or questions payload",
          errorCode: errorCodeForPhase(currentPhase),
          resultSummary: result.summary || null,
          updateTask: false,
          externalRunId: result.externalRunId || null,
          realLlm: realLlmFromResult(finalRunner, result.model),
        });
        return;
      }

      logLocal(job.id, `Awaiting user input (${interaction.type}) — not marking task done`);
      await callToolJson(client, "awaitAgentJobUserInput", {
        jobId: job.id,
        agentKey,
        interaction,
        resultSummary:
          interaction.type === "plan"
            ? interaction.summary
            : `Waiting for ${interaction.questions.length} answer(s)`,
        externalRunId: result.externalRunId || null,
        realLlm: realLlmFromResult(finalRunner, result.model),
      });
      logLocal(job.id, `Done plan phase (total ${Date.now() - startedAt}ms)`);
      return;
    }

    let resultSummary = result.summary || null;
    let prUrl: string | null = null;
    if (result.status === "succeeded") {
      try {
        // The job may have outlived the one-hour token; renew before pushing.
        await refreshGitCredentials();
        const gitResult = await commitAndPushAfterTask({
          cwd: safety.cwd,
          message: shortCommitMessage(result.summary || "", job.task_id),
          taskId: job.task_id,
          onLog: async (message, kind = "log") => {
            logLocal(job.id, `[${kind}] ${message}`);
            try {
              await appendLog(client, job.id, agentKey, message, kind);
            } catch (err) {
              logLocal(
                job.id,
                `Failed to upload git log event: ${err instanceof Error ? err.message : err}`,
                "error",
              );
            }
          },
        });
        const gitLine = `Git: ${gitResult.detail}`;
        resultSummary = [result.summary?.trim(), gitLine].filter(Boolean).join("\n\n");
        if (!gitResult.ok) {
          logLocal(job.id, gitLine, "error");
        }
      } catch (err) {
        const msg = `Git publish threw: ${err instanceof Error ? err.message : err}`;
        logLocal(job.id, msg, "error");
        resultSummary = [result.summary?.trim(), msg].filter(Boolean).join("\n\n");
      }

      if (improvementContract?.createPullRequest) {
        try {
          const pr = await ensurePullRequest({
            cwd: safety.cwd,
            baseBranch: improvementContract.baseBranch,
            title: shortCommitMessage(result.summary || "", job.task_id),
            body: [
              result.summary?.trim() || "ProjectMind improvement execution",
              "",
              `Plan: ${improvementContract.planId}`,
              `Run: ${improvementContract.executionRunId}`,
            ].join("\n"),
            onLog: async (message, kind = "log") => {
              logLocal(job.id, `[${kind}] ${message}`);
              try {
                await appendLog(client, job.id, agentKey, message, kind);
              } catch {
                // ignore upload errors
              }
            },
          });
          prUrl = pr.prUrl;
          resultSummary = [resultSummary, `PR: ${pr.detail}`].filter(Boolean).join("\n\n");
          if (!pr.ok) {
            logLocal(job.id, pr.detail, "error");
          }
        } catch (err) {
          const msg = `PR ensure threw: ${err instanceof Error ? err.message : err}`;
          logLocal(job.id, msg, "error");
          resultSummary = [resultSummary, msg].filter(Boolean).join("\n\n");
        }
      }

      // Automatic visual snapshot → Assets/UI/<Page>/ (best-effort; never fails the job).
      if (!isPlanPhase) {
        try {
          const changedFiles = await listChangedFilesFromHead(safety.cwd).catch(
            () => [] as string[],
          );
          const visual = await captureAndSaveVisualState({
            client,
            cwd: safety.cwd,
            taskId: job.task_id,
            projectSlug: process.env.IMEMORY_PROJECT_SLUG?.trim() || null,
            changedFiles,
            onLog: (message, kind = "info") => {
              logLocal(job.id, message, kind === "error" ? "error" : "info");
              void appendLog(
                client,
                job.id,
                agentKey,
                message,
                kind === "error" ? "error" : "log",
              ).catch(() => {});
            },
          });
          if (visual.attempted) {
            resultSummary = [resultSummary, visual.detail].filter(Boolean).join("\n\n");
          }
        } catch (err) {
          const msg = `Visual snapshot threw: ${err instanceof Error ? err.message : err}`;
          logLocal(job.id, msg, "error");
          resultSummary = [resultSummary, msg].filter(Boolean).join("\n\n");
        }
      }

      // Persist rollback snapshot on the task (commit + files) — best-effort.
      if (!isPlanPhase && startingGit.commit) {
        try {
          const endGit = await readGitMeta(safety.cwd);
          const finalCommit = endGit.commit;
          let changedFiles = finalCommit
            ? await listChangedFilesBetween(safety.cwd, startingGit.commit, finalCommit)
            : [];
          if (changedFiles.length === 0 && finalCommit && finalCommit !== startingGit.commit) {
            changedFiles = await listChangedFilesFromHead(safety.cwd).catch(() => [] as string[]);
          }
          if (changedFiles.length > 0 || (finalCommit && finalCommit !== startingGit.commit)) {
            const saved = await callToolJson<{
              saved?: boolean;
              reason?: string;
              contextFile?: { name?: string };
            }>(client, "saveTaskRollbackSnapshot", {
              taskId: job.task_id,
              startingCommit: startingGit.commit,
              finalCommit: finalCommit ?? null,
              branch: endGit.branch ?? startingGit.branch,
              changedFiles,
              jobId: job.id,
              projectSlug: process.env.IMEMORY_PROJECT_SLUG?.trim() || undefined,
            });
            const detail = saved.saved
              ? `Rollback snapshot saved${saved.contextFile?.name ? `: ${saved.contextFile.name}` : ""} (${changedFiles.length} files)`
              : `Rollback snapshot skipped: ${saved.reason ?? "unknown"}`;
            logLocal(job.id, detail);
            resultSummary = [resultSummary, detail].filter(Boolean).join("\n\n");
            try {
              await appendLog(client, job.id, agentKey, detail, "status");
            } catch {
              // ignore
            }
          }
        } catch (err) {
          const msg = `Rollback snapshot threw: ${err instanceof Error ? err.message : err}`;
          logLocal(job.id, msg, "error");
          resultSummary = [resultSummary, msg].filter(Boolean).join("\n\n");
        }
      }
    }

    // Captured before the cleaning_up transition so a runner/result failure is
    // still blamed on the phase it actually happened in, not on cleanup.
    const finalErrorCode = result.status === "failed" ? errorCodeForPhase(currentPhase) : null;
    await gotoPhase("cleaning_up");

    logLocal(job.id, `Completing job as ${result.status}`);
    await callToolJson(client, "completeAgentJob", {
      jobId: job.id,
      agentKey,
      status: result.status,
      resultSummary,
      error: result.error || null,
      errorCode: finalErrorCode,
      externalRunId: result.externalRunId || null,
      updateTask: result.status === "succeeded",
      realLlm: realLlmFromResult(finalRunner, result.model),
    });

    if (improvementContract) {
      try {
        const safetyCheck = enforceContractSafety(improvementContract, []);
        if (!safetyCheck.ok && result.status === "succeeded") {
          logLocal(job.id, `Contract safety: ${safetyCheck.reason}`, "error");
        }
        const cb = await postImprovementCallback(improvementContract, {
          status:
            result.status === "succeeded"
              ? "succeeded"
              : result.status === "cancelled"
                ? "cancelled"
                : "failed",
          summary: resultSummary,
          error: result.error || null,
          testsPassed: result.status === "succeeded" ? true : null,
          mergeAttempted: false,
          deployAttempted: false,
          branch: improvementContract.branchName,
          prUrl,
        });
        logLocal(
          job.id,
          `Improvement callback → ${cb.status} ok=${cb.ok}`,
          cb.ok ? "info" : "error",
        );
      } catch (err) {
        logLocal(
          job.id,
          `Improvement callback failed: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logLocal(job.id, `Job setup/execution unhandled exception: ${errorMsg}`, "error");
    try {
      await appendLog(
        client,
        job.id,
        agentKey,
        `Job execution failed with unhandled exception: ${errorMsg}`,
        "error",
      );
    } catch {
      // best-effort log
    }
    try {
      await callToolJson(client, "completeAgentJob", {
        jobId: job.id,
        agentKey,
        status: "failed",
        error: errorMsg,
        errorCode: errorCodeForPhase(currentPhase),
        updateTask: false,
      });
    } catch {
      // best-effort complete
    }
  } finally {
    stopLeaseKeepalive();
    // Never let one job's credential outlive it into the next.
    setActiveGitCredentials(null);
    logLocal(job.id, `Done (total ${Date.now() - startedAt}ms)`);
  }
}
