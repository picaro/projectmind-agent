import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** `node run` exits 4 when another `node run` already uses this state directory. */
export const NODE_EXIT_ALREADY_RUNNING = 4;

/** Set by the supervisor so `node run` stops when its parent agent dies. */
export const SUPERVISOR_PID_ENV = "IMEMORY_PERSONAL_NODE_SUPERVISOR_PID";

/** Boot times from two reads of os.uptime() differ by rounding; a reboot differs by far more. */
const BOOT_TOLERANCE_MS = 120_000;
/** A lock that cannot be parsed yet may still be in the middle of being written. */
const UNREADABLE_GRACE_MS = 5_000;

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

export type RunLock = { release: () => void };

export type RunLockDeps = {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Epoch ms when this computer booted. */
  bootedAt?: () => number;
  now?: () => number;
};

type Owner = { pid: number; bootedAt: number };

function parseOwner(text: string): Owner | null {
  try {
    const value = JSON.parse(text) as Partial<Owner>;
    if (Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && Number.isFinite(value.bootedAt)) {
      return { pid: value.pid as number, bootedAt: value.bootedAt as number };
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
 * this boot (the pid may now belong to something else). A stale lock is moved
 * aside and checked before it is dropped, so two runners cannot both take it over.
 */
export function acquireRunLock(stateDir: string, deps: RunLockDeps = {}): RunLock | { heldBy: number } {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const bootedAt = deps.bootedAt ?? (() => Date.now() - os.uptime() * 1000);
  const file = runLockPath(stateDir);
  const mine = JSON.stringify({ pid, bootedAt: Math.round(bootedAt()) });

  let lastHolder = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
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
      const sameBoot = Math.abs(owner.bootedAt - bootedAt()) <= BOOT_TOLERANCE_MS;
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

    // Stale: move it aside. Only one runner's rename succeeds; if what moved is not
    // the lock we judged stale, someone took over meanwhile, so put theirs back.
    const aside = `${file}.stale.${pid}.${randomUUID()}`;
    try {
      renameSync(file, aside);
    } catch {
      continue;
    }
    if (readText(aside) !== seen) {
      try {
        linkSync(aside, file);
      } catch {
        // A third runner already holds it; the next attempt sees them.
      }
    }
    try {
      unlinkSync(aside);
    } catch {
      // Nothing to clean.
    }
  }
  return { heldBy: lastHolder };
}
