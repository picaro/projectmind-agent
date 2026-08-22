import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ChildProcess } from "node:child_process";
import { callToolJson } from "./mcp-client.js";
import {
  maxChildWorkers,
  resolveExecJobSpawnSpec,
  shouldSpawnQueuedChild,
  spawnExecJobProcess,
} from "./child-jobs.js";

const WATCH_MS = 5_000;

type DelegationRow = {
  child_job_id?: string | null;
};

export function startChildJobWatch(input: {
  client: Client;
  parentJobId: string;
  maxConcurrent?: number | null;
  onLog: (message: string) => void;
  signal: AbortSignal;
}): { stop: () => Promise<void> } {
  const spawned = new Set<string>();
  const children = new Map<string, ChildProcess>();
  const max = maxChildWorkers(input.maxConcurrent);
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlightPoll = false;

  const reap = (jobId: string) => {
    children.delete(jobId);
  };

  const poll = async () => {
    if (input.signal.aborted || inFlightPoll) return;
    inFlightPoll = true;
    try {
      const listed = await callToolJson<{ delegations?: DelegationRow[] }>(
        input.client,
        "listDelegations",
        { parentExecutionId: input.parentJobId },
      );
      for (const row of listed.delegations ?? []) {
        const childJobId = row.child_job_id?.trim() ?? "";
        if (!childJobId) continue;
        let status: string | null = null;
        try {
          const payload = await callToolJson<{ job?: { status?: string } | null }>(
            input.client,
            "getAgentJob",
            { jobId: childJobId },
          );
          status = payload.job?.status ?? null;
        } catch {
          continue;
        }
        if (
          !shouldSpawnQueuedChild({
            childJobId,
            status,
            alreadySpawned: spawned,
            inFlight: children.size,
            max,
          })
        ) {
          continue;
        }
        spawned.add(childJobId);
        const spec = resolveExecJobSpawnSpec(childJobId);
        input.onLog(
          `Spawning exec-job for child ${childJobId.slice(0, 8)} (${spec.command} ${spec.args.join(" ")})`,
        );
        const child = spawnExecJobProcess(spec);
        children.set(childJobId, child);
        child.on("exit", () => reap(childJobId));
        child.on("error", (err) => {
          input.onLog(`exec-job spawn failed for ${childJobId.slice(0, 8)}: ${err.message}`);
          spawned.delete(childJobId);
          reap(childJobId);
        });
      }
    } catch (err) {
      input.onLog(
        `Child-job watch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlightPoll = false;
    }
  };

  void poll();
  timer = setInterval(() => {
    void poll();
  }, WATCH_MS);

  const stopPoller = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  input.signal.addEventListener("abort", stopPoller, { once: true });

  return {
    stop: async () => {
      stopPoller();
    },
  };
}
