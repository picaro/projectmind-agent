import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";

export type ChildJobSpawnSpec = {
  command: string;
  args: string[];
};

/** argv for a one-shot worker that claims and runs a single child job. */
export function buildExecJobArgv(jobId: string): string[] {
  return ["exec-job", "--jobId", jobId];
}

export function parseExecJobArgs(args: string[]): { jobId: string } | { error: string } {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--jobId") {
      const jobId = args[i + 1]?.trim() ?? "";
      if (!jobId) return { error: "exec-job requires --jobId <uuid>" };
      return { jobId };
    }
  }
  return { error: "exec-job requires --jobId <uuid>" };
}

/** How to re-invoke this agent binary as a one-shot worker. */
export function resolveExecJobSpawnSpec(jobId: string): ChildJobSpawnSpec {
  return resolveSelfSpawnSpec(buildExecJobArgv(jobId));
}

const SCRIPT_ENTRY = /\.(?:c|m)?(?:js|ts)$/;

/** A child must not bind the parent's debugger port. */
const INSPECTOR_FLAG = /^--inspect(?:-brk|-port|-wait)?(?:=|$)/;

/**
 * How to re-invoke this agent binary with other arguments.
 * Packaged binaries are `process.execPath`; node/tsx runs keep argv[1] as the entry,
 * plus Node's own flags (tsx's loader lives there, and the .ts sources need it).
 * npm and npx put an extensionless bin symlink in argv[1], so the link is resolved first.
 */
export function resolveSelfSpawnSpec(
  extra: string[],
  runtime: {
    argv?: string[];
    execArgv?: string[];
    execPath?: string;
    realpath?: (path: string) => string;
  } = {},
): ChildJobSpawnSpec {
  const argv = runtime.argv ?? process.argv;
  const nodeFlags = (runtime.execArgv ?? process.execArgv).filter((flag) => !INSPECTOR_FLAG.test(flag));
  const execPath = runtime.execPath ?? process.execPath;
  const realpath = runtime.realpath ?? realpathSync;
  const raw = argv[1]?.trim() ?? "";
  let entry = raw;
  if (raw && !SCRIPT_ENTRY.test(raw)) {
    try {
      entry = realpath(raw);
    } catch {
      // Not a file (a packaged binary's first argument): fall through.
    }
  }
  if (entry && SCRIPT_ENTRY.test(entry)) {
    return { command: execPath, args: [...nodeFlags, entry, ...extra] };
  }
  return { command: execPath, args: extra };
}

export function maxChildWorkers(maxConcurrentChildren?: number | null): number {
  const fromEnv = Number.parseInt(process.env.IMEMORY_MAX_CHILD_WORKERS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (typeof maxConcurrentChildren === "number" && maxConcurrentChildren > 0) {
    return maxConcurrentChildren;
  }
  return 2;
}

export function shouldSpawnQueuedChild(input: {
  childJobId: string | null | undefined;
  status: string | null | undefined;
  alreadySpawned: ReadonlySet<string>;
  inFlight: number;
  max: number;
}): boolean {
  const id = input.childJobId?.trim() ?? "";
  if (!id) return false;
  if (input.status !== "queued") return false;
  if (input.alreadySpawned.has(id)) return false;
  if (input.inFlight >= input.max) return false;
  return true;
}

export type SpawnedChildHandle = {
  jobId: string;
  pid: number | undefined;
  kill: () => void;
};

const liveChildProcesses = new Set<ChildProcess>();

export function spawnExecJobProcess(
  spec: ChildJobSpawnSpec,
  env: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const child = spawn(spec.command, spec.args, {
    env,
    stdio: "inherit",
    detached: false,
  });
  liveChildProcesses.add(child);
  const drop = () => {
    liveChildProcesses.delete(child);
  };
  child.on("exit", drop);
  child.on("error", drop);
  return child;
}

export function liveChildWorkerCount(): number {
  return liveChildProcesses.size;
}

/** SIGTERM children, wait briefly, then SIGKILL leftovers. */
export async function stopAllChildWorkers(timeoutMs = 3_000): Promise<void> {
  const procs = [...liveChildProcesses];
  for (const child of procs) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (liveChildProcesses.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const child of [...liveChildProcesses]) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    liveChildProcesses.delete(child);
  }
}
