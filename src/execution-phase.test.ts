import { beforeEach, describe, expect, it, vi } from "vitest";

const callToolJson = vi.fn();

vi.mock("./mcp-client.js", () => ({
  callToolJson: (...args: unknown[]) => callToolJson(...args),
}));

import { errorCodeForPhase, reportPhase } from "./execution-phase.js";

describe("reportPhase", () => {
  beforeEach(() => {
    callToolJson.mockReset();
  });

  it("calls updateAgentJobPhase with jobId/agentKey/phase", async () => {
    callToolJson.mockResolvedValue({ job: {} });
    await reportPhase({} as never, "job-1", "host:Agent", "executing");
    expect(callToolJson).toHaveBeenCalledWith(
      {},
      "updateAgentJobPhase",
      expect.objectContaining({ jobId: "job-1", agentKey: "host:Agent", phase: "executing" }),
    );
  });

  it("includes sourceRevision only when provided", async () => {
    callToolJson.mockResolvedValue({ job: {} });
    await reportPhase({} as never, "job-1", "host:Agent", "preparing_workspace", {
      repositoryUrl: "https://github.com/x/y",
      branch: "main",
      commitSha: "abc123",
    });
    expect(callToolJson).toHaveBeenCalledWith(
      {},
      "updateAgentJobPhase",
      expect.objectContaining({
        sourceRevision: {
          repositoryUrl: "https://github.com/x/y",
          branch: "main",
          commitSha: "abc123",
        },
      }),
    );

    callToolJson.mockClear();
    await reportPhase({} as never, "job-1", "host:Agent", "executing");
    const call = callToolJson.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(call).not.toHaveProperty("sourceRevision");
  });

  it("never throws when the control plane call fails — reporting is best-effort", async () => {
    callToolJson.mockRejectedValue(new Error("network down"));
    await expect(
      reportPhase({} as never, "job-1", "host:Agent", "executing"),
    ).resolves.toBeUndefined();
  });
});

describe("errorCodeForPhase", () => {
  it("maps each lifecycle phase to its structured error code", () => {
    expect(errorCodeForPhase("claiming")).toBe("AGENT_LOST");
    expect(errorCodeForPhase("preparing_workspace")).toBe("WORKSPACE_CLONE_FAILED");
    expect(errorCodeForPhase("preparing_environment")).toBe("ENVIRONMENT_PREPARATION_FAILED");
    expect(errorCodeForPhase("executing")).toBe("EXECUTION_FAILED");
    expect(errorCodeForPhase("collecting_results")).toBe("RESULT_COLLECTION_FAILED");
    expect(errorCodeForPhase("cleaning_up")).toBe("CLEANUP_FAILED");
  });
});
