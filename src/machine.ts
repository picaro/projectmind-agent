import { execFileSync } from "node:child_process";
import os from "node:os";

/** Heartbeat `kind` reported to ProjectMind (desktop agents). */
export type AgentKind = "mac" | "windows" | "other";

export type MachineInfo = {
  host: string;
  at: string;
  platform: string;
  agentKey: string;
  kind: AgentKind;
};

type CpuTimesSample = { idle: number; total: number };

/** Previous `os.cpus()` aggregate — delta vs next sample ≈ interval CPU usage. */
let previousCpuSample: CpuTimesSample | null = null;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCpuTimesSample(): CpuTimesSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function cpuPercentFromDelta(prev: CpuTimesSample, next: CpuTimesSample): number | null {
  const idleDelta = next.idle - prev.idle;
  const totalDelta = next.total - prev.total;
  if (totalDelta <= 0) return null;
  const used = 1 - idleDelta / totalDelta;
  const pct = used * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/**
 * System CPU utilization 0–100 from the delta since the last call (or a short
 * bootstrap sample). Used on heartbeat so the control plane can prefer lightly
 * loaded agents.
 */
export async function collectCpuLoadPercent(
  options: { bootstrapMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<number | null> {
  const bootstrapMs = options.bootstrapMs ?? 150;
  const wait = options.sleepFn ?? sleep;
  const now = readCpuTimesSample();
  const prev = previousCpuSample;

  if (!prev || now.total <= prev.total) {
    previousCpuSample = now;
    if (bootstrapMs > 0) {
      await wait(bootstrapMs);
      const second = readCpuTimesSample();
      previousCpuSample = second;
      return cpuPercentFromDelta(now, second);
    }
    return null;
  }

  previousCpuSample = now;
  return cpuPercentFromDelta(prev, now);
}

/** Test helper — reset the rolling CPU sample between cases. */
export function resetCpuLoadSampleForTests(): void {
  previousCpuSample = null;
}

export function agentKindFromPlatform(platform: string = process.platform): AgentKind {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "other";
}

/** Prefer macOS ComputerName; fall back to hostname. */
export function getComputerName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
      }).trim();
      if (name) return name;
    } catch {
      // fall through
    }
  }
  return os.hostname();
}

export function agentKeyForHost(host: string): string {
  return `host:${host}`;
}

/**
 * Prefer IMEMORY_AGENT_KEY when set (opaque id). Falls back to host:<ComputerName>,
 * which is guessable — set a random key in production if API keys are shared.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function resolveAgentKey(host: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IMEMORY_AGENT_KEY?.trim();
  if (override) return override;

  // Allow tests or deployments to override where the agent key is persisted.
  const filePath = (env.IMEMORY_AGENT_KEY_FILE && env.IMEMORY_AGENT_KEY_FILE.trim()) ||
    path.join(os.homedir(), ".imemory_agent_key");

  try {
    const existing = readFile(filePath, { encoding: "utf8" }).then((s) => s.trim()).catch(() => "");
    // If readFile succeeded and has content, return it synchronously via thenable result.
    // Note: we purposely keep resolveAgentKey synchronous in appearance by resolving the
    // Promise result immediately (tests call this synchronously). If the environment
    // requires async persistence semantics in future, refactor accordingly.
    // eslint-disable-next-line no-sync
    const syncExisting = (require("fs").existsSync(filePath) && require("fs").readFileSync(filePath, "utf8").trim()) || "";
    if (syncExisting) return syncExisting;
  } catch {
    // ignore and fall back to generating and writing
  }

  const key = agentKeyForHost(host);
  // Try to persist for future runs; ignore failures.
  try {
    // eslint-disable-next-line no-sync
    require("fs").writeFileSync(filePath, key, { encoding: "utf8", mode: 0o600 });
  } catch {
    // ignore
  }

  return key;
}

export function collectMachineInfo(now: Date = new Date()): MachineInfo {
  const host = getComputerName();
  const platform = process.platform;
  return {
    host,
    at: now.toISOString(),
    platform,
    agentKey: resolveAgentKey(host),
    kind: agentKindFromPlatform(platform),
  };
}

export function formatHeartbeatDone(info: Pick<MachineInfo, "host" | "at">): string {
  return `host=${info.host} at ${info.at}`;
}

/** Strip trailing slashes so `…app/` + path does not become `…app//api/mcp`. */
export function normalizeMcpBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}
