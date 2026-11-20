import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** `node run` exits 4 when another `node run` already uses this state directory. */
export const NODE_EXIT_ALREADY_RUNNING = 4;

/** Set by the supervisor so `node run` stops when its parent agent dies. */
export const SUPERVISOR_PID_ENV = "IMEMORY_PERSONAL_NODE_SUPERVISOR_PID";

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

/**
 * One `node run` per state directory. Two runners would share a device token,
 * apply the same commands twice and race on the state file.
 * Returns the holder's pid when the lock is taken; a lock left by a dead process is replaced.
 */
export function acquireRunLock(
  stateDir: string,
  deps: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): RunLock | { heldBy: number } {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? pidAlive;
  const file = runLockPath(stateDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return {
        release: () => {
          try {
            if (readFileSync(file, "utf8").trim() === String(pid)) unlinkSync(file);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    } catch {
      // Removed between our write and read: try again.
    }
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) {
      return { heldBy: holder };
    }
    try {
      unlinkSync(file);
    } catch {
      // Another runner replaced it first; the next attempt sees theirs.
    }
  }
  return { heldBy: 0 };
}
