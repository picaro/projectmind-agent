import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCooldownUntil, resetProviderPacing } from "./provider-pacing.js";

const callToolJson = vi.fn();

vi.mock("./mcp-client.js", () => ({
  callToolJson: (...args: unknown[]) => callToolJson(...args),
}));

import { claimNextJob, claimSpecificJob, getJobStatus, releaseJobToQueue } from "./jobs.js";

const job = {
  id: "job-12345678",
  project_id: "proj-1",
  task_id: "task-1",
  target_agent_key: "host:test",
  status: "leased",
  runner: "cursor_cli",
  local_directory: "/tmp/ws",
  prompt: "do it",
};

describe("claim and release", () => {
  beforeEach(() => {
    callToolJson.mockReset();
    resetProviderPacing();
  });

  it("returns null and still syncs cooldowns when the claim has no job", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    callToolJson.mockResolvedValue({
      job: null,
      cooldowns: [{ runner: "cursor_cli", cooldown_until: until }],
    });
    await expect(claimNextJob({} as never, "agent-1")).resolves.toBeNull();
    expect(getCooldownUntil("cursor_cli")).not.toBeNull();
    expect(callToolJson).toHaveBeenCalledWith(expect.anything(), "claimNextAgentJob", {
      agentKey: "agent-1",
    });
  });

  it("hydrates missing optional claim fields to null", async () => {
    callToolJson.mockResolvedValue({ job });
    const bundle = await claimSpecificJob({} as never, "agent-1", job.id);
    expect(bundle).toMatchObject({
      job,
      taskWorkspace: null,
      repository: null,
      managedWorkspace: null,
      gitCredentials: null,
      modelGateway: null,
      delegation: null,
    });
  });

  it("propagates a claim tool failure", async () => {
    callToolJson.mockRejectedValue(new Error("claim down"));
    await expect(claimNextJob({} as never, "agent-1")).rejects.toThrow("claim down");
  });

  it("falls back to failing the job when release is not available", async () => {
    callToolJson.mockImplementation(async (_client: unknown, name: string) => {
      if (name === "releaseAgentJob") throw new Error("unknown tool");
      return {};
    });
    await releaseJobToQueue({} as never, job.id, "agent-1");
    expect(callToolJson).toHaveBeenCalledWith(
      expect.anything(),
      "completeAgentJob",
      expect.objectContaining({
        jobId: job.id,
        status: "failed",
        updateTask: false,
        error: "No runner available — all models in cooldown",
      }),
    );
  });

  it("surfaces the complete error when release and the fallback both fail", async () => {
    callToolJson.mockImplementation(async (_client: unknown, name: string) => {
      if (name === "releaseAgentJob") throw new Error("unknown tool");
      throw new Error("complete down");
    });
    await expect(releaseJobToQueue({} as never, job.id, "agent-1")).rejects.toThrow(
      "complete down",
    );
  });

  it("reads job status and treats lookup failures as unknown", async () => {
    callToolJson.mockResolvedValueOnce({ job: { status: "paused" } });
    await expect(getJobStatus({} as never, job.id)).resolves.toBe("paused");

    callToolJson.mockResolvedValueOnce({ job: {} });
    await expect(getJobStatus({} as never, job.id)).resolves.toBeNull();

    callToolJson.mockRejectedValueOnce(new Error("offline"));
    await expect(getJobStatus({} as never, job.id)).resolves.toBeNull();
  });
});
