import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CONSECUTIVE_RENEW_FAILURES,
  clearActiveJob,
  formatAgentShutdownFarewellMessage,
  formatLeaseKeepaliveStartMessage,
  formatLeaseRenewAbortMessage,
  formatLeaseRenewFailureMessage,
  formatLeaseRenewSuccessMessage,
  getActiveJob,
  setActiveJob,
  shouldAbortAfterRenewFailures,
} from "./lease-keepalive.js";

describe("lease-keepalive helpers", () => {
  afterEach(() => {
    clearActiveJob();
  });

  it("formats keepalive start with version, pid, and intervals", () => {
    expect(
      formatLeaseKeepaliveStartMessage({
        agentVersion: "0.2.4",
        pid: 4242,
        renewIntervalMs: 60_000,
        leaseTtlMsAssumed: 120_000,
      }),
    ).toBe(
      "Lease keepalive started; agentVersion=0.2.4; pid=4242; renewEveryMs=60000; leaseTtlAssumedMs=120000",
    );
  });

  it("formats renew success / failure / abort messages", () => {
    expect(
      formatLeaseRenewSuccessMessage({
        renewCount: 3,
        elapsedSec: 125,
        phase: "executing",
        jobStatus: "running",
      }),
    ).toBe("Lease renewed (#3) after 125s; phase=executing; jobStatus=running");

    expect(
      formatLeaseRenewFailureMessage({
        renewCount: 2,
        consecutiveFailures: 1,
        error: "network down",
      }),
    ).toBe("Lease renew failed (#2, consecutive=1): network down");

    expect(
      formatLeaseRenewAbortMessage({
        consecutiveFailures: 2,
        error: "network down",
      }),
    ).toMatch(/aborted after 2 consecutive failures/);
  });

  it("aborts after MAX_CONSECUTIVE_RENEW_FAILURES", () => {
    expect(shouldAbortAfterRenewFailures(MAX_CONSECUTIVE_RENEW_FAILURES - 1)).toBe(false);
    expect(shouldAbortAfterRenewFailures(MAX_CONSECUTIVE_RENEW_FAILURES)).toBe(true);
    expect(shouldAbortAfterRenewFailures(MAX_CONSECUTIVE_RENEW_FAILURES + 1)).toBe(true);
  });

  it("tracks active job for shutdown farewell", () => {
    expect(getActiveJob()).toBeNull();
    setActiveJob("job-1", "host:Mac");
    expect(getActiveJob()).toEqual({ jobId: "job-1", agentKey: "host:Mac" });
    expect(formatAgentShutdownFarewellMessage({ jobId: "job-1", signal: "SIGTERM" })).toBe(
      "Agent shutting down (SIGTERM) while job job-1 is active — lease renewals will stop",
    );
    clearActiveJob("other");
    expect(getActiveJob()?.jobId).toBe("job-1");
    clearActiveJob("job-1");
    expect(getActiveJob()).toBeNull();
  });
});
