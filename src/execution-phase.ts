/**
 * Thin lifecycle-reporting layer around the job execution already implemented
 * in jobs.ts: reports which internal phase the current attempt is in
 * (heartbeat + optional pinned source revision) and picks a structured error
 * code for a failure based on the phase it happened in.
 *
 * This intentionally does not become a new execution framework — jobs.ts still
 * owns the actual workspace/runner/publish steps. This module only adds the
 * phase-transition/error-code scaffolding the control plane needs to show
 * "Running · Preparing workspace" and to distinguish retryable failures.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type ExecutionErrorCode,
  type ExecutionLifecyclePhase,
  type SourceRevision,
} from "@imemory/improvement-contracts";
import { callToolJson } from "./mcp-client.js";

export type { ExecutionErrorCode, ExecutionLifecyclePhase, SourceRevision };

/**
 * Best-effort: a failed phase report must never abort the job it is reporting
 * on. The job's own outcome is always decided by the actual step, not by
 * whether the control plane heard about it in time.
 */
export async function reportPhase(
  client: Client,
  jobId: string,
  agentKey: string,
  phase: ExecutionLifecyclePhase,
  sourceRevision?: SourceRevision | null,
): Promise<void> {
  try {
    await callToolJson(client, "updateAgentJobPhase", {
      jobId,
      agentKey,
      phase,
      ...(sourceRevision ? { sourceRevision } : {}),
    });
  } catch (err) {
    console.error(
      `[job ${jobId.slice(0, 8)}] Failed to report phase ${phase}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const PHASE_ERROR_CODES: Record<ExecutionLifecyclePhase, ExecutionErrorCode> = {
  claiming: "AGENT_LOST",
  preparing_workspace: "WORKSPACE_CLONE_FAILED",
  preparing_environment: "ENVIRONMENT_PREPARATION_FAILED",
  executing: "EXECUTION_FAILED",
  collecting_results: "RESULT_COLLECTION_FAILED",
  cleaning_up: "CLEANUP_FAILED",
};

/** The structured code for a failure that happened while in the given phase. */
export function errorCodeForPhase(phase: ExecutionLifecyclePhase): ExecutionErrorCode {
  return PHASE_ERROR_CODES[phase];
}
