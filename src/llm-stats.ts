import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  authModeForRunner,
  getCooldownUntil,
  getLastRateLimitAt,
  getPacingEvents,
  getRateLimitHits,
  pacingAuditSnapshot,
  type AuthMode,
  type PacingEvent,
  type ProviderName,
} from "./provider-pacing.js";

export type LlmUsageEntry = {
  count: number;
  lastUsedAt: string;
  rateLimitHits?: number;
  lastRateLimitAt?: string | null;
  cooldownUntil?: string | null;
  authMode?: AuthMode;
};

export type LlmUsageStats = {
  updatedAt: string;
  /** Key: `${runner}/${model}` → usage */
  byLlm: Record<string, LlmUsageEntry>;
  /** Per-provider pacing audit (not model-scoped). */
  byProvider?: Record<
    string,
    {
      rateLimitHits: number;
      lastRateLimitAt: string | null;
      cooldownUntil: string | null;
      authMode: AuthMode;
      lastUsedAt: string | null;
    }
  >;
  /** Ring buffer of recent pacing decisions. */
  pacingEvents?: PacingEvent[];
};

/** Compact shape for heartbeat `meta.llmUsage`. */
export type LlmUsageMeta = {
  updatedAt: string;
  byLlm: Record<string, number>;
  pacing?: {
    lastInvokeAt: string | null;
    cooldowns: Record<string, string>;
    rateLimitHits: Record<string, number>;
  };
};

const DEFAULT_STATS: LlmUsageStats = {
  updatedAt: new Date(0).toISOString(),
  byLlm: {},
};

export function llmUsageKey(runner: string, model: string): string {
  const r = runner.trim() || "unknown";
  const m = model.trim() || "default";
  return `${r}/${m}`;
}

export function resolveLlmStatsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IMEMORY_LLM_STATS_PATH?.trim();
  if (override) return path.resolve(override);
  // Prefer the new name; fall back path kept for older installs via loadLlmStats callers.
  return path.join(os.homedir(), ".imemory", "desktop-agent-llm-usage.json");
}

function parseAuthMode(value: unknown): AuthMode | undefined {
  if (value === "api_key" || value === "cli_login" || value === "unknown") return value;
  return undefined;
}

export async function loadLlmStats(filePath: string): Promise<LlmUsageStats> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_STATS, byLlm: {} };
    }
    const obj = parsed as Record<string, unknown>;
    const byLlmRaw = obj.byLlm;
    const byLlm: Record<string, LlmUsageEntry> = {};
    if (byLlmRaw && typeof byLlmRaw === "object" && !Array.isArray(byLlmRaw)) {
      for (const [key, value] of Object.entries(byLlmRaw)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          byLlm[key] = {
            count: Math.max(0, Math.floor(value)),
            lastUsedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : DEFAULT_STATS.updatedAt,
          };
          continue;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const entry = value as Record<string, unknown>;
          const count =
            typeof entry.count === "number" && Number.isFinite(entry.count)
              ? Math.max(0, Math.floor(entry.count))
              : 0;
          const lastUsedAt =
            typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : DEFAULT_STATS.updatedAt;
          const rateLimitHits =
            typeof entry.rateLimitHits === "number" && Number.isFinite(entry.rateLimitHits)
              ? Math.max(0, Math.floor(entry.rateLimitHits))
              : undefined;
          const lastRateLimitAt =
            entry.lastRateLimitAt === null
              ? null
              : typeof entry.lastRateLimitAt === "string"
                ? entry.lastRateLimitAt
                : undefined;
          const cooldownUntil =
            entry.cooldownUntil === null
              ? null
              : typeof entry.cooldownUntil === "string"
                ? entry.cooldownUntil
                : undefined;
          const authMode = parseAuthMode(entry.authMode);
          byLlm[key] = {
            count,
            lastUsedAt,
            ...(rateLimitHits != null ? { rateLimitHits } : {}),
            ...(lastRateLimitAt !== undefined ? { lastRateLimitAt } : {}),
            ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
            ...(authMode ? { authMode } : {}),
          };
        }
      }
    }

    let byProvider: LlmUsageStats["byProvider"];
    if (obj.byProvider && typeof obj.byProvider === "object" && !Array.isArray(obj.byProvider)) {
      byProvider = {};
      for (const [key, value] of Object.entries(obj.byProvider as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        byProvider[key] = {
          rateLimitHits:
            typeof entry.rateLimitHits === "number" && Number.isFinite(entry.rateLimitHits)
              ? Math.max(0, Math.floor(entry.rateLimitHits))
              : 0,
          lastRateLimitAt:
            typeof entry.lastRateLimitAt === "string"
              ? entry.lastRateLimitAt
              : entry.lastRateLimitAt === null
                ? null
                : null,
          cooldownUntil:
            typeof entry.cooldownUntil === "string"
              ? entry.cooldownUntil
              : entry.cooldownUntil === null
                ? null
                : null,
          authMode: parseAuthMode(entry.authMode) ?? "unknown",
          lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : null,
        };
      }
    }

    let pacingEvents: PacingEvent[] | undefined;
    if (Array.isArray(obj.pacingEvents)) {
      pacingEvents = obj.pacingEvents.filter(
        (e): e is PacingEvent =>
          !!e &&
          typeof e === "object" &&
          typeof (e as PacingEvent).at === "string" &&
          typeof (e as PacingEvent).kind === "string" &&
          typeof (e as PacingEvent).runner === "string",
      );
    }

    return {
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : DEFAULT_STATS.updatedAt,
      byLlm,
      ...(byProvider ? { byProvider } : {}),
      ...(pacingEvents ? { pacingEvents } : {}),
    };
  } catch {
    return { ...DEFAULT_STATS, byLlm: {} };
  }
}

export async function saveLlmStats(filePath: string, stats: LlmUsageStats): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
}

function syncProviderAudit(stats: LlmUsageStats, runner: string, now: Date): void {
  const snapshot = pacingAuditSnapshot(now.getTime());
  stats.byProvider = {};
  for (const [name, entry] of Object.entries(snapshot.byProvider)) {
    stats.byProvider[name] = {
      rateLimitHits: entry.rateLimitHits,
      lastRateLimitAt: entry.lastRateLimitAt,
      cooldownUntil: entry.cooldownUntil,
      authMode: entry.authMode,
      lastUsedAt: entry.lastUsedAt,
    };
  }
  stats.pacingEvents = [...getPacingEvents()];

  // Enrich model-scoped rows for this runner with latest pacing fields.
  const provider = runner as ProviderName;
  const cool = getCooldownUntil(provider);
  const lastRl = getLastRateLimitAt(provider);
  for (const [key, entry] of Object.entries(stats.byLlm)) {
    if (!key.startsWith(`${runner}/`)) continue;
    entry.rateLimitHits = getRateLimitHits(provider);
    entry.lastRateLimitAt = lastRl != null ? new Date(lastRl).toISOString() : null;
    entry.cooldownUntil = cool != null ? new Date(cool).toISOString() : null;
    entry.authMode = authModeForRunner(provider);
  }
}

/**
 * Increment usage for a runner/model pair. Counts every invocation that
 * finished (succeeded/failed/cancelled after start).
 */
export async function recordLlmUsage(options: {
  runner: string;
  model?: string | null;
  filePath?: string;
  now?: Date;
  /** When true, merge in-memory pacing audit into the persisted file. */
  syncPacing?: boolean;
}): Promise<LlmUsageStats> {
  const filePath = options.filePath ?? resolveLlmStatsPath();
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const key = llmUsageKey(options.runner, options.model?.trim() || "default");

  const stats = await loadLlmStats(filePath);
  const prev = stats.byLlm[key];
  stats.byLlm[key] = {
    count: (prev?.count ?? 0) + 1,
    lastUsedAt: stamp,
    rateLimitHits: prev?.rateLimitHits,
    lastRateLimitAt: prev?.lastRateLimitAt,
    cooldownUntil: prev?.cooldownUntil,
    authMode: prev?.authMode ?? authModeForRunner(options.runner as ProviderName),
  };
  stats.updatedAt = stamp;

  if (options.syncPacing !== false) {
    syncProviderAudit(stats, options.runner, now);
  }

  await saveLlmStats(filePath, stats);
  return stats;
}

/**
 * Persist pacing/rate-limit fields without incrementing usage counts
 * (e.g. after recording a cooldown before the invoke finishes).
 */
export async function syncPacingToLlmStats(
  options: {
    filePath?: string;
    now?: Date;
  } = {},
): Promise<LlmUsageStats> {
  const filePath = options.filePath ?? resolveLlmStatsPath();
  const now = options.now ?? new Date();
  const stats = await loadLlmStats(filePath);
  stats.updatedAt = now.toISOString();
  syncProviderAudit(stats, "cursor_sdk", now);
  await saveLlmStats(filePath, stats);
  return stats;
}

export function toLlmUsageMeta(stats: LlmUsageStats): LlmUsageMeta {
  const byLlm: Record<string, number> = {};
  for (const [key, entry] of Object.entries(stats.byLlm)) {
    byLlm[key] = entry.count;
  }

  const snapshot = pacingAuditSnapshot();
  const cooldowns: Record<string, string> = {};
  const rateLimitHits: Record<string, number> = {};
  for (const [name, entry] of Object.entries(snapshot.byProvider)) {
    if (entry.inCooldown && entry.cooldownUntil) {
      cooldowns[name] = entry.cooldownUntil;
    }
    if (entry.rateLimitHits > 0) {
      rateLimitHits[name] = entry.rateLimitHits;
    }
  }

  const hasPacing =
    snapshot.lastInvokeAt != null ||
    Object.keys(cooldowns).length > 0 ||
    Object.keys(rateLimitHits).length > 0;

  return {
    updatedAt: stats.updatedAt,
    byLlm,
    ...(hasPacing
      ? {
          pacing: {
            lastInvokeAt: snapshot.lastInvokeAt,
            cooldowns,
            rateLimitHits,
          },
        }
      : {}),
  };
}

export async function readLlmUsageMeta(filePath?: string): Promise<LlmUsageMeta> {
  const stats = await loadLlmStats(filePath ?? resolveLlmStatsPath());
  return toLlmUsageMeta(stats);
}
