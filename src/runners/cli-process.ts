import { spawn, type ChildProcess } from "node:child_process";
import type { RunnerLog } from "./types.js";

export type CliProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
};

/**
 * Spawn a CLI, stream stdout/stderr line-by-line to onLog, honor AbortSignal.
 */
export async function runCliProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLog: RunnerLog;
  signal: AbortSignal;
  /** Called for each non-empty stdout line (before generic log). Return true to skip default log. */
  onStdoutLine?: (line: string) => boolean | void | Promise<boolean | void>;
  /** Max total stdout chars retained for summary (default 200_000). */
  maxStdoutChars?: number;
}): Promise<CliProcessResult> {
  const maxStdout = options.maxStdoutChars ?? 200_000;
  await options.onLog(
    `Spawning: ${options.command} ${formatArgsForLog(options.args).join(" ")}`,
    "status",
  );

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      void options.onLog(
        `Failed to spawn ${options.command}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      resolve({
        code: 127,
        signal: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        cancelled: false,
      });
      return;
    }

    if (!child.stdout || !child.stderr) {
      resolve({
        code: 127,
        signal: null,
        stdout: "",
        stderr: "Failed to open child stdio pipes",
        cancelled: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let cancelled = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout, stderr, cancelled });
    };

    const killChild = () => {
      cancelled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5_000).unref();
    };

    const onAbort = () => {
      void options.onLog("Abort signal — terminating CLI process", "status");
      killChild();
    };

    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort);
    }

    const appendStdout = (chunk: string) => {
      if (stdout.length < maxStdout) {
        const room = maxStdout - stdout.length;
        stdout += chunk.length > room ? chunk.slice(0, room) : chunk;
      }
    };

    const flushStdoutLines = async (flushAll: boolean) => {
      const parts = stdoutBuf.split("\n");
      stdoutBuf = flushAll ? "" : (parts.pop() ?? "");
      for (const line of parts) {
        if (!line.trim()) continue;
        const handled = options.onStdoutLine ? await options.onStdoutLine(line) : false;
        if (!handled) {
          await options.onLog(line.slice(0, 7_000), "log");
        }
      }
    };

    const flushStderrLines = async (flushAll: boolean) => {
      const parts = stderrBuf.split("\n");
      stderrBuf = flushAll ? "" : (parts.pop() ?? "");
      for (const line of parts) {
        if (!line.trim()) continue;
        await options.onLog(`[stderr] ${line.slice(0, 7_000)}`, "log");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      appendStdout(chunk);
      stdoutBuf += chunk;
      void flushStdoutLines(false);
    });

    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < maxStdout) {
        const room = maxStdout - stderr.length;
        stderr += chunk.length > room ? chunk.slice(0, room) : chunk;
      }
      stderrBuf += chunk;
      void flushStderrLines(false);
    });

    child.on("error", (err) => {
      void options.onLog(`Process error: ${err.message}`, "error");
      finish(127, null);
    });

    child.on("close", (code, signal) => {
      void (async () => {
        await flushStdoutLines(true);
        await flushStderrLines(true);
        finish(code, signal);
      })();
    });
  });
}

function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_./:@%=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const SENSITIVE_FLAG = /^(--?(?:api[-_]?key|token|password|secret|authorization))$/i;

/**
 * Format argv for logs: redact secret flags and truncate long trailing prompts.
 */
export function formatArgsForLog(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (SENSITIVE_FLAG.test(arg) && i + 1 < args.length) {
      out.push(arg, "***");
      i += 1;
      continue;
    }
    if (/^--?(?:api[-_]?key|token|password|secret)=/i.test(arg)) {
      out.push(arg.split("=")[0] + "=***");
      continue;
    }
    // Last arg is often the full prompt — don't upload it via spawn logs.
    if (i === args.length - 1 && arg.length > 120 && !arg.startsWith("-")) {
      out.push(shellQuote(`${arg.slice(0, 80)}…(${arg.length} chars)`));
      continue;
    }
    out.push(shellQuote(arg));
  }
  return out;
}

/** Parse NDJSON / JSONL lines; returns null if not JSON. */
export function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return null;
  }
}
