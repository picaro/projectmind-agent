import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireRunLock, runLockPath } from "./run-lock.ts";

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  it("lets one runner hold the state directory", () => {
    const dir = stateDir();
    const first = acquireRunLock(dir, { pid: 100, isAlive: () => true });
    expect("release" in first).toBe(true);
    expect(acquireRunLock(dir, { pid: 200, isAlive: () => true })).toEqual({ heldBy: 100 });
    if ("release" in first) first.release();
    const second = acquireRunLock(dir, { pid: 200, isAlive: () => true });
    expect("release" in second).toBe(true);
    expect(readFileSync(runLockPath(dir), "utf8").trim()).toBe("200");
  });

  it("replaces a lock left by a process that is gone", () => {
    const dir = stateDir();
    writeFileSync(runLockPath(dir), "100\n");
    const lock = acquireRunLock(dir, { pid: 200, isAlive: () => false });
    expect("release" in lock).toBe(true);
    expect(readFileSync(runLockPath(dir), "utf8").trim()).toBe("200");
  });

  it("does not remove a lock another runner took over", () => {
    const dir = stateDir();
    const lock = acquireRunLock(dir, { pid: 100, isAlive: () => false });
    writeFileSync(runLockPath(dir), "300\n");
    if ("release" in lock) lock.release();
    expect(readFileSync(runLockPath(dir), "utf8").trim()).toBe("300");
  });
});
