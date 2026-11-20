import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  NODE_EXIT_ALREADY_RUNNING,
  NODE_EXIT_NEEDS_PAIRING,
  SUPERVISOR_PID_ENV,
} from "./run-lock.ts";
import {
  NODE_EXIT_REVOKED,
  NodeSupervisor,
  restartDelayMs,
  shouldAutostartNode,
} from "./supervisor.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM") setImmediate(() => this.emit("exit", null));
    return true;
  }
}

function harness(options: { stableMs?: number } = {}) {
  let at = 0;
  const children: FakeChild[] = [];
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const logs: string[] = [];
  const supervisor = new NodeSupervisor({
    spec: { command: "/usr/bin/node", args: ["/agent/cli.cjs", "node", "run"] },
    env: {},
    log: (line) => logs.push(line),
    spawnImpl: (command, args, env) => {
      spawned.push({ command, args, env });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    stableMs: options.stableMs ?? 60_000,
    now: () => at,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  return {
    supervisor,
    children,
    spawned,
    timers,
    logs,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("shouldAutostartNode", () => {
  it("starts only when this computer is paired and autostart is not off", () => {
    const env = { IMEMORY_PERSONAL_NODE_STATE_DIR: "/state" };
    expect(shouldAutostartNode(env, (file) => file === "/state/agent-state.json")).toBe(true);
    expect(shouldAutostartNode(env, () => false)).toBe(false);
    expect(
      shouldAutostartNode({ ...env, IMEMORY_PERSONAL_NODE_AUTOSTART: "0" }, () => true),
    ).toBe(false);
  });
});

describe("restartDelayMs", () => {
  it("doubles from the base and caps", () => {
    expect([1, 2, 3, 4, 10].map((n) => restartDelayMs(n, 2_000, 60_000))).toEqual([
      2_000, 4_000, 8_000, 16_000, 60_000,
    ]);
  });
});

describe("NodeSupervisor", () => {
  it("spawns `node run` and prefixes its output", async () => {
    const h = harness();
    h.supervisor.start();
    expect(h.spawned).toEqual([
      expect.objectContaining({ command: "/usr/bin/node", args: ["/agent/cli.cjs", "node", "run"] }),
    ]);
    h.children[0]?.stdout.write("runtime_status=available tunnel_status=unavailable\npartial");
    h.children[0]?.stdout.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.logs).toEqual([
      "[node] runtime_status=available tunnel_status=unavailable",
      "[node] partial",
    ]);
  });

  it("restarts a crashing child with growing delays and resets after a stable run", () => {
    const h = harness();
    h.supervisor.start();
    h.children[0]?.emit("exit", 1);
    expect(h.timers.map((t) => t.ms)).toEqual([2_000]);
    h.timers[0]?.fn();
    h.children[1]?.emit("exit", 1);
    expect(h.timers.map((t) => t.ms)).toEqual([2_000, 4_000]);
    h.timers[1]?.fn();
    h.advance(120_000);
    h.children[2]?.emit("exit", 1);
    expect(h.timers.map((t) => t.ms)).toEqual([2_000, 4_000, 2_000]);
    expect(h.spawned).toHaveLength(3);
  });

  it("does not restart after the node was revoked", () => {
    const h = harness();
    h.supervisor.start();
    h.children[0]?.emit("exit", NODE_EXIT_REVOKED);
    expect(h.timers).toHaveLength(0);
    expect(h.logs.at(-1)).toContain("node pair --force");
    h.supervisor.start();
    expect(h.spawned).toHaveLength(1);
  });

  it("stop terminates the child and cancels a pending restart", async () => {
    const h = harness();
    h.supervisor.start();
    h.children[0]?.emit("exit", 1);
    h.timers[0]?.fn();
    expect(h.supervisor.running).toBe(true);
    await h.supervisor.stop();
    expect(h.children[1]?.signals).toEqual(["SIGTERM"]);
    expect(h.supervisor.running).toBe(false);
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1);

    const pending = harness();
    pending.supervisor.start();
    pending.children[0]?.emit("exit", 1);
    await pending.supervisor.stop();
    expect(pending.timers[0]?.cleared).toBe(true);
  });

  it("treats a spawn error like an exit", () => {
    const h = harness();
    h.supervisor.start();
    h.children[0]?.emit("error", new Error("ENOENT"));
    expect(h.logs[0]).toBe("[node] could not start: ENOENT");
    expect(h.timers).toHaveLength(1);
  });
});

describe("NodeSupervisor with another runner", () => {
  it("tells the child its parent pid", () => {
    const h = harness();
    h.supervisor.start();
    expect(h.spawned[0]?.env[SUPERVISOR_PID_ENV]).toBe(String(process.pid));
    void h.supervisor.stop(10);
  });

  it("waits for another node run without backing off or repeating the message", () => {
    const h = harness();
    h.supervisor.start();
    h.children[0]?.emit("exit", NODE_EXIT_ALREADY_RUNNING);
    h.timers.at(-1)?.fn();
    h.children[1]?.emit("exit", NODE_EXIT_ALREADY_RUNNING);
    expect(h.timers.map((timer) => timer.ms)).toEqual([15_000, 15_000]);
    expect(h.logs.filter((line) => line.includes("another node run"))).toHaveLength(1);
    h.timers.at(-1)?.fn();
    expect(h.spawned).toHaveLength(3);
    void h.supervisor.stop(10);
  });
});

describe("NodeSupervisor with a broken pairing", () => {
  it("stops instead of restarting when the state needs a new pairing", () => {
    const h = harness();
    h.supervisor.start();
    h.children[0]?.emit("exit", NODE_EXIT_NEEDS_PAIRING);
    expect(h.timers).toHaveLength(0);
    expect(h.logs.at(-1)).toContain("node pair --force");
    h.supervisor.start();
    expect(h.spawned).toHaveLength(1);
  });
});
