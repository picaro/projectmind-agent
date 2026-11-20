import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTAINER_INSTANCE_FORMAT, createDockerExecutor, type DockerClient } from "./docker.js";
import { DEPLOY_RECEIPT_FORMAT } from "./deploy-replay.js";
import { buildHeartbeat } from "./heartbeat.js";
import { ControlPlaneClosedError } from "./client.js";
const ID = "550e8400-e29b-41d4-a716-446655440021";
const DEPLOYMENT = "550e8400-e29b-41d4-a716-446655440022";
const command = {
  id: ID,
  deploymentId: DEPLOYMENT,
  type: "deploy",
  payload: {
    commandId: ID,
    deploymentId: DEPLOYMENT,
    revision: "pinned",
    imageDigest: `registry.example.test/team/app@sha256:${"12".repeat(32)}`,
    declaredPlatform: "linux/amd64",
    containerPort: 3000,
    environmentSecretRef: "hosting-env:550e8400-e29b-41d4-a716-446655440023:runtime",
  },
};
const manifest = JSON.stringify({ platform: { os: "linux", architecture: "amd64" } });
describe("pinned deploy preparation", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  function docker(events: string[], options: { pullFails?: boolean; platform?: string } = {}) {
    const run = vi.fn<DockerClient["run"]>(async (args) => {
      events.push(args[0]!);
      if (args[0] === "inspect" && args[2] === CONTAINER_INSTANCE_FORMAT)
        return { exitCode: 0, stdout: "ab".repeat(32), stderr: "" };
      if (args[0] === "inspect" && args[2] === DEPLOY_RECEIPT_FORMAT)
        return { exitCode: 0, stdout: "<no value>|<no value>|old-image|running", stderr: "" };
      if (args[0] === "manifest")
        return { exitCode: 0, stdout: options.platform ?? manifest, stderr: "" };
      if (args[0] === "pull" && options.pullFails)
        return { exitCode: 1, stdout: "", stderr: "image unavailable" };
      return { exitCode: 0, stdout: args[0] === "inspect" ? "running" : "", stderr: "" };
    });
    return { run };
  }
  it("pulls first and prepares a private env file before removing the old container", async () => {
    root = await mkdtemp(path.join(tmpdir(), "deploy-prep-"));
    const events: string[] = [];
    const client = docker(events);
    const original = client.run.getMockImplementation()!;
    client.run.mockImplementation(async (args, options) => {
      if (args[0] === "rm") {
        const file = path.join(root, `${ID}.env`);
        expect(await readFile(file, "utf8")).toContain("APP_TOKEN=fixture-secret");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
      return original(args, options);
    });
    const result = await createDockerExecutor({
      client,
      arch: "amd64",
      envFileRoot: root,
      redeemEnv: async () => {
        events.push("redeem");
        return { APP_TOKEN: "fixture-secret" };
      },
    }).apply(command);
    expect(result.outcome).toBe("applied");
    expect(events.indexOf("pull")).toBeLessThan(events.indexOf("redeem"));
    expect(events.indexOf("redeem")).toBeLessThan(events.indexOf("rm"));
    expect(result.log).not.toContain("fixture-secret");
    await expect(stat(path.join(root, `${ID}.env`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["pull", "platform"])(
    "does not consume a grant or remove a container when %s preflight fails",
    async (failure) => {
      const events: string[] = [];
      const redeemEnv = vi.fn(async () => ({}));
      const client = docker(events, {
        pullFails: failure === "pull",
        platform:
          failure === "platform"
            ? JSON.stringify({ platform: { os: "linux", architecture: "arm64" } })
            : undefined,
      });
      expect(
        (await createDockerExecutor({ client, arch: "amd64", redeemEnv }).apply(command)).outcome,
      ).toBe("failed");
      expect(redeemEnv).not.toHaveBeenCalled();
      expect(events).not.toContain("rm");
      expect(events).not.toContain("run");
    },
  );
  it.each(["missing_loader", "grant_denied", "file_write", "revoked"])(
    "keeps the previous container after %s preparation failure",
    async (failure) => {
      root = await mkdtemp(path.join(tmpdir(), "deploy-prep-fail-"));
      const events: string[] = [];
      const client = docker(events);
      const blockedRoot = path.join(root, "not-a-directory");
      await writeFile(blockedRoot, "fixture");
      const redeemEnv =
        failure === "missing_loader"
          ? undefined
          : async () => {
              if (failure === "grant_denied") throw new Error("environment request denied");
              return { APP_TOKEN: "fixture-secret" };
            };
      const result = await createDockerExecutor({
        client,
        arch: "amd64",
        redeemEnv,
        envFileRoot: failure === "file_write" ? blockedRoot : root,
      }).apply(command, {
        onPhase: async (phase) => {
          if (failure === "revoked" && phase === "starting") throw new ControlPlaneClosedError(403);
        },
      });
      expect(result.outcome).toBe("failed");
      expect(result.log).not.toContain("fixture-secret");
      expect(events).toContain("pull");
      expect(events).not.toContain("rm");
      expect(events).not.toContain("run");
    },
  );
  it("advertises preparation protocol support independently of runtime availability", () => {
    const report = buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" });
    expect(report.capabilities.pinnedDeployPreparation).toBe(true);
    expect(report.runtimeStatus).toBe("unavailable");
  });
});
