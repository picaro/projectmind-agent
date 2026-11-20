import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertSafeDockerArgs,
  CONTAINER_INSTANCE_FORMAT,
  createDockerExecutor,
  type DockerClient,
} from "./docker.js";
import { DEPLOY_RECEIPT_FORMAT } from "./deploy-replay.js";
import { buildHeartbeat } from "./heartbeat.js";
const C = "11111111-1111-4111-8111-111111111111",
  D = "22222222-2222-4222-8222-222222222222";
const OLD = "ab".repeat(32),
  NEW = "cd".repeat(32);
const command = {
  id: C,
  deploymentId: D,
  type: "deploy",
  payload: {
    commandId: C,
    deploymentId: D,
    revision: "fixture",
    imageDigest: `registry.example.test/team/app@sha256:${"12".repeat(32)}`,
    declaredPlatform: "linux/amd64",
    containerPort: 3000,
    environmentSecretRef: `hosting-env:${D}:runtime`,
  },
};
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
async function scenario(
  options: {
    absent?: boolean;
    replaceAtAdmission?: boolean;
    inspectOutput?: string;
    inspectError?: boolean;
    refuse?: boolean;
  } = {},
) {
  root = await mkdtemp(path.join(tmpdir(), "instance-fence-"));
  let current: string | null = options.absent ? null : OLD;
  let starting = false;
  const calls: string[][] = [];
  const events: string[] = [];
  const client: DockerClient = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "manifest")
        return {
          exitCode: 0,
          stdout: JSON.stringify({ platform: { os: "linux", architecture: "amd64" } }),
          stderr: "",
        };
      if (args[0] === "inspect" && args[2] === DEPLOY_RECEIPT_FORMAT)
        return current
          ? { exitCode: 0, stdout: "<no value>|<no value>|old-image|running", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "No such object" };
      if (args[0] === "inspect" && args[2] === CONTAINER_INSTANCE_FORMAT) {
        events.push("capture");
        if (options.inspectError) return { exitCode: 1, stdout: "", stderr: "permission denied" };
        return current
          ? { exitCode: 0, stdout: options.inspectOutput ?? `${current}\n`, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "No such object" };
      }
      if (args[0] === "rm") {
        events.push("remove");
        if (args[2] !== current) return { exitCode: 1, stdout: "", stderr: "No such container" };
        current = null;
      }
      if (args[0] === "run") {
        if (current) return { exitCode: 1, stdout: "", stderr: "container name is already in use" };
        current = NEW;
      }
      return { exitCode: 0, stdout: args[0] === "inspect" ? "running" : "", stderr: "" };
    },
  };
  const result = await createDockerExecutor({
    client,
    arch: "amd64",
    envFileRoot: root,
    redeemEnv: async () => ({ TOKEN: "fixture-secret" }),
  }).apply(command, {
    async onPhase(phase) {
      if (phase !== "starting") return;
      starting = true;
      events.push("admission");
      if (options.refuse) throw new Error("current admission refused");
      if (options.replaceAtAdmission) current = NEW;
    },
  });
  return { result, current, calls, events, starting };
}
it("removes only the captured instance after final admission", async () => {
  const { result, current, calls, events } = await scenario();
  expect(result.outcome).toBe("applied");
  expect(current).toBe(NEW);
  expect(calls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", OLD]]);
  expect(events).toEqual(["capture", "admission", "remove"]);
  expect(calls.flat()).not.toContain("--volumes");
  expect(result.log).not.toContain("fixture-secret");
});
it("a delayed old removal cannot delete a newer instance reusing the name", async () => {
  const { result, current, calls, events } = await scenario({ replaceAtAdmission: true });
  expect(current).toBe(NEW);
  expect(result.outcome).toBe("failed");
  expect(calls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", OLD]]);
  expect(events.indexOf("capture")).toBeLessThan(events.indexOf("admission"));
  expect(calls.some((args) => args[0] === "rm" && args[2] === `pn-${D}`)).toBe(false);
});
it.each([false, true])(
  "skips removal for an absent snapshot, including a later replacement: %s",
  async (replaceAtAdmission) => {
    const { result, current, calls } = await scenario({ absent: true, replaceAtAdmission });
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
    expect(result.outcome).toBe(replaceAtAdmission ? "failed" : "applied");
    expect(current).toBe(NEW);
  },
);
it.each(["", "short-id", `sha256:${OLD}`, `${OLD}\n${NEW}`, `${OLD};rm -rf /`])(
  "refuses uncertain container identity %j before admission or effects",
  async (inspectOutput) => {
    const { result, current, calls, starting } = await scenario({ inspectOutput });
    expect(result).toMatchObject({ outcome: "failed", code: "runtime_instance_invalid" });
    expect(current).toBe(OLD);
    expect(starting).toBe(false);
    expect(calls.some((args) => ["rm", "run"].includes(args[0]!))).toBe(false);
  },
);
it.each(["inspect", "admission"])("keeps the old instance after %s refusal", async (stage) => {
  const { result, current, calls } = await scenario(
    stage === "inspect" ? { inspectError: true } : { refuse: true },
  );
  expect(result.outcome).toBe("failed");
  expect(current).toBe(OLD);
  expect(calls.some((args) => ["rm", "run"].includes(args[0]!))).toBe(false);
});
it("only allows the fixed ID projection and advertises its software capability", () => {
  expect(() =>
    assertSafeDockerArgs(["inspect", "--format", CONTAINER_INSTANCE_FORMAT, `pn-${D}`]),
  ).not.toThrow();
  expect(() =>
    assertSafeDockerArgs(["inspect", "--format", "{{json .Config.Env}}", `pn-${D}`]),
  ).toThrow();
  expect(
    buildHeartbeat({ arch: "amd64", dockerEnabled: false, socketReachable: false }).capabilities
      .pinnedContainerInstanceFencing,
  ).toBe(true);
});
