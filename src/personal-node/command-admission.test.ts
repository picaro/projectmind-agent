import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandAdmissionDeniedError,
  ControlPlaneClosedError,
  ControlPlaneRequestError,
  PersonalNodeClient,
  type FetchLike,
  type PersonalNodeApi,
} from "./client.js";
import { CONTAINER_INSTANCE_FORMAT, createDockerExecutor, type DockerClient } from "./docker.js";
import { DEPLOY_RECEIPT_FORMAT } from "./deploy-replay.js";
import { buildHeartbeat } from "./heartbeat.js";
import { runAgentLoop } from "./loop.js";
import { readState, writeState } from "./state.js";
import type { AgentCommand, CommandExecutor } from "./types.js";
const NODE = "11111111-1111-4111-8111-111111111111",
  SESSION = "22222222-2222-4222-8222-222222222222";
const CMD = "33333333-3333-4333-8333-333333333333",
  DEPLOY = "44444444-4444-4444-8444-444444444444";
const NEXT = "55555555-5555-4555-8555-555555555555";
describe("command admission protocol", () => {
  it.each([
    [409, '{"error":"command_admission_denied","message":"fixture-secret"}', "denied"],
    [409, '{"error":"another_conflict"}', "request"],
    [409, "not-json: command_admission_denied", "request"],
    [500, '{"error":"command_admission_denied"}', "request"],
    [401, '{"error":"command_admission_denied"}', "closed"],
    [403, '{"error":"command_admission_denied"}', "closed"],
  ] as const)("maps status %s and body %s to %s", async (status, body, kind) => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(body, { status }));
    const client = new PersonalNodeClient({
      server: "https://control.example.test",
      token: "fixture-secret",
      fetchImpl,
    });
    let failure: unknown;
    try {
      await client.ack(NODE, CMD, { outcome: "progress", phase: "starting" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(
      kind === "closed" ? ControlPlaneClosedError : ControlPlaneRequestError,
    );
    expect(failure instanceof CommandAdmissionDeniedError).toBe(kind === "denied");
    expect((failure as Error).message).not.toContain("fixture-secret");
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-projectmind-command-admission"),
    ).toBe("v1");
  });
  it.each([
    "valid",
    "wrong_command",
    "wrong_phase",
    "wrong_protocol",
    "refused",
    "missing",
    "no_phase",
  ])("accepts only a matching positive phase receipt: %s", async (kind) => {
    const admission =
      kind === "missing"
        ? undefined
        : {
            allowed: kind !== "refused",
            protocol: kind === "wrong_protocol" ? "v2" : "v1",
            commandId: kind === "wrong_command" ? NEXT : CMD,
            phase:
              kind === "no_phase" ? undefined : kind === "wrong_phase" ? "pulling" : "starting",
          };
    const client = new PersonalNodeClient({
      server: "https://control.example.test",
      token: "fixture-secret",
      fetchImpl: async () => new Response(JSON.stringify({ admission }), { status: 200 }),
    });
    expect(
      await client.ack(NODE, CMD, {
        outcome: "progress",
        phase: kind === "no_phase" ? undefined : "starting",
      }),
    ).toEqual(kind === "valid" ? { admitted: true } : undefined);
  });
  let root = "";
  it("bounds admission requests without forwarding local timeout policy to the server", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchImpl = vi.fn<FetchLike>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("fixture-secret")));
        }),
    );
    try {
      const client = new PersonalNodeClient({
        server: "https://control.example.test",
        token: "fixture-secret",
        fetchImpl,
      });
      const pending = client.ack(NODE, CMD, {
        outcome: "progress",
        phase: "starting",
        requireAdmission: true,
      });
      controller.abort();
      await expect(pending).rejects.toThrow("Control plane request failed");
      await expect(pending).rejects.not.toThrow("fixture-secret");
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
        "requireAdmission",
      );
    } finally {
      timeout.mockRestore();
    }
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  it.each([
    "ack",
    "starting",
    "transient",
    "required_allowed",
    "required_missing_ack",
    "required_missing_start",
    "required_transient",
    "unsupported",
  ])("handles %s without halting unrelated commands", async (stage) => {
    root = await mkdtemp(path.join(tmpdir(), "command-admission-"));
    await writeState(root, {
      nodeId: NODE,
      sessionId: SESSION,
      deviceToken: "pnd_fixture",
      completedCommandIds: [],
    });
    const required = stage.startsWith("required") || stage === "unsupported";
    const succeeds = stage === "transient" || stage === "required_allowed";
    const commands: AgentCommand[] = [
      {
        id: CMD,
        deploymentId: DEPLOY,
        type: "deploy",
        payload: {
          commandId: CMD,
          deploymentId: DEPLOY,
          revision: "restore",
          imageDigest: `registry.example.test/team/app@sha256:${"12".repeat(32)}`,
          declaredPlatform: "linux/amd64",
          containerPort: 3000,
          environmentSecretRef: `hosting-env:${SESSION}:runtime`,
          ...(required ? { commandAdmission: stage === "unsupported" ? "v3" : "v1" } : {}),
        },
      },
      { id: NEXT, deploymentId: NEXT, type: "fetch_logs", payload: {} },
    ];
    const ack = vi.fn<PersonalNodeApi["ack"]>(async (_node, id, body) => {
      if (id !== CMD) return;
      if (stage === "ack" && body.outcome === "ack") throw new CommandAdmissionDeniedError();
      if (body.outcome === "progress" && body.phase === "starting") {
        if (stage === "starting") throw new CommandAdmissionDeniedError();
        if (stage === "transient" || stage === "required_transient")
          throw new ControlPlaneRequestError(503, "temporary failure");
      }
      if (required && (body.outcome === "ack" || body.outcome === "progress")) {
        if (
          (stage === "required_missing_ack" && body.outcome === "ack") ||
          (stage === "required_missing_start" && body.phase === "starting")
        )
          return;
        return { admitted: true };
      }
    });
    const client: PersonalNodeApi = {
      ack,
      heartbeat: async () => {},
      listCommands: async () => commands,
      fetchTunnelConnector: async () => ({ configured: false, token: null, reason: null }),
      redeemEnv: async () => ({}),
      redeemGit: async () => ({ username: "fixture", token: "fixture" }),
    };
    const run = vi.fn<DockerClient["run"]>(async (args) => {
      const stdout =
        args[0] === "inspect" && args[2] === CONTAINER_INSTANCE_FORMAT
          ? "ab".repeat(32)
          : args[0] === "manifest"
            ? JSON.stringify({ platform: { os: "linux", architecture: "amd64" } })
            : args[0] === "inspect" && args[2] === DEPLOY_RECEIPT_FORMAT
              ? "<no value>|<no value>|old-image|running"
              : "running";
      return { exitCode: 0, stdout, stderr: "" };
    });
    const docker = createDockerExecutor({
      client: { run },
      arch: "amd64",
      envFileRoot: path.join(root, "env"),
      redeemEnv: async () => ({ TOKEN: "fixture-secret" }),
    });
    const applied = vi.fn<CommandExecutor["apply"]>(async (command, hooks) =>
      command.id === CMD
        ? docker.apply(command, hooks)
        : { outcome: "applied", publicUrl: null, log: "unrelated command finished" },
    );
    const result = await runAgentLoop({
      client,
      executor: { apply: applied },
      stateDir: root,
      nodeId: NODE,
      heartbeat: buildHeartbeat({ dockerEnabled: true, socketReachable: true, arch: "amd64" }),
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(result.applied).toEqual([CMD, NEXT]);
    expect(
      ack.mock.calls.filter(
        ([, id, body]) => id === CMD && body.outcome === (succeeds ? "applied" : "failed"),
      ),
    ).toHaveLength(1);
    expect(applied.mock.calls.some(([command]) => command.id === NEXT)).toBe(true);
    expect(run.mock.calls.some(([args]) => args[0] === "rm" || args[0] === "run")).toBe(succeeds);
    if (["ack", "required_missing_ack", "unsupported"].includes(stage))
      expect(run).not.toHaveBeenCalled();
    const state = await readState(root);
    expect(state?.completedCommandIds).toEqual([CMD, NEXT]);
    expect(state?.pendingCommandCompletions).toEqual([]);
    expect(JSON.stringify(ack.mock.calls)).not.toContain("fixture-secret");
  });
  it("advertises refusal handling independently of runtime availability", () => {
    const report = buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" });
    expect(report.capabilities.commandAdmissionV1).toBe(true);
    expect(report.runtimeStatus).toBe("unavailable");
  });
});
