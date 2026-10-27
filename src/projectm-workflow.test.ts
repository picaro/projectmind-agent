import { describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildSecretsFile,
  isProjectmWorkflowJob,
  maskOutput,
  runProjectmWorkflowJob,
  secretShellVar,
  type ProjectmWorkflowClaim,
} from "./projectm-workflow.js";

const client = {} as Client;

function workflow(
  stepScript: string,
  secrets: Record<string, string> = {},
): ProjectmWorkflowClaim {
  return {
    workflowRunId: "run-1",
    workflowName: "Publish repo-service",
    jobName: "publish-repo-service",
    repoFullName: "picaro/iremenber",
    commitSha: "0905de4229fc70c0ca82d2caf7b6b36a0b5a93bb",
    branch: "repo-service-0.3.0",
    stepScript,
    secrets,
  };
}

function fakeCall() {
  return vi.fn(
    async (
      _client: unknown,
      _tool: string,
      _args: Record<string, unknown>,
    ) => ({}),
  );
}

describe("projectm workflow jobs on the Mac", () => {
  it("recognizes workflow jobs and names secrets like the control plane", () => {
    expect(isProjectmWorkflowJob({ job_kind: "projectm_workflow" })).toBe(true);
    expect(isProjectmWorkflowJob({ job_kind: "standard" })).toBe(false);
    expect(isProjectmWorkflowJob(null)).toBe(false);
    expect(secretShellVar("github-token")).toBe("PM_SECRET_GITHUB_TOKEN");
    expect(buildSecretsFile({ GITHUB_TOKEN: "a'b" })).toBe(
      "export PM_SECRET_GITHUB_TOKEN='a'\\''b'",
    );
  });

  it("runs the script with its secrets, a private DOCKER_CONFIG, and reports success", async () => {
    const call = fakeCall();
    const script = [
      "set -eo pipefail",
      'test -n "$PM_SECRET_GITHUB_TOKEN"',
      // The secrets file is gone before any step runs.
      'test ! -f "$PWD/.pm-secrets.sh"',
      'case "$DOCKER_CONFIG" in "$PWD"/.docker) ;; *) exit 9 ;; esac',
      'echo "DOCKER_HOST=$DOCKER_HOST"',
    ].join("\n");
    const outcome = await runProjectmWorkflowJob(
      client,
      { id: "job-1" },
      "host:Mac",
      workflow(script, { GITHUB_TOKEN: "registry-token" }),
      {
        call: call as never,
        dockerHost: () => "unix:///tmp/docker.sock",
        log: () => {},
      },
    );
    expect(outcome).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(call).toHaveBeenCalledWith(client, "completeAgentJob", {
      jobId: "job-1",
      agentKey: "host:Mac",
      status: "succeeded",
      resultSummary:
        "Workflow job Publish repo-service (publish-repo-service) completed successfully",
      updateTask: false,
    });
  });

  it("fails with the masked output tail", async () => {
    const call = fakeCall();
    const outcome = await runProjectmWorkflowJob(
      client,
      { id: "job-2" },
      "host:Mac",
      workflow(
        'echo "pushing with $PM_SECRET_GITHUB_TOKEN"; echo "denied" >&2; exit 3',
        {
          GITHUB_TOKEN: "registry-token-value",
        },
      ),
      { call: call as never, dockerHost: () => null, log: () => {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.summary).toContain("failed with exit code 3");
    expect(outcome.summary).toContain("pushing with ***");
    expect(outcome.summary).toContain("denied");
    expect(outcome.summary).not.toContain("registry-token-value");
    expect(call.mock.calls.at(-1)?.[2]).toMatchObject({
      status: "failed",
      jobId: "job-2",
    });
  });

  it("stops a script that runs past its timeout and renews the lease meanwhile", async () => {
    const call = fakeCall();
    const outcome = await runProjectmWorkflowJob(
      client,
      { id: "job-3" },
      "host:Mac",
      workflow("sleep 5"),
      {
        call: call as never,
        dockerHost: () => null,
        timeoutMs: 400,
        leaseRenewMs: 100,
        log: () => {},
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("timed out");
    expect(
      call.mock.calls.some(([, tool]) => tool === "renewAgentJobLease"),
    ).toBe(true);
  });

  it("fails cleanly when the claim has no script", async () => {
    const call = fakeCall();
    const outcome = await runProjectmWorkflowJob(
      client,
      { id: "job-4" },
      "host:Mac",
      null,
      {
        call: call as never,
        log: () => {},
      },
    );
    expect(outcome).toMatchObject({
      status: "failed",
      summary: "Workflow job has no step script",
    });
  });

  it("masks secret values and GitHub token shapes in output", () => {
    expect(
      maskOutput("x ghs_abcdefghijklmnopqrstuvwxyz0123 y secretvalue", {
        A: "secretvalue",
      }),
    ).not.toMatch(/ghs_abcdefghijklmnopqrstuvwxyz0123|secretvalue/);
  });
});
