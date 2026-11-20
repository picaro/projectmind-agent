import { describe, expect, it, vi } from "vitest";
import {
  CONTAINER_INSTANCE_FORMAT,
  assertSafeDockerArgs,
  createDockerExecutor,
  planRun,
  type DockerClient,
} from "./docker.js";
import { DEPLOY_RECEIPT_FORMAT, deployReceiptLabels } from "./deploy-replay.js";
const ID = "550e8400-e29b-41d4-a716-446655440011";
const DEPLOYMENT = "550e8400-e29b-41d4-a716-446655440002";
const IMAGE = `registry.example.test/team/app@sha256:${"12".repeat(32)}`;
const payload = {
  commandId: ID,
  deploymentId: DEPLOYMENT,
  revision: "revision",
  imageDigest: IMAGE,
  declaredPlatform: "linux/amd64",
  containerPort: 3000,
  environmentSecretRef: "hosting-env:550e8400-e29b-41d4-a716-446655440003:runtime",
};
const command = { id: ID, deploymentId: DEPLOYMENT, type: "deploy", payload };
function receipt(state = "running", spec = payload) {
  const labels = deployReceiptLabels(spec);
  return `${ID}|${labels[1]!.split("=")[1]}|${IMAGE}|${state}`;
}
function docker(output: string, exitCode = 0, stderr = "") {
  const run = vi.fn<DockerClient["run"]>(async () => ({ exitCode, stdout: output, stderr }));
  return { run };
}
describe("pinned deploy replay identity", () => {
  it("recovers a container created before completion persistence without replacing it or redeeming a used grant", async () => {
    let saved = "<no value>|<no value>|old-image|running";
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push(args);
        if (args[0] === "inspect" && args[2] === CONTAINER_INSTANCE_FORMAT)
          return { exitCode: 0, stdout: "ab".repeat(32), stderr: "" };
        if (args[0] === "inspect" && args[2] === DEPLOY_RECEIPT_FORMAT)
          return { exitCode: 0, stdout: saved, stderr: "" };
        if (args[0] === "manifest")
          return {
            exitCode: 0,
            stdout: JSON.stringify({ platform: { os: "linux", architecture: "amd64" } }),
            stderr: "",
          };
        if (args[0] === "run") {
          const labels = args.filter((_, index) => args[index - 1] === "--label");
          saved = `${ID}|${labels[1]!.split("=")[1]}|${args.at(-1)}|running`;
        }
        if (args[0] === "inspect") throw new Error("interrupted after container creation");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    let redeemed = false;
    const redeemEnv = vi.fn(async () => {
      if (redeemed) throw new Error("one-time grant was already consumed");
      redeemed = true;
      return {};
    });
    const executor = () => createDockerExecutor({ client, arch: "amd64", redeemEnv });
    expect((await executor().apply(command)).outcome).toBe("failed");
    expect((await executor().apply(command)).outcome).toBe("applied");
    expect(calls.filter((args) => args[0] === "run")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "rm")).toHaveLength(1);
    expect(calls.findIndex((args) => args[0] === "pull")).toBeLessThan(
      calls.findIndex((args) => args[0] === "rm"),
    );
    expect(redeemEnv).toHaveBeenCalledTimes(1);
  });
  it("recognizes a prior runtime effect with a new executor before redeeming one-time credentials", async () => {
    const client = docker(receipt());
    const redeemEnv = vi.fn();
    const executor = () => createDockerExecutor({ client, arch: "amd64", redeemEnv });
    expect((await executor().apply(command)).outcome).toBe("applied");
    expect(
      (await executor().apply({ ...command, payload: { ...payload, imageDigest: ` ${IMAGE} ` } }))
        .outcome,
    ).toBe("applied");
    expect(client.run.mock.calls.map(([args]) => args[0])).toEqual(["inspect", "inspect"]);
    expect(redeemEnv).not.toHaveBeenCalled();
    expect(client.run.mock.calls[0]![0][2]).toBe(DEPLOY_RECEIPT_FORMAT);
  });
  it.each(["exited", "paused", "restarting", "created"])(
    "does not restart a previously applied %s container",
    async (state) => {
      const client = docker(receipt(state));
      const result = await createDockerExecutor({ client, arch: "amd64" }).apply(command);
      expect(result).toMatchObject({
        outcome: "failed",
        code: "deploy_replay_stopped",
        publicUrl: null,
      });
      expect(client.run).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects changed command configuration, grant references or image identity without replacement", async () => {
    for (const changed of [
      { ...payload, containerPort: 4000 },
      {
        ...payload,
        environmentSecretRef: "hosting-env:550e8400-e29b-41d4-a716-446655440004:runtime",
      },
      { ...payload, imageDigest: IMAGE.replace("12".repeat(32), "34".repeat(32)) },
    ]) {
      const client = docker(receipt());
      expect(
        (
          await createDockerExecutor({ client, arch: "amd64" }).apply({
            ...command,
            payload: changed,
          })
        ).code,
      ).toBe("deploy_replay_conflict");
      expect(client.run).toHaveBeenCalledTimes(1);
    }
  });
  it("distinguishes a missing container from unavailable or malformed inspection", async () => {
    for (const client of [
      docker("", 1, "dial unix docker.sock: no such file or directory"),
      docker("unexpected secret=never-echo"),
    ]) {
      const result = await createDockerExecutor({ client, arch: "amd64" }).apply(command);
      expect(result.outcome).toBe("failed");
      expect(result.log).not.toContain("never-echo");
      expect(client.run).toHaveBeenCalledTimes(1);
    }
  });
  it("requires matching command/payload identity before inspecting or changing runtime", async () => {
    const client = docker(receipt());
    const result = await createDockerExecutor({ client, arch: "amd64" }).apply({
      ...command,
      payload: { ...payload, commandId: DEPLOYMENT },
    });
    expect(result.code).toBe("invalid_input");
    expect(client.run).not.toHaveBeenCalled();
  });
  it("binds fixed labels to declarative config without exposing grant references", () => {
    const args = planRun({ containerName: `pn-${DEPLOYMENT}`, payload });
    expect(args.filter((arg) => arg === "--label")).toHaveLength(2);
    expect(args.join(" ")).not.toContain(payload.environmentSecretRef);
    expect(args.at(-1)).toBe(IMAGE);
    const injected = [...args];
    injected.splice(-1, 0, "--label", "credential=never-emit");
    expect(() => assertSafeDockerArgs(injected)).toThrow("receipt labels");
    expect(deployReceiptLabels({ ...payload, resourceLimits: { cpu: 1, memoryMb: 512 } })).toEqual(
      deployReceiptLabels({ ...payload, resourceLimits: { memoryMb: 512, cpu: 1 } }),
    );
  });
});
