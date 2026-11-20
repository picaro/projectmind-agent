import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** `node run` exits 4 when another `node run` already uses this state directory. */
export const NODE_EXIT_ALREADY_RUNNING = 4;

/** `node run` exits 5 when the saved pairing is missing or unusable: retrying cannot fix it. */
export const NODE_EXIT_NEEDS_PAIRING = 5;

/** Set by the supervisor so `node run` stops when its parent agent dies. */
export const SUPERVISOR_PID_ENV = "IMEMORY_PERSONAL_NODE_SUPERVISOR_PID";

/** Boot times from two reads of os.uptime() differ by rounding; a reboot differs by far more. */
const BOOT_TOLERANCE_MS = 120_000;
/** A lock that cannot be parsed yet may still be in the middle of being written. */
const UNREADABLE_GRACE_MS = 5_000;
/** A takeover guard older than this was left by a runner that died mid-takeover. */
const GUARD_STALE_MS = 10_000;
const ATTEMPTS = 40;

export function runLockPath(stateDir: string): string {
  return path.join(stateDir, "run.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Linux's boot id does not move when the wall clock does; other systems use the boot time. */
function currentBootId(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

export type RunLock = { release: () => void };

export type RunLockDeps = {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Epoch ms when this computer booted. */
  bootedAt?: () => number;
  bootId?: () => string | null;
  now?: () => number;
};

type Owner = { pid: number; bootedAt: number; bootId?: string };

function parseOwner(text: string): Owner | null {
  try {
    const value = JSON.parse(text) as Partial<Owner>;
    if (Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && Number.isFinite(value.bootedAt)) {
      return {
        pid: value.pid as number,
        bootedAt: value.bootedAt as number,
        ...(typeof value.bootId === "string" ? { bootId: value.bootId } : {}),
      };
    }
  } catch {
    // Not ours, or half written.
  }
  return null;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * One `node run` per state directory. Two runners would share a device token,
 * apply the same commands twice and race on the state file.
 *
 * The lock is created whole (a temp file hard-linked into place, which fails if
 * one exists). A lock is stale when its process is gone or it was written before
 * this boot (the pid may now belong to something else). Only the runner holding the
 * takeover guard may delete a stale lock, so any number of runners still get one winner.
 */
export function acquireRunLock(stateDir: string, deps: RunLockDeps = {}): RunLock | { heldBy: number } {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const bootedAt = deps.bootedAt ?? (() => Date.now() - os.uptime() * 1000);
  const bootId = (deps.bootId ?? currentBootId)();
  const file = runLockPath(stateDir);
  const guard = `${file}.takeover`;
  const mine = JSON.stringify({
    pid,
    bootedAt: Math.round(bootedAt()),
    ...(bootId ? { bootId } : {}),
  });

  let lastHolder = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const temp = `${file}.${pid}.${randomUUID()}`;
    writeFileSync(temp, mine, { mode: 0o600 });
    try {
      linkSync(temp, file);
      return {
        release: () => {
          if (readText(file) === mine) {
            try {
              unlinkSync(file);
            } catch {
              // Already gone.
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Nothing to clean.
      }
    }

    const seen = readText(file);
    if (seen === null) continue;
    const owner = parseOwner(seen);
    if (owner) {
      lastHolder = owner.pid;
      const sameBoot =
        owner.bootId && bootId
          ? owner.bootId === bootId
          : Math.abs(owner.bootedAt - bootedAt()) <= BOOT_TOLERANCE_MS;
      if (owner.pid !== pid && sameBoot && isAlive(owner.pid)) return { heldBy: owner.pid };
    } else {
      let age = Number.POSITIVE_INFINITY;
      try {
        age = now() - statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (age < UNREADABLE_GRACE_MS) return { heldBy: 0 };
    }

    // Stale. The guard lets one runner delete it, and only if it is still the lock we judged.
    try {
      mkdirSync(guard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmdirSync(guard);
      } catch {
        // Released meanwhile.
      }
      sleepSync(25);
      continue;
    }
    try {
      if (readText(file) === seen) unlinkSync(file);
    } catch {
      // Already gone.
    } finally {
      try {
        rmdirSync(guard);
      } catch {
        // Removed as stale by another runner.
      }
    }
  }
  return { heldBy: lastHolder };
}
