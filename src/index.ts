import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  collectCpuLoadPercent,
  collectMachineInfo,
  formatHeartbeatDone,
  normalizeMcpBaseUrl,
  sleep,
} from "./machine.js";
import { connectMcpClient, callToolJson } from "./mcp-client.js";
import { claimNextJob, executeClaimedJob, hasAnyAvailableRunner } from "./jobs.js";
import { getClaudeUsageSnapshot } from "./claude-usage.js";
import { readLlmUsageMeta } from "./llm-stats.js";
import { parseAllowlist } from "./safety.js";
import { runHealthCheck } from "./health-check.js";
import { resolveManagedRoot } from "./managed-workspace.js";
import { getAgentBuildDate, getAgentVersion } from "./agent-version.js";
import {
  detectInstall,
  isAutoUpdateEnabled,
  maybeSelfUpdate,
  parseUpdateCheckIntervalMs,
} from "./self-update.js";

const cwd = process.cwd();
const execDir = dirname(process.execPath);

// Packaged zip: `.env` next to the binary or in cwd.
// Dev (`npm start` in mac-agent/): cwd `.env`, then parent repo `.env`.
loadEnv({ path: resolve(cwd, ".env") });
loadEnv({ path: resolve(execDir, ".env") });
loadEnv({ path: resolve(cwd, "mac-agent/.env") });
loadEnv({ path: resolve(cwd, "../.env") });

const DEFAULT_MCP_URL = "http://localhost:8080/api/mcp";
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_JOB_POLL_MS = 5_000;

function buildMcpUrl(baseUrl: string, projectSlug?: string): URL {
  const url = new URL(normalizeMcpBaseUrl(baseUrl));
  if (projectSlug && !url.searchParams.has("projectSlug")) {
    url.searchParams.set("projectSlug", projectSlug);
  }
  return url;
}

function parseIntervalMs(raw: string | undefined, fallback: number, min: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Interval must be a number >= ${min} (milliseconds)`);
  }
  return Math.floor(value);
}

/** Returns the agent's server-side meta (so callers can react to e.g. a pending health-check request). */
async function reportHeartbeat(
  client: Client,
  agentVersion: string,
  agentBuildDate: string | null,
): Promise<Record<string, unknown> | null> {
  const info = collectMachineInfo();
  const done = formatHeartbeatDone(info);
  console.log(`Reporting: ${done}`);

  const llmUsage = await readLlmUsageMeta().catch(() => null);
  const cpuLoadPercent = await collectCpuLoadPercent();
  const install = detectInstall();
  const claudeUsage = await getClaudeUsageSnapshot().catch(() => null);

  const meta: Record<string, unknown> = {
    agentVersion,
    installKind: install.kind,
  };
  if (agentBuildDate) meta.agentBuildDate = agentBuildDate;
  if (llmUsage) meta.llmUsage = llmUsage;
  if (cpuLoadPercent != null) meta.cpuLoadPercent = cpuLoadPercent;
  if (claudeUsage) meta.claudeUsage = claudeUsage;

  // Advertise that this agent can clone projects itself. The control plane
  // gates managed workspaces on this capability rather than on a version
  // string, so an agent that has not been updated keeps today's behaviour
  // exactly.
  meta.managedWorkspaceRoot = resolveManagedRoot();
  meta.capabilities = { managedClone: true };

  const response = await callToolJson<{ agent?: { meta?: Record<string, unknown> | null } }>(
    client,
    "reportAgentHeartbeat",
    {
      name: info.host,
      agentKey: info.agentKey,
      kind: info.kind,
      platform: info.platform,
      meta,
    },
  );

  const loadPart = cpuLoadPercent != null ? ` CPU=${cpuLoadPercent}%` : "";
  if (llmUsage && Object.keys(llmUsage.byLlm).length > 0) {
    const top = Object.entries(llmUsage.byLlm)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    console.log(`Heartbeat stored.${loadPart} v=${agentVersion} LLM usage: ${top}`);
  } else {
    console.log(`Heartbeat stored.${loadPart} v=${agentVersion}`);
  }

  return response.agent?.meta ?? null;
}

/**
 * Health-check mode: the Agents page sets `meta.healthCheckRequestedAt` on this agent's row
 * to ask it to probe every configured model runner. Picked up from the heartbeat response so
 * no extra polling channel is needed. Skips (and retries on the next heartbeat) while a job
 * is running so it never contends with task execution.
 */
async function maybeRunHealthCheck(
  client: Client,
  agentMeta: Record<string, unknown> | null,
  agentKey: string,
  state: { busy: boolean; lastHealthCheckRequestedAt: string | null },
): Promise<void> {
  const requestedAt = agentMeta?.healthCheckRequestedAt;
  if (typeof requestedAt !== "string" || !requestedAt) return;
  if (requestedAt === state.lastHealthCheckRequestedAt) return;
  if (state.busy) return; // retried on the next heartbeat once idle

  state.busy = true;
  state.lastHealthCheckRequestedAt = requestedAt;
  console.log("Health check requested — probing all configured model runners…");
  try {
    const results = await runHealthCheck();
    const summary =
      results.map((r) => `${r.runner}=${r.ok ? "ok" : "fail"}`).join(", ") ||
      "no runners configured";
    console.log(`Health check complete: ${summary}`);
    await callToolJson(client, "reportAgentHealthCheck", {
      agentKey,
      requestedAt,
      results,
    });
  } catch (err) {
    console.error("Health check failed:", err instanceof Error ? err.message : err);
  } finally {
    state.busy = false;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.IMEMORY_API_KEY?.trim() || process.env.MCP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Missing IMEMORY_API_KEY (or MCP_API_KEY). Create a project API key in ProjectMind settings.",
    );
  }

  const mcpUrl = buildMcpUrl(
    process.env.IMEMORY_MCP_URL?.trim() || DEFAULT_MCP_URL,
    process.env.IMEMORY_PROJECT_SLUG?.trim() || process.env.MCP_PROJECT_SLUG?.trim(),
  );
  const heartbeatMs = parseIntervalMs(
    process.env.IMEMORY_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_MS,
    5_000,
  );
  const jobPollMs = parseIntervalMs(
    process.env.IMEMORY_JOB_POLL_INTERVAL_MS,
    DEFAULT_JOB_POLL_MS,
    1_000,
  );

  const allowlist = parseAllowlist(process.env.IMEMORY_WORKSPACE_ALLOWLIST);
  const info = collectMachineInfo();
  const agentVersion = getAgentVersion();
  const agentBuildDate = getAgentBuildDate();
  const install = detectInstall();
  const autoUpdate = isAutoUpdateEnabled();
  const updateCheckMs = autoUpdate ? parseUpdateCheckIntervalMs() : Number.POSITIVE_INFINITY;
  let lastUpdateCheckAt = 0;

  console.log(`Connecting to ${mcpUrl.href}`);
  console.log(`Agent key: ${info.agentKey}`);
  console.log(`Agent version: ${agentVersion} (${install.kind})`);
  if (agentBuildDate) console.log(`Agent build: ${agentBuildDate}`);
  console.log(`Heartbeat interval: ${heartbeatMs}ms`);
  console.log(`Job poll interval: ${jobPollMs}ms`);
  if (autoUpdate) {
    console.log(
      `Auto-update: on (check every ${updateCheckMs}ms; set IMEMORY_AGENT_AUTO_UPDATE=0 to disable)`,
    );
  } else {
    console.log("Auto-update: off");
  }
  if (allowlist.length === 0) {
    console.warn(
      "Warning: IMEMORY_WORKSPACE_ALLOWLIST is empty — heartbeats work, but jobs will fail until set.",
    );
  } else {
    console.log(`Workspace allowlist: ${allowlist.join(", ")}`);
  }
  console.log("Ctrl+C to stop");

  if (autoUpdate) {
    try {
      const update = await maybeSelfUpdate(mcpUrl, { busy: false });
      lastUpdateCheckAt = Date.now();
      if (update.updated) {
        return;
      }
      console.log(`Auto-update: ${update.detail}`);
    } catch (err) {
      console.error("Auto-update check on start failed:", err instanceof Error ? err.message : err);
    }
  }

  let client = await connectMcpClient(mcpUrl, apiKey);
  let stopping = false;
  // busy also gates health-check mode, so job polling and health checks never overlap.
  const runState = { busy: false, lastHealthCheckRequestedAt: null as string | null };
  let heartbeatInFlight = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down…");
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await client.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  // Heartbeat on its own timer so long-running jobs still mark the agent online.
  heartbeatTimer = setInterval(() => {
    if (stopping || heartbeatInFlight) return;
    heartbeatInFlight = true;
    void reportHeartbeat(client, agentVersion, agentBuildDate)
      .then((agentMeta) => maybeRunHealthCheck(client, agentMeta, info.agentKey, runState))
      .catch((err) => {
        console.error("Heartbeat failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatMs);

  // Initial heartbeat before the first poll.
  try {
    const agentMeta = await reportHeartbeat(client, agentVersion, agentBuildDate);
    await maybeRunHealthCheck(client, agentMeta, info.agentKey, runState);
  } catch (err) {
    console.error("Initial heartbeat failed:", err instanceof Error ? err.message : err);
  }

  let pollCount = 0;

  while (!stopping) {
    try {
      if (!runState.busy) {
        const now = Date.now();
        if (autoUpdate && now - lastUpdateCheckAt >= updateCheckMs) {
          lastUpdateCheckAt = now;
          const update = await maybeSelfUpdate(mcpUrl, { busy: false });
          if (update.updated) {
            // Restart scheduled by self-update; stop heartbeats and yield.
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            return;
          }
          if (pollCount === 0 || update.detail !== `up to date (${agentVersion})`) {
            console.log(`Auto-update: ${update.detail}`);
          }
        }

        pollCount += 1;
        if (pollCount === 1 || pollCount % 12 === 0) {
          console.log(`Polling for jobs… (#${pollCount})`);
        }

        // Pre-claim gate: skip claiming if all runners are in cooldown/disabled.
        // This avoids claiming a job only to immediately release it.
        const runnersReady = await hasAnyAvailableRunner();
        if (!runnersReady) {
          // Log once every 12 polls to avoid spam.
          if (pollCount === 1 || pollCount % 12 === 0) {
            console.log("All runners in cooldown/disabled — skipping claim attempt");
          }
          // Still call claimNextJob with no-op to sync cooldowns from server
          // (the server now returns cooldowns even when job is null).
          await claimNextJob(client, info.agentKey).catch(() => {});
        } else {
          const claimed = await claimNextJob(client, info.agentKey);
          if (claimed) {
            const {
              job,
              taskWorkspace,
              repository,
              managedWorkspace,
              gitCredentials,
              modelGateway,
            } = claimed;
            runState.busy = true;
            console.log("─".repeat(60));
            console.log(
              `Claimed job ${job.id}\n` +
                `  runner=${job.runner}\n` +
                `  task=${job.task_id}\n` +
                `  cwd=${job.local_directory}\n` +
                `  promptChars=${job.prompt?.length ?? 0}` +
                (taskWorkspace ? `\n  taskWorkspace=${taskWorkspace.status}` : ""),
            );
            console.log("─".repeat(60));
            try {
              await executeClaimedJob(
                client,
                job,
                info.agentKey,
                taskWorkspace,
                repository,
                managedWorkspace,
                gitCredentials,
                modelGateway,
              );
              console.log(`Job ${job.id} finished OK.`);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(`Job ${job.id} unhandled error:`, errMsg);
              try {
                await callToolJson(client, "appendAgentJobEvent", {
                  jobId: job.id,
                  agentKey: info.agentKey,
                  message: `Worker unhandled error: ${errMsg}`,
                  kind: "error",
                });
                await callToolJson(client, "completeAgentJob", {
                  jobId: job.id,
                  agentKey: info.agentKey,
                  status: "failed",
                  error: errMsg,
                  updateTask: false,
                });
              } catch (reportErr) {
                console.error(`Failed to report job ${job.id} error to server:`, reportErr);
              }
            } finally {
              runState.busy = false;
              console.log("Ready for next job.");
            }
          }
        }
      }
    } catch (err) {
      console.error("Loop failed:", err instanceof Error ? err.message : err);
      await client.close().catch(() => {});
      try {
        console.log("Reconnecting…");
        client = await connectMcpClient(mcpUrl, apiKey);
        console.log("Reconnected.");
      } catch (reconnectErr) {
        console.error(
          "Reconnect failed:",
          reconnectErr instanceof Error ? reconnectErr.message : reconnectErr,
        );
      }
    }

    if (stopping) break;
    await sleep(jobPollMs);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
