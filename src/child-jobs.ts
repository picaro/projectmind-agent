import { spawn, type ChildProcess } from "node:child_process";

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

/**
 * How to re-invoke this agent binary as a one-shot worker.
 * Packaged binaries are `process.execPath`; node/tsx runs keep argv[1] as the entry.
 */
export function resolveExecJobSpawnSpec(jobId: string): ChildJobSpawnSpec {
  const extra = buildExecJobArgv(jobId);
  const entry = process.argv[1]?.trim() ?? "";
  if (entry && (entry.endsWith(".js") || entry.endsWith(".cjs") || entry.endsWith(".ts") || entry.endsWith(".mjs"))) {
    return { command: process.execPath, args: [entry, ...extra] };
  }
  return { command: process.execPath, args: extra };
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
