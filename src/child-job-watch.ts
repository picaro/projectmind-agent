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

/** Control-plane rejects job reads once the lease is released (job completed). */
export function isJobInaccessibleError(message: string): boolean {
  return /job not accessible for this api key/i.test(message);
}

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
  let currentPoll: Promise<void> | null = null;
  let stopped = false;

  const reap = (jobId: string) => {
    children.delete(jobId);
  };

  const stopPoller = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const markStopped = () => {
    stopped = true;
    stopPoller();
  };

  const poll = () => {
    if (stopped || input.signal.aborted || currentPoll) return;
    currentPoll = (async () => {
      try {
        const listed = await callToolJson<{ delegations?: DelegationRow[] }>(
          input.client,
          "listDelegations",
          { parentExecutionId: input.parentJobId },
        );
        if (stopped || input.signal.aborted) return;
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
          if (stopped || input.signal.aborted) return;
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
            if (stopped || input.signal.aborted) return;
            input.onLog(`exec-job spawn failed for ${childJobId.slice(0, 8)}: ${err.message}`);
            spawned.delete(childJobId);
            reap(childJobId);
          });
        }
      } catch (err) {
        if (stopped || input.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        if (isJobInaccessibleError(message)) {
          // Parent job finished (lease released) or this key cannot read it.
          // Do not log: after completeAgentJob this is expected, and logging
          // would try appendAgentJobEvent on a job the key can no longer write.
          markStopped();
          return;
        }
        input.onLog(`Child-job watch failed: ${message}`);
      } finally {
        currentPoll = null;
      }
    })();
  };

  void poll();
  timer = setInterval(() => {
    void poll();
  }, WATCH_MS);

  input.signal.addEventListener("abort", markStopped, { once: true });

  return {
    stop: async () => {
      markStopped();
      if (currentPoll) await currentPoll;
    },
  };
}
