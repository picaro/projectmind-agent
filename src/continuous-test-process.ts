/**
 * Process-group spawning for continuous test runs.
 *
 * Every child (git, dependency install, Playwright) is spawned from a
 * structured argv with `shell: false` and `detached: true`, so it leads its own
 * process group and the whole tree — including browsers Playwright launched —
 * can be signalled at once with `kill(-pgid)`.
 */
import { execFile, spawn } from "node:child_process";

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

export type ManagedProcess = {
  pid: number | undefined;
  exited: Promise<ProcessExit>;
  hasExited: () => boolean;
  stdoutTail: () => string;
  stderrTail: () => string;
  killGroup: (signal: NodeJS.Signals) => void;
};

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
};

export type SpawnProcess = (argv: string[], options: SpawnOptions) => ManagedProcess;

const OUTPUT_TAIL_CHARS = 64 * 1024;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_CHARS ? next.slice(next.length - OUTPUT_TAIL_CHARS) : next;
}

/** Kill a whole process group; on Windows fall back to taskkill /T. */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone (ESRCH) or not ours (EPERM) — nothing left to signal.
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const spawnProcessGroup: SpawnProcess = (argv, options) => {
  const [command, ...args] = argv;
  if (!command) throw new Error("argv is empty");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let done = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = appendTail(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = appendTail(stderr, chunk);
  });
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once("error", (err) => {
      stderr = appendTail(stderr, `\n${err.message}`);
      done = true;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      done = true;
      resolve({ code, signal });
    });
  });
  return {
    pid: child.pid,
    exited,
    hasExited: () => done,
    stdoutTail: () => stdout,
    stderrTail: () => stderr,
    killGroup: (signal) => {
      if (child.pid) killProcessGroup(child.pid, signal);
    },
  };
};

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
  });
}

/**
 * SIGTERM the group, wait up to `graceMs`, then SIGKILL the group.
 * Returns how the process ended (null if it never reported exit).
 */
export async function terminateProcessGroup(
  proc: ManagedProcess,
  graceMs: number,
): Promise<ProcessExit | null> {
  if (proc.hasExited()) {
    // The leader exited but grandchildren (browsers) may still hold the group.
    proc.killGroup("SIGKILL");
    return proc.exited;
  }
  proc.killGroup("SIGTERM");
  const first = await Promise.race([proc.exited, delay(graceMs)]);
  // Always SIGKILL: browsers that ignored SIGTERM must not outlive the run.
  proc.killGroup("SIGKILL");
  if (first !== "timeout") return first;
  const second = await Promise.race([proc.exited, delay(5_000)]);
  return second === "timeout" ? null : second;
}

/** Env keys the control plane may never set: they change what code the child loads. */
const FORBIDDEN_ENV_KEY = /^(PATH|HOME|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|npm_config_.*|NPM_CONFIG_.*|PLAYWRIGHT_BROWSERS_PATH|PLAYWRIGHT_JSON_OUTPUT_(NAME|FILE)|TMPDIR|SHELL|BASH_ENV|ENV)$/;

export function forbiddenEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => FORBIDDEN_ENV_KEY.test(key));
}

/**
 * Approved base env for a test child: a minimal PATH/HOME/locale from this
 * agent, never the agent's own env (it holds the ProjectMind API key).
 */
export function buildChildEnv(input: {
  agentEnv: NodeJS.ProcessEnv;
  tmpDir: string;
  extra?: Record<string, string>;
  commandEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SYSTEMROOT", "PLAYWRIGHT_BROWSERS_PATH"]) {
    const value = input.agentEnv[key];
    if (value) env[key] = value;
  }
  env.TMPDIR = input.tmpDir;
  // Never let npx download a package the lockfile did not pin.
  env.npm_config_yes = "false";
  env.GIT_TERMINAL_PROMPT = "0";
  Object.assign(env, input.extra ?? {});
  Object.assign(env, input.commandEnv ?? {});
  return env;
}
