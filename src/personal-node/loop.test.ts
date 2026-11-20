import { buildReportFromSpec, parseBuildReport, type PersonalBuildReport } from "./build-report.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControlPlaneClosedError,
  ControlPlaneRequestError,
  PersonalNodeClient,
  type PersonalNodeApi,
  type CommandAdmissionReceipt,
} from "./client.js";
import { buildHeartbeat } from "./heartbeat.js";
import { runAgentLoop } from "./loop.js";
import { readState, rememberCompletedCommand, writeState } from "./state.js";
import type { AgentCommand, CommandExecutor, HeartbeatReport } from "./types.js";

const NODE = "550e8400-e29b-41d4-a716-446655440010";
const SESSION = "550e8400-e29b-41d4-a716-446655440011";

class FakeClient implements PersonalNodeApi {
  heartbeats: HeartbeatReport[] = [];
  acks: Array<{ id: string; outcome: string; phase?: string; log?: string }> = [];
  commands: AgentCommand[] = [];
  failHeartbeat: number | null = null;
  failList: number | null = null;
  failAckId: string | null = null;

  async heartbeat(_nodeId: string, body: HeartbeatReport): Promise<void> {
    this.heartbeats.push(body);
    if (this.failHeartbeat) throw new ControlPlaneClosedError(this.failHeartbeat);
  }

  async listCommands(): Promise<AgentCommand[]> {
    if (this.failList) throw new ControlPlaneClosedError(this.failList);
    return this.commands;
  }

  async fetchTunnelConnector(): Promise<{
    configured: boolean;
    token: string | null;
    reason: string | null;
  }> {
    return { configured: false, token: null, reason: "tunnel_not_configured" };
  }

  async redeemEnv(): Promise<Record<string, string>> {
    return {};
  }

  async redeemGit(): Promise<{ username: string; token: string }> {
    return { username: "git", token: "unused-token-value" };
  }

  async ack(
    _nodeId: string,
    commandId: string,
    body: {
      outcome: "ack" | "applied" | "failed" | "progress";
      log?: string;
      phase?: string;
      buildReport?: PersonalBuildReport;
      executionSessionId?: string;
    },
  ): Promise<void | CommandAdmissionReceipt> {
    if (this.failAckId === commandId && body.outcome === "ack") {
      throw new ControlPlaneClosedError(403);
    }
    this.acks.push({ id: commandId, outcome: body.outcome, phase: body.phase, log: body.log });
  }
}

describe("runAgentLoop", () => {
  let dir = "";
  const sleep = vi.fn(async () => undefined);

  afterEach(async () => {
    sleep.mockClear();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function paired(completed: string[] = []): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "pna-loop-"));
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: "pnd_test_token_value",
      completedCommandIds: completed,
    });
    return dir;
  }

  it("skips a command id that was already completed", async () => {
    const stateDir = await paired(["cmd-done"]);
    const client = new FakeClient();
    client.commands = [
      { id: "cmd-done", deploymentId: "dep-1", type: "stop", payload: { revision: "1" } },
    ];
    const apply = vi.fn(async () => ({ outcome: "applied" as const, publicUrl: null, log: "ok" }));
    const executor: CommandExecutor = { apply };
    const result = await runAgentLoop({
      client,
      executor,
      stateDir,
      nodeId: NODE,
      heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
      maxCycles: 1,
      sleep,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(client.acks).toEqual([]);
    expect(result.skipped).toEqual(["cmd-done"]);
    expect(result.applied).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["applied", "failed"] as const)(
    "replays a lost %s ACK after restart without executing again",
    async (outcome) => {
      const stateDir = await paired();
      const client = new FakeClient();
      client.commands = [{ id: "cmd-lost", deploymentId: "dep-lost", type: "deploy", payload: {} }];
      const realAck = client.ack.bind(client);
      client.ack = async (nodeId, id, body) => {
        if (body.outcome === outcome) throw new Error("network disconnected");
        return realAck(nodeId, id, body);
      };
      const apply = vi.fn(async () => ({ outcome, publicUrl: null, log: "secret-do-not-persist" }));
      const args = {
        client,
        executor: { apply },
        stateDir,
        nodeId: NODE,
        maxCycles: 1,
        heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
        sleep,
      };
      await expect(runAgentLoop(args)).rejects.toThrow("network disconnected");
      const stored = await readState(stateDir);
      expect(stored?.pendingCommandCompletions).toEqual([{ commandId: "cmd-lost", outcome }]);
      expect(stored?.completedCommandIds).toContain("cmd-lost");
      expect(stored?.knownDeploymentIds).toContain("dep-lost");
      expect(JSON.stringify(stored)).not.toContain("secret-do-not-persist");
      const reconnected = new FakeClient();
      reconnected.commands = client.commands;
      const result = await runAgentLoop({ ...args, client: reconnected });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(reconnected.acks).toEqual([expect.objectContaining({ id: "cmd-lost", outcome })]);
      expect(result.skipped).toEqual(["cmd-lost"]);
      expect((await readState(stateDir))?.pendingCommandCompletions).toEqual([]);
    },
  );

  it.each([false, true])(
    "replays bounded build metadata after interruption with session mode %s without rebuilding",
    async (owned) => {
      const stateDir = await paired();
      const id = "660e8400-e29b-41d4-a716-446655440099";
      const report = buildReportFromSpec({
        schemaVersion: 1,
        kind: "personal-docker-build",
        source: {
          repositoryUrl: "https://github.com/acme/private-source",
          requestedRef: "private-branch",
          resolvedCommit: null,
          contextDirectory: ".",
        },
        builder: {
          requestedStrategy: "railpack",
          actualStrategy: "generated_dockerfile",
          dockerfile: "pm.Dockerfile",
          dockerfileSha256: "ab".repeat(32),
        },
        target: { platform: "linux/amd64", runtimePort: 3000 },
        inputs: { permittedBuildArgumentNames: [], buildSecretNames: [], privateSource: false },
        artifact: {
          localImageConfigDigest: `sha256:${"cd".repeat(32)}`,
          ociManifestReference: null,
        },
        logs: { commandId: id },
      })!;
      const client = Object.assign(new FakeClient(), { executionSessionId: SESSION });
      client.commands = [
        {
          id,
          deploymentId: "dep-build",
          type: "deploy",
          payload: owned ? { commandAdmission: "v2" } : {},
        },
      ];
      const original = client.ack.bind(client);
      client.ack = async (node, command, body) => {
        if (body.outcome === "ack" && owned) return { admitted: true, executionSessionId: SESSION };
        if (body.outcome === "applied") throw new Error("metadata response lost");
        return original(node, command, body);
      };
      const apply = vi.fn(async () => ({
        outcome: "applied" as const,
        publicUrl: null,
        log: "do-not-persist-build-secret",
        buildReport: report,
      }));
      const args = {
        client,
        executor: { apply },
        stateDir,
        nodeId: NODE,
        maxCycles: 1,
        heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
        sleep,
      };
      await expect(runAgentLoop(args)).rejects.toThrow("metadata response lost");
      const pending = (await readState(stateDir))!.pendingCommandCompletions![0];
      expect(pending.buildReport).toEqual(report);
      expect(pending.executionSessionId).toBe(owned ? SESSION : undefined);
      expect(JSON.stringify(pending)).not.toMatch(/private-source|private-branch|do-not-persist/);
      const next = Object.assign(new FakeClient(), {
        executionSessionId: "550e8400-e29b-41d4-a716-446655440012",
      });
      next.commands = client.commands;
      const ack = next.ack.bind(next);
      next.ack = async (node, command, body) => {
        expect(body.buildReport).toEqual(report);
        expect(body.executionSessionId).toBe(owned ? SESSION : undefined);
        return ack(node, command, body);
      };
      await runAgentLoop({ ...args, client: next });
      expect(apply).toHaveBeenCalledTimes(1);
      expect((await readState(stateDir))!.pendingCommandCompletions).toEqual([]);
      const loaded = (await readState(stateDir))!;
      await writeState(stateDir, {
        ...loaded,
        pendingCommandCompletions: [
          {
            ...pending,
            buildReport: {
              ...report,
              values: { TOKEN: "raw-diagnostic-secret" },
            } as PersonalBuildReport,
          },
        ],
      });
      const sanitized = (await readState(stateDir))!.pendingCommandCompletions![0];
      expect(sanitized.outcome).toBe("applied");
      expect(sanitized.buildReport).toBeUndefined();
      expect(JSON.stringify(sanitized)).not.toContain("raw-diagnostic-secret");
      expect(parseBuildReport({ ...report, values: { TOKEN: "secret" } })).toBeNull();
      expect(parseBuildReport({ ...report, schemaVersion: 2 })).toBeNull();
    },
  );

  it.each([404, 503, 403])(
    "handles receipt replay HTTP %s before accepting new commands",
    async (status) => {
      const stateDir = await paired();
      await rememberCompletedCommand(stateDir, "old-cmd", "failed");
      const calls: string[] = [];
      const client = new PersonalNodeClient({
        server: "https://control.example.test",
        token: "pnd_test_token_value",
        fetchImpl: async (url) => {
          calls.push(url);
          if (url.endsWith("/ack")) return new Response("pnd_test_token_value", { status });
          if (url.endsWith("/commands")) return new Response(JSON.stringify({ commands: [] }));
          return new Response("{}");
        },
      });
      const args = {
        client,
        stateDir,
        nodeId: NODE,
        executor: { apply: vi.fn() },
        maxCycles: 1,
        heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
        sleep,
      };
      if (status === 503)
        await expect(runAgentLoop(args)).rejects.toBeInstanceOf(ControlPlaneRequestError);
      else {
        const result = await runAgentLoop(args);
        expect(result.stoppedReason).toBe(status === 403 ? "revoked" : "completed_cycles");
      }
      expect(calls.some((url) => url.endsWith("/commands"))).toBe(status === 404);
      expect((await readState(stateDir))?.pendingCommandCompletions).toHaveLength(
        status === 404 ? 0 : 1,
      );
      expect(args.executor.apply).not.toHaveBeenCalled();
    },
  );

  it("replays a receipt even when the server no longer lists the completed command", async () => {
    const stateDir = await paired();
    await rememberCompletedCommand(stateDir, "accepted-before-disconnect", "applied");
    const client = new FakeClient();
    await runAgentLoop({
      client,
      stateDir,
      nodeId: NODE,
      executor: { apply: vi.fn() },
      maxCycles: 1,
      heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
      sleep,
    });
    expect(client.acks).toEqual([
      expect.objectContaining({ id: "accepted-before-disconnect", outcome: "applied" }),
    ]);
    expect((await readState(stateDir))?.pendingCommandCompletions).toEqual([]);
  });

  it("fails an unknown command type instead of leaving it queued", async () => {
    const stateDir = await paired();
    const client = new FakeClient();
    client.commands = [
      { id: "cmd-old", deploymentId: "dep-1", type: "rebuild_image", payload: {} },
    ];
    const apply = vi.fn(async () => ({ outcome: "applied" as const, publicUrl: null, log: "ok" }));
    const result = await runAgentLoop({
      client,
      executor: { apply },
      stateDir,
      nodeId: NODE,
      heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
      maxCycles: 1,
      sleep,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(result.applied).toEqual(["cmd-old"]);
    expect(client.acks).toEqual([
      expect.objectContaining({
        id: "cmd-old",
        outcome: "failed",
        log: expect.stringContaining("does not understand this command"),
      }),
    ]);
    expect(client.acks[0]?.log).toContain("projectmind-agent@latest");
    expect(client.acks[0]?.log).not.toMatch(/cloudflared|heartbeat/i);
  });

  it("reports deploy phases while the command is running", async () => {
    const stateDir = await paired();
    const client = new FakeClient();
    client.commands = [{ id: "cmd-build", deploymentId: "dep-1", type: "deploy", payload: {} }];
    const apply = vi.fn(
      async (_command: AgentCommand, hooks?: { onPhase?: (phase: string) => Promise<void> }) => {
        await hooks?.onPhase?.("cloning");
        await hooks?.onPhase?.("building");
        await hooks?.onPhase?.("starting");
        return { outcome: "applied" as const, publicUrl: null, log: "container started" };
      },
    );
    await runAgentLoop({
      client,
      executor: { apply },
      stateDir,
      nodeId: NODE,
      heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
      maxCycles: 1,
      sleep,
    });
    expect(client.acks.map((ack) => ack.outcome)).toEqual([
      "ack",
      "progress",
      "progress",
      "progress",
      "applied",
    ]);
    expect(client.acks.map((ack) => ack.phase)).toEqual([
      undefined,
      "cloning",
      "building",
      "starting",
      undefined,
    ]);
  });

  it("stops the loop when heartbeat is rejected", async () => {
    const stateDir = await paired();
    const client = new FakeClient();
    client.failHeartbeat = 401;
    client.commands = [{ id: "cmd-1", deploymentId: "dep-1", type: "stop", payload: {} }];
    const apply = vi.fn(async () => ({ outcome: "applied" as const, publicUrl: null, log: "ok" }));
    const result = await runAgentLoop({
      client,
      executor: { apply },
      stateDir,
      nodeId: NODE,
      heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
      maxCycles: 3,
      sleep,
    });
    expect(result.stoppedReason).toBe("revoked");
    expect(apply).not.toHaveBeenCalled();
    expect(client.heartbeats).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not apply later commands after a 403", async () => {
    const stateDir = await paired();
    const client = new FakeClient();
    client.failAckId = "cmd-2";
    client.commands = [
      { id: "cmd-1", deploymentId: "dep-1", type: "stop", payload: {} },
      { id: "cmd-2", deploymentId: "dep-1", type: "remove", payload: { preserveVolumes: true } },
    ];
    const apply = vi.fn(async (command: AgentCommand) => {
      expect(command.id).toBe("cmd-1");
      return { outcome: "applied" as const, publicUrl: null, log: "ok" };
    });
    const result = await runAgentLoop({
      client,
      executor: { apply },
      stateDir,
      nodeId: NODE,
      heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" }),
      maxCycles: 3,
      sleep,
    });
    expect(result.stoppedReason).toBe("revoked");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual(["cmd-1"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops before apply when listing commands is forbidden", async () => {
    const stateDir = await paired();
    const client = new FakeClient();
    client.failList = 403;
    client.commands = [{ id: "cmd-1", deploymentId: "dep-1", type: "stop", payload: {} }];
    const apply = vi.fn(async () => ({ outcome: "applied" as const, publicUrl: null, log: "ok" }));
    const result = await runAgentLoop({
      client,
      executor: { apply },
      stateDir,
      nodeId: NODE,
      heartbeat: buildHeartbeat({ dockerEnabled: false, socketReachable: true, arch: "amd64" }),
      maxCycles: 2,
      sleep,
    });
    expect(result.stoppedReason).toBe("revoked");
    expect(apply).not.toHaveBeenCalled();
  });
});
