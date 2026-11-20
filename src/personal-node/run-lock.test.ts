import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireRunLock, runLockPath, type RunLockDeps } from "./run-lock.ts";

const BOOT = 1_700_000_000_000;
const NOW = BOOT + 3_600_000;
const dirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-lock-"));
  dirs.push(dir);
  return dir;
}

function deps(pid: number, overrides: Partial<RunLockDeps> = {}): RunLockDeps {
  return { pid, isAlive: () => true, bootedAt: () => BOOT, now: () => NOW, ...overrides };
}

function owner(dir: string): { pid: number; bootedAt: number } {
  return JSON.parse(readFileSync(runLockPath(dir), "utf8")) as { pid: number; bootedAt: number };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  it("lets one runner hold the state directory and leaves no temp files", () => {
    const dir = stateDir();
    const first = acquireRunLock(dir, deps(100));
    expect("release" in first).toBe(true);
    expect(acquireRunLock(dir, deps(200))).toEqual({ heldBy: 100 });
    if ("release" in first) first.release();
    const second = acquireRunLock(dir, deps(200));
    expect("release" in second).toBe(true);
    expect(owner(dir)).toEqual({ pid: 200, bootedAt: BOOT });
    expect(readdirSync(dir)).toEqual(["run.lock"]);
  });

  it("replaces a lock left by a process that is gone", () => {
    const dir = stateDir();
    writeFileSync(runLockPath(dir), JSON.stringify({ pid: 100, bootedAt: BOOT }));
    const lock = acquireRunLock(dir, deps(200, { isAlive: () => false }));
    expect("release" in lock).toBe(true);
    expect(owner(dir).pid).toBe(200);
  });

  it("replaces a lock from before this boot even when its pid is reused", () => {
    const dir = stateDir();
    writeFileSync(runLockPath(dir), JSON.stringify({ pid: 100, bootedAt: BOOT - 86_400_000 }));
    const lock = acquireRunLock(dir, deps(200, { isAlive: () => true }));
    expect("release" in lock).toBe(true);
    expect(owner(dir).pid).toBe(200);
  });

  it("treats a lock that is still being written as held", () => {
    const dir = stateDir();
    writeFileSync(runLockPath(dir), "");
    expect(acquireRunLock(dir, deps(200, { now: () => Date.now() }))).toEqual({ heldBy: 0 });
  });

  it("replaces an unreadable lock once it is old", () => {
    const dir = stateDir();
    writeFileSync(runLockPath(dir), "100\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(runLockPath(dir), old, old);
    const lock = acquireRunLock(dir, deps(200, { now: () => Date.now() }));
    expect("release" in lock).toBe(true);
  });

  it("lets only one of two runners take over the same stale lock", () => {
    const dir = stateDir();
    writeFileSync(runLockPath(dir), JSON.stringify({ pid: 100, bootedAt: BOOT }));
    const dead = (pid: number) => pid === 100;
    const a = acquireRunLock(dir, deps(200, { isAlive: (pid) => !dead(pid) }));
    const b = acquireRunLock(dir, deps(300, { isAlive: (pid) => !dead(pid) }));
    expect("release" in a).toBe(true);
    expect(b).toEqual({ heldBy: 200 });
  });

  it("does not remove a lock another runner took over", () => {
    const dir = stateDir();
    const lock = acquireRunLock(dir, deps(100));
    writeFileSync(runLockPath(dir), JSON.stringify({ pid: 300, bootedAt: BOOT }));
    if ("release" in lock) lock.release();
    expect(owner(dir).pid).toBe(300);
  });
});
