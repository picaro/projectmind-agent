import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { defaultStateDir } from "./command.ts";
import { stateFilePath } from "./state.ts";

/** `node run` exits 3 when the control plane revoked this computer. */
export const NODE_EXIT_REVOKED = 3;

/**
 * Plain `projectmind-agent` also runs the local-cloud node when this computer
 * is paired. `IMEMORY_PERSONAL_NODE_AUTOSTART=0` turns that off.
 */
export function shouldAutostartNode(
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync,
): boolean {
  if (env.IMEMORY_PERSONAL_NODE_AUTOSTART?.trim() === "0") return false;
  return exists(stateFilePath(defaultStateDir(env)));
}

/** Capped exponential restart delay; `failures` counts quick exits in a row. */
export function restartDelayMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures - 1, 16)));
}

export type SpawnSpec = { command: string; args: string[] };

export type NodeSupervisorOptions = {
  spec: SpawnSpec;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  spawnImpl?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A child that ran this long resets the backoff. */
  stableMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

function defaultSpawn(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: false });
}

function prefixLines(stream: NodeJS.ReadableStream | null, log: (line: string) => void): void {
  if (!stream) return;
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line) log(`[node] ${line}`);
  });
  stream.on("end", () => {
    if (buffered) log(`[node] ${buffered}`);
    buffered = "";
  });
}

/**
 * Runs `projectmind-agent node run` as a child so a cloudflared or Docker failure
 * cannot take down the job loop, and restarts it with backoff when it exits.
 */
export class NodeSupervisor {
  private child: ChildProcess | null = null;
  private timer: unknown = null;
  private stopped = false;
  private failures = 0;
  private startedAt = 0;
  private readonly log: (line: string) => void;
  private readonly spawnImpl: NonNullable<NodeSupervisorOptions["spawnImpl"]>;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<NodeSupervisorOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<NodeSupervisorOptions["clearTimer"]>;
  private readonly onProcessExit = () => {
    this.child?.kill("SIGTERM");
  };

  constructor(private readonly options: NodeSupervisorOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.stopped || this.child) return;
    this.timer = null;
    process.once("exit", this.onProcessExit);
    const child = this.spawnImpl(
      this.options.spec.command,
      this.options.spec.args,
      this.options.env ?? process.env,
    );
    this.child = child;
    this.startedAt = this.now();
    prefixLines(child.stdout, this.log);
    prefixLines(child.stderr, this.log);
    child.once("error", (error) => {
      this.log(`[node] could not start: ${error.message}`);
      this.handleExit(null);
    });
    child.once("exit", (code) => this.handleExit(code));
  }

  private handleExit(code: number | null): void {
    if (!this.child) return;
    this.child = null;
    process.off("exit", this.onProcessExit);
    if (this.stopped) return;
    if (code === NODE_EXIT_REVOKED) {
      this.stopped = true;
      this.log(
        "[node] this computer was revoked or its credential was rejected. Pair it again with `projectmind-agent node pair --force`.",
      );
      return;
    }
    const stableMs = this.options.stableMs ?? 60_000;
    this.failures = this.now() - this.startedAt >= stableMs ? 1 : this.failures + 1;
    const delay = restartDelayMs(
      this.failures,
      this.options.baseDelayMs ?? 2_000,
      this.options.maxDelayMs ?? 60_000,
    );
    this.log(`[node] exited (${code ?? "signal"}); restarting in ${Math.round(delay / 1000)}s`);
    this.timer = this.setTimer(() => this.start(), delay);
  }

  /** SIGTERM the child (it stops cloudflared), then SIGKILL after `timeoutMs`. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (killTimer) clearTimeout(killTimer);
  }
}
