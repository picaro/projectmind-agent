import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CONTAINER_INSTANCE_FORMAT, createDockerExecutor, type DockerClient } from "./docker.js";
import { DEPLOY_RECEIPT_FORMAT, deployReceiptLabels } from "./deploy-replay.js";
import { RECOVERY_CONTAINER_OBSERVATION_FORMAT } from "./runtime-observation.js";
import { buildHeartbeat } from "./heartbeat.js";
const ID = "550e8400-e29b-41d4-a716-446655440041",
  SOURCE = "550e8400-e29b-41d4-a716-446655440042";
const DEPLOYMENT = "550e8400-e29b-41d4-a716-446655440043",
  INSTANCE = "a".repeat(64);
const IMAGE = `registry.example.test/team/app@sha256:${"b".repeat(64)}`,
  CONFIG = `sha256:${"c".repeat(64)}`;
const fence = {
  protocol: "native-restart-v1",
  containerId: INSTANCE,
  receiptCommandId: SOURCE,
  imageConfigDigest: CONFIG,
  restartCount: 2,
  failure: "unhealthy",
};
const payload = {
  commandId: ID,
  deploymentId: DEPLOYMENT,
  revision: "same-artifact",
  imageDigest: IMAGE,
  declaredPlatform: "linux/amd64",
  containerPort: 3000,
  commandAdmission: "v2",
  commandExecutionSession: "v1",
  nativeRestartFence: fence,
};
const command = { id: ID, deploymentId: DEPLOYMENT, type: "deploy", payload };
function snapshot(patch: Record<string, unknown> = {}) {
  return {
    status: "running",
    healthStatus: "unhealthy",
    imageReference: IMAGE,
    imageConfigDigest: CONFIG,
    recovery: {
      protocol: "docker-recovery-v1",
      containerId: INSTANCE,
      receiptCommandId: SOURCE,
      restartPolicy: "no",
      maximumRetryCount: 0,
      restartCount: 2,
    },
    ...patch,
  };
}
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});
function client(
  output: () => string,
  options: { instance?: string; replay?: boolean; inspectFails?: boolean } = {},
) {
  return {
    run: vi.fn<DockerClient["run"]>(async (args) => {
      if (args[0] === "inspect" && args[2] === DEPLOY_RECEIPT_FORMAT)
        return {
          exitCode: 0,
          stdout: options.replay
            ? `${ID}|${deployReceiptLabels(payload)[1]!.split("=")[1]}|${IMAGE}|running`
            : "old|old|old|running",
          stderr: "",
        };
      if (args[0] === "inspect" && args[2] === CONTAINER_INSTANCE_FORMAT)
        return { exitCode: 0, stdout: options.instance ?? INSTANCE, stderr: "" };
      if (args[0] === "inspect" && args[2] === RECOVERY_CONTAINER_OBSERVATION_FORMAT)
        return {
          exitCode: options.inspectFails ? 1 : 0,
          stdout: output(),
          stderr: "private daemon error",
        };
      if (args[0] === "manifest")
        return {
          exitCode: 0,
          stdout: JSON.stringify({ platform: { os: "linux", architecture: "amd64" } }),
          stderr: "",
        };
      return { exitCode: 0, stdout: args[0] === "inspect" ? "running" : "", stderr: "" };
    }),
  };
}
it.each([
  null,
  {},
  { ...fence, protocol: "future" },
  { ...fence, containerId: "short" },
  { ...fence, receiptCommandId: ID },
  { ...fence, receiptCommandId: "unknown" },
  { ...fence, imageConfigDigest: IMAGE },
  { ...fence, restartCount: -1 },
  { ...fence, restartCount: 1.2 },
  { ...fence, restartCount: 1000001 },
  { ...fence, failure: "healthy" },
  { ...fence, failure: ["unhealthy"] },
  { ...fence, token: "never-log" },
])("rejects malformed present fence before Docker access: %j", async (nativeRestartFence) => {
  const docker = client(() => JSON.stringify(snapshot()));
  const result = await createDockerExecutor({ client: docker, arch: "amd64" }).apply({
    ...command,
    payload: { ...payload, nativeRestartFence },
  });
  expect(result.outcome).toBe("failed");
  expect(docker.run).not.toHaveBeenCalled();
  expect(result.log).not.toContain("never-log");
});
it.each([
  { imageReference: IMAGE.replace("/app@", "/other@") },
  { imageConfigDigest: `sha256:${"d".repeat(64)}` },
  { healthStatus: "healthy" },
  { status: "exited" },
  { status: "restarting" },
  { recovery: null },
  ...[
    { containerId: "d".repeat(64) },
    { receiptCommandId: ID },
    { restartPolicy: "always" },
    { restartPolicy: "on-failure", maximumRetryCount: 3 },
    { restartCount: 3 },
    { token: "never-log" },
  ].map((patch) => ({ recovery: { ...snapshot().recovery, ...patch } })),
])("preserves the current container when native state changed: %j", async (patch) => {
  const docker = client(() => JSON.stringify(snapshot(patch)));
  const result = await createDockerExecutor({ client: docker, arch: "amd64" }).apply(command);
  expect(result.outcome).toBe("failed");
  expect(docker.run.mock.calls.some(([args]) => ["rm", "run"].includes(args[0]!))).toBe(false);
  expect(result.log).not.toContain("never-log");
});
it.each(["unhealthy", "crashed"])(
  "rechecks after final admission and removes only the expected %s instance",
  async (failure) => {
    root = await mkdtemp(path.join(tmpdir(), "native-restart-fence-"));
    const events: string[] = [];
    const docker = client(() => {
      events.push("native-inspect");
      return JSON.stringify(snapshot({ status: failure === "crashed" ? "exited" : "running" }));
    });
    const result = await createDockerExecutor({
      client: docker,
      arch: "amd64",
      envFileRoot: root,
      redeemEnv: async () => {
        events.push("redeem");
        return {};
      },
    }).apply(
      {
        ...command,
        payload: {
          ...payload,
          nativeRestartFence: { ...fence, failure },
          environmentSecretRef: `hosting-env:${SOURCE}:runtime`,
        },
      },
      {
        onPhase: async (phase) => {
          events.push(phase);
        },
      },
    );
    expect(result.outcome, result.log).toBe("applied");
    expect(events.indexOf("redeem")).toBeLessThan(events.indexOf("starting"));
    expect(events.indexOf("starting")).toBeLessThan(events.indexOf("native-inspect"));
    expect(docker.run).toHaveBeenCalledWith(["rm", "-f", INSTANCE], expect.anything());
  },
);
it("detects provider ownership changing during the server admission hook", async () => {
  let current = snapshot();
  const docker = client(() => JSON.stringify(current));
  const result = await createDockerExecutor({ client: docker, arch: "amd64" }).apply(command, {
    onPhase: async (phase) => {
      if (phase === "starting")
        current = snapshot({ recovery: { ...current.recovery, restartPolicy: "always" } });
    },
  });
  expect(result.outcome).toBe("failed");
  expect(docker.run.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
});
it.each([{ instance: "d".repeat(64) }, { inspectFails: true }])(
  "rejects captured-instance mismatch or unreadable native policy %j",
  async (options) => {
    const docker = client(() => JSON.stringify(snapshot()), options);
    expect(
      (await createDockerExecutor({ client: docker, arch: "amd64" }).apply(command)).outcome,
    ).toBe("failed");
    expect(docker.run.mock.calls.some(([args]) => ["rm", "run"].includes(args[0]!))).toBe(false);
  },
);
it("recovers this command's prior receipt without repeating a restart or consuming a grant", async () => {
  const docker = client(
      () => {
        throw new Error("must not reinspect recovery");
      },
      { replay: true },
    ),
    redeemEnv = vi.fn();
  expect(
    (await createDockerExecutor({ client: docker, arch: "amd64", redeemEnv }).apply(command))
      .outcome,
  ).toBe("applied");
  expect(docker.run).toHaveBeenCalledTimes(1);
  expect(redeemEnv).not.toHaveBeenCalled();
});
it("binds fenced receipt fingerprints while keeping legacy manual receipts unchanged", () => {
  const { nativeRestartFence: _fence, ...manual } = payload;
  expect(deployReceiptLabels(manual)[1]).toBe(
    "io.projectmind.deploy-spec=74622b0bd64ace92193193e2ac95f72c666b77d5228093d1850b736d76d00211",
  );
  const changed = { ...payload, nativeRestartFence: { ...fence, restartCount: 3 } };
  expect(deployReceiptLabels(changed)[1]).not.toBe(deployReceiptLabels(payload)[1]);
  expect(
    buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }).capabilities
      .nativeRestartFenceV1,
  ).toBe(true);
});
