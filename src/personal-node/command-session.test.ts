import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CommandOwnedElsewhereError, PersonalNodeClient, type FetchLike } from "./client.js";
import { buildHeartbeat } from "./heartbeat.js";
import { runAgentLoop } from "./loop.js";
import { readState, stateFilePath, writeState } from "./state.js";
import type { AgentCommand, CommandExecutor } from "./types.js";
const N = "11111111-1111-4111-8111-111111111111",
  C = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333",
  NEXT = "44444444-4444-4444-8444-444444444444";
const command: AgentCommand = {
  id: C,
  deploymentId: C,
  type: "deploy",
  payload: { commandAdmission: "v2", commandExecutionSession: "v1" },
};
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
async function state() {
  root = await mkdtemp(path.join(tmpdir(), "command-session-"));
  await writeState(root, {
    nodeId: N,
    sessionId: S,
    deviceToken: "pnd_fixture",
    completedCommandIds: [],
  });
  return root;
}
function client(fetchImpl: FetchLike) {
  return new PersonalNodeClient({
    server: "https://control.example.test",
    token: "pnd_fixture",
    fetchImpl,
  });
}
function allow(init?: RequestInit, patch: Record<string, unknown> = {}) {
  const body = JSON.parse(String(init?.body)) as { outcome: string; phase?: string };
  const headers = new Headers(init?.headers);
  return Response.json({
    admission: {
      allowed: true,
      commandId: C,
      protocol: "v2",
      phase: body.outcome === "ack" ? "ack" : body.phase,
      executionSessionId: headers.get("x-projectmind-command-execution-session"),
      ...patch,
    },
  });
}
it.each([
  "valid",
  "missing_session",
  "wrong_session",
  "old_protocol",
  "wrong_command",
  "wrong_phase",
])("requires an exact v2 allow receipt: %s", async (kind) => {
  const fetchImpl = vi.fn<FetchLike>(async (_url, init) =>
    allow(
      init,
      kind === "missing_session"
        ? { executionSessionId: undefined }
        : kind === "wrong_session"
          ? { executionSessionId: S }
          : kind === "old_protocol"
            ? { protocol: "v1" }
            : kind === "wrong_command"
              ? { commandId: NEXT }
              : kind === "wrong_phase"
                ? { phase: "starting" }
                : {},
    ),
  );
  const api = client(fetchImpl);
  const receipt = await api.ack(N, C, {
    outcome: "ack",
    requireAdmission: true,
    admissionProtocol: "v2",
  });
  expect(receipt).toEqual(
    kind === "valid" ? { admitted: true, executionSessionId: api.executionSessionId } : undefined,
  );
  const init = fetchImpl.mock.calls[0]![1]!;
  expect(new Headers(init.headers).get("x-projectmind-command-admission")).toBe("v2");
  expect(JSON.parse(String(init.body))).toEqual({ outcome: "ack" });
});
it("uses distinct process identities and includes ownership on environment redemption", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => Response.json({ env: {} }));
  const a = client(fetchImpl),
    b = client(fetchImpl);
  expect(a.executionSessionId).not.toBe(b.executionSessionId);
  await a.redeemEnv(N, C, "fixture-ref");
  expect(
    new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get(
      "x-projectmind-command-execution-session",
    ),
  ).toBe(a.executionSessionId);
});
it.each(["ack", "starting"])(
  "skips another process's command at %s without recording a false completion",
  async (stage) => {
    const dir = await state();
    const effects: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (url.endsWith("/heartbeat")) return Response.json({});
      if (url.endsWith("/commands"))
        return Response.json({ commands: [command, { ...command, id: NEXT, payload: {} }] });
      const body = JSON.parse(String(init?.body));
      if (url.includes(C) && (stage === "ack" ? body.outcome === "ack" : body.phase === "starting"))
        return Response.json(
          { error: "command_execution_owned_elsewhere", message: "fixture-secret" },
          { status: 409 },
        );
      return url.includes(C) ? allow(init) : Response.json({});
    });
    const executor: CommandExecutor = {
      async apply(cmd, hooks) {
        if (cmd.id === C) await hooks?.onPhase?.("starting");
        effects.push(cmd.id);
        return { outcome: "applied", publicUrl: null, log: "done" };
      },
    };
    const result = await runAgentLoop({
      client: client(fetchImpl),
      executor,
      stateDir: dir,
      nodeId: N,
      heartbeat: buildHeartbeat({ arch: "amd64", dockerEnabled: true, socketReachable: true }),
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(result.skipped).toEqual([C]);
    expect(effects).toEqual([NEXT]);
    const saved = await readState(dir);
    expect(saved?.completedCommandIds).toEqual([NEXT]);
    expect(saved?.pendingCommandCompletions).toEqual([]);
    expect(
      fetchImpl.mock.calls.some(
        ([url, init]) =>
          url.includes(C) && ["failed", "applied"].includes(JSON.parse(String(init?.body)).outcome),
      ),
    ).toBe(false);
  },
);
it.each(["missing_ack", "missing_start", "allowed"])(
  "fails closed before runtime side effects: %s",
  async (stage) => {
    const dir = await state();
    let effect = false;
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (url.endsWith("/heartbeat")) return Response.json({});
      if (url.endsWith("/commands")) return Response.json({ commands: [command] });
      const body = JSON.parse(String(init?.body));
      return allow(
        init,
        (stage === "missing_ack" && body.outcome === "ack") ||
          (stage === "missing_start" && body.phase === "starting")
          ? { executionSessionId: undefined }
          : {},
      );
    });
    await runAgentLoop({
      client: client(fetchImpl),
      executor: {
        async apply(_cmd, hooks) {
          await hooks?.onPhase?.("starting");
          effect = true;
          return { outcome: "applied", publicUrl: null, log: "done" };
        },
      },
      stateDir: dir,
      nodeId: N,
      heartbeat: buildHeartbeat({ arch: "amd64", dockerEnabled: true, socketReachable: true }),
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(effect).toBe(stage === "allowed");
    const completion = fetchImpl.mock.calls
      .filter(([, init]) => init?.body !== undefined)
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => ["applied", "failed"].includes(body.outcome));
    expect(completion?.outcome).toBe(stage === "allowed" ? "applied" : "failed");
  },
);
it("replays an outcome with its original owner after a new client process starts", async () => {
  const dir = await state();
  let completionSession: string | null = null;
  const first = client(async (url, init) => {
    if (url.endsWith("/heartbeat")) return Response.json({});
    if (url.endsWith("/commands")) return Response.json({ commands: [command] });
    const body = JSON.parse(String(init?.body));
    if (body.outcome === "applied") return Response.json({}, { status: 500 });
    return allow(init);
  });
  await expect(
    runAgentLoop({
      client: first,
      executor: {
        async apply() {
          return { outcome: "applied", publicUrl: null, log: "done" };
        },
      },
      stateDir: dir,
      nodeId: N,
      heartbeat: buildHeartbeat({ arch: "amd64", dockerEnabled: true, socketReachable: true }),
      maxCycles: 1,
      sleep: async () => {},
    }),
  ).rejects.toThrow("500");
  expect((await readState(dir))?.pendingCommandCompletions).toEqual([
    {
      commandId: C,
      outcome: "applied",
      admissionProtocol: "v2",
      executionSessionId: first.executionSessionId,
    },
  ]);
  const second = client(async (url, init) => {
    if (url.endsWith("/commands")) return Response.json({ commands: [] });
    if (url.endsWith("/ack")) {
      completionSession = new Headers(init?.headers).get("x-projectmind-command-execution-session");
      expect(new Headers(init?.headers).get("x-projectmind-command-admission")).toBe("v2");
    }
    return Response.json({});
  });
  await runAgentLoop({
    client: second,
    executor: { apply: vi.fn() },
    stateDir: dir,
    nodeId: N,
    heartbeat: buildHeartbeat({ arch: "amd64", dockerEnabled: true, socketReachable: true }),
    maxCycles: 1,
    sleep: async () => {},
  });
  expect(second.executionSessionId).not.toBe(first.executionSessionId);
  expect(completionSession).toBe(first.executionSessionId);
  expect((await readState(dir))?.pendingCommandCompletions).toEqual([]);
});
it.each([
  { admissionProtocol: "v2" },
  { executionSessionId: S },
  { admissionProtocol: "v2", executionSessionId: "invalid" },
  { admissionProtocol: "v3", executionSessionId: S },
])("refuses corrupt durable ownership metadata %j", async (metadata) => {
  const dir = await state();
  const raw = JSON.parse(await readFile(stateFilePath(dir), "utf8"));
  raw.pendingCommandCompletions = [{ commandId: C, outcome: "applied", ...metadata }];
  await writeFile(stateFilePath(dir), JSON.stringify(raw));
  await expect(readState(dir)).rejects.toThrow("outbox is invalid");
});
it("classifies only the exact conflict and advertises v2 without Docker", async () => {
  await expect(
    client(async () =>
      Response.json({ error: "command_execution_owned_elsewhere" }, { status: 409 }),
    ).ack(N, C, { outcome: "ack", admissionProtocol: "v2" }),
  ).rejects.toBeInstanceOf(CommandOwnedElsewhereError);
  expect(
    buildHeartbeat({ arch: "amd64", dockerEnabled: false, socketReachable: false }).capabilities
      .commandAdmissionV2,
  ).toBe(true);
});

it.each([400, 401, 403, 500])(
  "does not treat status %s as another executor's admission refusal",
  async (status) => {
    await expect(
      client(async () =>
        Response.json({ error: "command_execution_owned_elsewhere" }, { status }),
      ).ack(N, C, { outcome: "ack", admissionProtocol: "v2" }),
    ).rejects.not.toBeInstanceOf(CommandOwnedElsewhereError);
  },
);
