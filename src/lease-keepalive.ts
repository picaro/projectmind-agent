/** How often the agent renews the job lease while running. Must stay under control-plane TTL (~2m). */
export const LEASE_RENEW_MS = 60_000;

/** Control-plane `AGENT_JOB_LEASE_TTL_MS` (documented expectation for operator logs). */
export const LEASE_TTL_MS_ASSUMED = 2 * 60_000;

/** Abort the run after this many consecutive renew failures instead of waiting for silent AGENT_LOST. */
export const MAX_CONSECUTIVE_RENEW_FAILURES = 2;

export function shouldAbortAfterRenewFailures(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_RENEW_FAILURES;
}

export function formatLeaseKeepaliveStartMessage(input: {
  agentVersion: string;
  pid: number;
  renewIntervalMs?: number;
  leaseTtlMsAssumed?: number;
}): string {
  const renewMs = input.renewIntervalMs ?? LEASE_RENEW_MS;
  const ttlMs = input.leaseTtlMsAssumed ?? LEASE_TTL_MS_ASSUMED;
  return [
    `Lease keepalive started`,
    `agentVersion=${input.agentVersion}`,
    `pid=${input.pid}`,
    `renewEveryMs=${renewMs}`,
    `leaseTtlAssumedMs=${ttlMs}`,
  ].join("; ");
}

export function formatLeaseRenewSuccessMessage(input: {
  renewCount: number;
  elapsedSec: number;
  phase: string;
  jobStatus: string;
}): string {
  return `Lease renewed (#${input.renewCount}) after ${input.elapsedSec}s; phase=${input.phase}; jobStatus=${input.jobStatus}`;
}

export function formatLeaseRenewFailureMessage(input: {
  renewCount: number;
  consecutiveFailures: number;
  error: string;
}): string {
  return `Lease renew failed (#${input.renewCount}, consecutive=${input.consecutiveFailures}): ${input.error}`;
}

export function formatLeaseRenewAbortMessage(input: {
  consecutiveFailures: number;
  error: string;
}): string {
  return `Lease renew aborted after ${input.consecutiveFailures} consecutive failures — ${input.error}`;
}

export function formatAgentShutdownFarewellMessage(input: {
  jobId: string;
  signal?: string;
}): string {
  const sig = input.signal?.trim() || "shutdown";
  return `Agent shutting down (${sig}) while job ${input.jobId} is active — lease renewals will stop`;
}

type ActiveJob = { jobId: string; agentKey: string };

let activeJob: ActiveJob | null = null;

export function setActiveJob(jobId: string, agentKey: string): void {
  activeJob = { jobId, agentKey };
}

export function clearActiveJob(jobId?: string): void {
  if (!activeJob) return;
  if (jobId && activeJob.jobId !== jobId) return;
  activeJob = null;
}

export function getActiveJob(): ActiveJob | null {
  return activeJob;
}
