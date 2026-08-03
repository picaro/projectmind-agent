import { spawn } from "node:child_process";

export type ClaudeUsageSnapshot = {
  checkedAt: string;
  /** Human-readable summary line(s), suitable for display on the models cooldown page. */
  note: string;
  sessionPercent: number | null;
  sessionResetsAt: string | null;
  weekPercent: number | null;
  weekResetsAt: string | null;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;

let cached: { atMs: number; snapshot: ClaudeUsageSnapshot | null } | null = null;
let inFlight: Promise<ClaudeUsageSnapshot | null> | null = null;

export function resetClaudeUsageCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Parse the plain-text `result` field from `claude -p "/usage" --output-format json`.
 * Example:
 *   Current session: 30% used · resets Jul 27 at 11pm (America/New_York)
 *   Current week (all models): 4% used · resets Aug 1 at 5pm (America/New_York)
 */
export function parseClaudeUsageText(raw: string): ClaudeUsageSnapshot {
  const sessionMatch = raw.match(
    /Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s+([^\n]+))?/i,
  );
  const weekMatch = raw.match(
    /Current week[^:]*:\s*(\d+)%\s*used(?:\s*·\s*resets\s+([^\n]+))?/i,
  );

  const sessionPercent = sessionMatch ? Number.parseInt(sessionMatch[1]!, 10) : null;
  const sessionResetsAt = sessionMatch?.[2]?.trim() || null;
  const weekPercent = weekMatch ? Number.parseInt(weekMatch[1]!, 10) : null;
  const weekResetsAt = weekMatch?.[2]?.trim() || null;

  const noteLines = [
    sessionMatch
      ? `Session: ${sessionPercent}% used${sessionResetsAt ? ` (resets ${sessionResetsAt})` : ""}`
      : null,
    weekMatch
      ? `Week: ${weekPercent}% used${weekResetsAt ? ` (resets ${weekResetsAt})` : ""}`
      : null,
  ].filter(Boolean);

  return {
    checkedAt: new Date().toISOString(),
    note: noteLines.length ? noteLines.join(" · ") : raw.trim().slice(0, 500),
    sessionPercent: Number.isFinite(sessionPercent) ? sessionPercent : null,
    sessionResetsAt,
    weekPercent: Number.isFinite(weekPercent) ? weekPercent : null,
    weekResetsAt,
  };
}

/** Run `claude -p "/usage" --output-format json` and parse the result. Never throws. */
export async function runClaudeUsageCheck(options: {
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ClaudeUsageSnapshot | null> {
  const command =
    options.command?.trim() ||
    process.env.IMEMORY_CLAUDE_CLI_BIN?.trim() ||
    process.env.CLAUDE_CLI_BIN?.trim() ||
    "claude";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";

    let child;
    try {
      child = spawn(command, ["-p", "/usage", "--output-format", "json"], {
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const finish = (result: ClaudeUsageSnapshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as { result?: string };
        if (typeof parsed.result !== "string" || !parsed.result.trim()) {
          finish(null);
          return;
        }
        finish(parseClaudeUsageText(parsed.result));
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Cached, throttled usage check — avoids spawning `claude -p "/usage"` before every
 * single job or heartbeat. Shared across callers (jobs.ts gating + index.ts heartbeat).
 */
export async function getClaudeUsageSnapshot(
  options: { minIntervalMs?: number; command?: string; timeoutMs?: number } = {},
): Promise<ClaudeUsageSnapshot | null> {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const nowMs = Date.now();

  if (cached && nowMs - cached.atMs < minIntervalMs) {
    return cached.snapshot;
  }
  if (inFlight) return inFlight;

  inFlight = runClaudeUsageCheck(options).then((snapshot) => {
    cached = { atMs: Date.now(), snapshot };
    inFlight = null;
    return snapshot;
  });

  return inFlight;
}

/** Whether the given snapshot indicates the model is close to its usage limit. */
export function isClaudeUsageClose(
  snapshot: ClaudeUsageSnapshot | null,
  thresholdPercent: number,
): boolean {
  if (!snapshot) return false;
  const percents = [snapshot.sessionPercent, snapshot.weekPercent].filter(
    (p): p is number => p != null,
  );
  return percents.some((p) => p >= thresholdPercent);
}
