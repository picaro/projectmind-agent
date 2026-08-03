import type { RunnerName } from "./runners/types.js";
import { sleep as defaultSleep } from "./machine.js";

/** Concrete runners that invoke an external provider. */
export type ProviderName = Exclude<RunnerName, "auto">;

export type AuthMode = "api_key" | "cli_login" | "unknown";

export type PacingReason = "min_gap" | "rpm" | "cooldown" | "none";

export type PacingWait = {
  waitMs: number;
  reason: PacingReason;
  runner: ProviderName;
};

export type SkippedAttempt = {
  runner: ProviderName;
  reason: "cooldown" | "disabled" | "prefer_auth" | "rpm";
};

export type ProviderPacingConfig = {
  minGapMs: number;
  gapJitterMs: number;
  cooldownMs: number;
  maxRpm: Record<ProviderName, number>;
  preferAuthenticated: boolean;
};

export type PacingEvent = {
  at: string;
  kind: "wait" | "invoke" | "rate_limit" | "skip";
  runner: ProviderName;
  waitMs?: number;
  reason?: string;
  cooldownUntil?: string;
};

const PROVIDERS: ProviderName[] = [
  "cursor_sdk",
  "cursor_cli",
  "codex_cli",
  "antigravity_cli",
  "claude_cli",
  "copilot_cli",
  "openrouter",
  "tokenrouter",
];

/** Cursor SDK and CLI share the same quota pool. */
const CURSOR_FAMILY: ProviderName[] = ["cursor_sdk", "cursor_cli"];

const DEFAULT_MAX_RPM: Record<ProviderName, number> = {
  // Conservative job-level caps (full coding runs, not chat tokens).
  cursor_sdk: 4,
  cursor_cli: 4,
  codex_cli: 6,
  antigravity_cli: 6,
  claude_cli: 6,
  copilot_cli: 6,
  openrouter: 10,
  tokenrouter: 10,
};

const MAX_PACING_EVENTS = 40;
const RPM_WINDOW_MS = 60_000;
const MODEL_DISABLED_UNTIL_MS = Date.parse("9999-12-31T23:59:59.999Z");
const MODEL_DISABLED_RUNNER_SUFFIX = "::disabled";

let lastInvokeAtMs: number | null = null;
const invokeTimestampsByProvider = new Map<ProviderName, number[]>();
const cooldownUntilByProvider = new Map<ProviderName, number>();
const disabledProviders = new Set<ProviderName>();
const lastUsedAtByProvider = new Map<ProviderName, number>();
const rateLimitHitsByProvider = new Map<ProviderName, number>();
const lastRateLimitAtByProvider = new Map<ProviderName, number>();
let pacingEvents: PacingEvent[] = [];

export function resetProviderPacing(): void {
  lastInvokeAtMs = null;
  invokeTimestampsByProvider.clear();
  cooldownUntilByProvider.clear();
  disabledProviders.clear();
  lastUsedAtByProvider.clear();
  rateLimitHitsByProvider.clear();
  lastRateLimitAtByProvider.clear();
  pacingEvents = [];
}

export function isProviderDisabled(runner: ProviderName): boolean {
  return disabledProviders.has(runner);
}


function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

export function loadPacingConfig(env: NodeJS.ProcessEnv = process.env): ProviderPacingConfig {
  return {
    minGapMs: parsePositiveInt(env.IMEMORY_PROVIDER_MIN_GAP_MS, 15_000),
    gapJitterMs: parsePositiveInt(env.IMEMORY_PROVIDER_GAP_JITTER_MS, 5_000),
    cooldownMs: parsePositiveInt(env.IMEMORY_PROVIDER_COOLDOWN_MS, 300_000),
    maxRpm: {
      cursor_sdk: parsePositiveInt(env.IMEMORY_CURSOR_MAX_RPM, DEFAULT_MAX_RPM.cursor_sdk),
      cursor_cli: parsePositiveInt(
        env.IMEMORY_CURSOR_MAX_RPM ?? env.IMEMORY_CURSOR_CLI_MAX_RPM,
        DEFAULT_MAX_RPM.cursor_cli,
      ),
      codex_cli: parsePositiveInt(env.IMEMORY_CODEX_MAX_RPM, DEFAULT_MAX_RPM.codex_cli),
      antigravity_cli: parsePositiveInt(
        env.IMEMORY_ANTIGRAVITY_MAX_RPM,
        DEFAULT_MAX_RPM.antigravity_cli,
      ),
      claude_cli: parsePositiveInt(env.IMEMORY_CLAUDE_MAX_RPM, DEFAULT_MAX_RPM.claude_cli),
      copilot_cli: parsePositiveInt(env.IMEMORY_COPILOT_MAX_RPM, DEFAULT_MAX_RPM.copilot_cli),
      openrouter: parsePositiveInt(env.IMEMORY_OPENROUTER_MAX_RPM, DEFAULT_MAX_RPM.openrouter),
      tokenrouter: parsePositiveInt(
        env.IMEMORY_TOKENROUTER_MAX_RPM,
        DEFAULT_MAX_RPM.tokenrouter,
      ),
      llm_api: parsePositiveInt(env.IMEMORY_LLM_API_MAX_RPM, DEFAULT_MAX_RPM.llm_api),
    },
    preferAuthenticated: parseBool(env.IMEMORY_PREFER_AUTHENTICATED, true),
  };
}

export function isRateLimitError(error?: string | null): boolean {
  if (!error) return false;
  const err = error.toLowerCase();
  return (
    err.includes("resource_exhausted") ||
    err.includes("resource exhausted") ||
    err.includes("rate_limit") ||
    err.includes("rate limit") ||
    err.includes("429") ||
    err.includes("too many requests") ||
    err.includes("quota exceeded") ||
    err.includes("quota reached") ||
    err.includes("usage limit")
  );
}

/** Parse Retry-After seconds or ISO/ms hints from an error string when present. */
export function parseRetryAfterMs(error?: string | null): number | null {
  if (!error) return null;
  const resetIn = error.match(
    /\bresets?\s+in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?\b/i,
  );
  if (resetIn) {
    const [, days, hours, minutes, seconds] = resetIn;
    const ms =
      (Number(days || 0) * 86_400 +
        Number(hours || 0) * 3_600 +
        Number(minutes || 0) * 60 +
        Number(seconds || 0)) *
      1_000;
    if (ms > 0) return ms;
  }
  const retryAfterSec = error.match(/retry[-_ ]?after[=:\s]+(\d+(?:\.\d+)?)/i);
  if (retryAfterSec?.[1]) {
    const sec = Number.parseFloat(retryAfterSec[1]);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  }
  const retryAfterMs = error.match(/retry[-_ ]?after[-_ ]?ms[=:\s]+(\d+)/i);
  if (retryAfterMs?.[1]) {
    const ms = Number.parseInt(retryAfterMs[1], 10);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return null;
}

export function authModeForRunner(
  runner: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
): AuthMode {
  if (runner === "cursor_sdk") {
    return env.CURSOR_API_KEY?.trim() ? "api_key" : "unknown";
  }
  if (runner === "cursor_cli") {
    return env.CURSOR_API_KEY?.trim() ? "api_key" : "cli_login";
  }
  if (runner === "codex_cli") {
    const key = env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
    return key ? "api_key" : "cli_login";
  }
  if (runner === "openrouter") {
    const key = env.OPENROUTER_API_KEY?.trim() || env.IMEMORY_OPENROUTER_API_KEY?.trim();
    return key ? "api_key" : "unknown";
  }
  if (runner === "tokenrouter") {
    const key = env.TOKENROUTER_API_KEY?.trim() || env.IMEMORY_TOKENROUTER_API_KEY?.trim();
    return key ? "api_key" : "unknown";
  }
  if (runner === "antigravity_cli") {
    return "cli_login";
  }
  if (runner === "claude_cli") {
    const key = env.ANTHROPIC_API_KEY?.trim() || env.IMEMORY_CLAUDE_API_KEY?.trim();
    return key ? "api_key" : "cli_login";
  }
  if (runner === "copilot_cli") {
    const key =
      env.COPILOT_GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
    return key ? "api_key" : "cli_login";
  }
  return "unknown";
}

function pushEvent(event: PacingEvent): void {
  pacingEvents.push(event);
  if (pacingEvents.length > MAX_PACING_EVENTS) {
    pacingEvents = pacingEvents.slice(-MAX_PACING_EVENTS);
  }
}

export function getPacingEvents(): readonly PacingEvent[] {
  return pacingEvents;
}

export function getCooldownUntil(runner: ProviderName): number | null {
  return cooldownUntilByProvider.get(runner) ?? null;
}

export function getRateLimitHits(runner: ProviderName): number {
  return rateLimitHitsByProvider.get(runner) ?? 0;
}

export function getLastRateLimitAt(runner: ProviderName): number | null {
  return lastRateLimitAtByProvider.get(runner) ?? null;
}

export function getLastUsedAt(runner: ProviderName): number | null {
  return lastUsedAtByProvider.get(runner) ?? null;
}

export function isInCooldown(runner: ProviderName, nowMs: number = Date.now()): boolean {
  const until = cooldownUntilByProvider.get(runner);
  return until != null && until > nowMs;
}

function pruneTimestamps(runner: ProviderName, nowMs: number): number[] {
  const prev = invokeTimestampsByProvider.get(runner) ?? [];
  const kept = prev.filter((t) => nowMs - t < RPM_WINDOW_MS);
  invokeTimestampsByProvider.set(runner, kept);
  return kept;
}

function rpmWaitMs(runner: ProviderName, maxRpm: number, nowMs: number): number {
  if (maxRpm <= 0) return 0;
  const stamps = pruneTimestamps(runner, nowMs);
  if (stamps.length < maxRpm) return 0;
  const oldest = stamps[0]!;
  return Math.max(0, RPM_WINDOW_MS - (nowMs - oldest));
}

function familyFor(runner: ProviderName): ProviderName[] {
  if (CURSOR_FAMILY.includes(runner)) return CURSOR_FAMILY;
  return [runner];
}

/**
 * Skip unauthenticated cursor_cli when CURSOR_API_KEY is set and prefer-auth is on
 * (cascade already has cursor_sdk first).
 */
export function filterPreferAuth(
  attempts: ProviderName[],
  env: NodeJS.ProcessEnv = process.env,
  config: ProviderPacingConfig = loadPacingConfig(env),
): { kept: ProviderName[]; skipped: SkippedAttempt[] } {
  if (!config.preferAuthenticated) {
    return { kept: [...attempts], skipped: [] };
  }
  const hasCursorKey = Boolean(env.CURSOR_API_KEY?.trim());
  const hasSdk = attempts.includes("cursor_sdk");
  const skipped: SkippedAttempt[] = [];
  const kept: ProviderName[] = [];

  for (const runner of attempts) {
    if (runner === "cursor_cli" && hasCursorKey && hasSdk) {
      skipped.push({ runner, reason: "prefer_auth" });
      continue;
    }
    if (runner === "cursor_sdk" && !hasCursorKey) {
      // resolve already drops this; keep if somehow present
      skipped.push({ runner, reason: "prefer_auth" });
      continue;
    }
    if (
      (runner === "openrouter" || runner === "tokenrouter") &&
      authModeForRunner(runner, env) !== "api_key"
    ) {
      skipped.push({ runner, reason: "prefer_auth" });
      continue;
    }
    kept.push(runner);
  }

  // Never empty the list solely due to prefer-auth — fall back to original.
  if (kept.length === 0 && attempts.length > 0) {
    return { kept: [...attempts], skipped: [] };
  }
  return { kept, skipped };
}

/** Prefer least-recently-used runners that are not in cooldown. */
export function orderByCapacity(
  attempts: ProviderName[],
  nowMs: number = Date.now(),
): ProviderName[] {
  return [...attempts].sort((a, b) => {
    const aCool = isInCooldown(a, nowMs) ? 1 : 0;
    const bCool = isInCooldown(b, nowMs) ? 1 : 0;
    if (aCool !== bCool) return aCool - bCool;
    const aUsed = lastUsedAtByProvider.get(a) ?? 0;
    const bUsed = lastUsedAtByProvider.get(b) ?? 0;
    return aUsed - bUsed;
  });
}

export function planAttempts(
  attempts: ProviderName[],
  options: {
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
    config?: ProviderPacingConfig;
    /** When true (auto cascade), reorder by capacity. Explicit pins keep order. */
    rotate?: boolean;
  } = {},
): { available: ProviderName[]; skipped: SkippedAttempt[] } {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  const config = options.config ?? loadPacingConfig(env);
  const rotate = options.rotate ?? true;

  const auth = filterPreferAuth(attempts, env, config);
  const skipped: SkippedAttempt[] = [...auth.skipped];
  const available: ProviderName[] = [];

  for (const runner of auth.kept) {
    if (disabledProviders.has(runner)) {
      skipped.push({ runner, reason: "disabled" });
      continue;
    }
    if (isInCooldown(runner, nowMs)) {
      skipped.push({ runner, reason: "cooldown" });
      continue;
    }
    available.push(runner);
  }

  return {
    available: rotate ? orderByCapacity(available, nowMs) : available,
    skipped,
  };
}

function computeWaitMs(
  runner: ProviderName,
  config: ProviderPacingConfig,
  nowMs: number,
  random: () => number,
): { waitMs: number; reason: PacingReason } {
  const cooldownUntil = cooldownUntilByProvider.get(runner);
  if (cooldownUntil != null && cooldownUntil > nowMs) {
    return { waitMs: cooldownUntil - nowMs, reason: "cooldown" };
  }

  let waitMs = 0;
  let reason: PacingReason = "none";

  if (lastInvokeAtMs != null && config.minGapMs > 0) {
    const jitter = config.gapJitterMs > 0 ? Math.floor(random() * (config.gapJitterMs + 1)) : 0;
    const gapTarget = config.minGapMs + jitter;
    const since = nowMs - lastInvokeAtMs;
    if (since < gapTarget) {
      waitMs = gapTarget - since;
      reason = "min_gap";
    }
  }

  const rpmWait = rpmWaitMs(runner, config.maxRpm[runner] ?? 0, nowMs);
  if (rpmWait > waitMs) {
    waitMs = rpmWait;
    reason = "rpm";
  }

  return { waitMs, reason };
}

/**
 * Block until it is safe to invoke `runner` (min gap, soft RPM, cooldown).
 * Honors AbortSignal when provided.
 */
export async function awaitBeforeInvoke(
  runner: ProviderName,
  options: {
    nowMs?: number;
    config?: ProviderPacingConfig;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<PacingWait> {
  const config = options.config ?? loadPacingConfig();
  const sleepFn = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const nowMs = options.nowMs ?? Date.now();

  const { waitMs, reason } = computeWaitMs(runner, config, nowMs, random);
  if (waitMs > 0) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    pushEvent({
      at: new Date(nowMs).toISOString(),
      kind: "wait",
      runner,
      waitMs,
      reason,
    });
    await sleepFn(waitMs);
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  return { waitMs, reason, runner };
}

export function recordInvoke(runner: ProviderName, nowMs: number = Date.now()): void {
  lastInvokeAtMs = nowMs;
  lastUsedAtByProvider.set(runner, nowMs);
  const stamps = pruneTimestamps(runner, nowMs);
  stamps.push(nowMs);
  invokeTimestampsByProvider.set(runner, stamps);
  pushEvent({
    at: new Date(nowMs).toISOString(),
    kind: "invoke",
    runner,
  });
}

/**
 * Put the provider (and Cursor family when applicable) into cooldown after a
 * rate-limit / resource_exhausted response.
 */
export function recordRateLimit(
  runner: ProviderName,
  options: {
    retryAfterMs?: number | null;
    nowMs?: number;
    config?: ProviderPacingConfig;
  } = {},
): { cooldownUntil: number; family: ProviderName[] } {
  const nowMs = options.nowMs ?? Date.now();
  const config = options.config ?? loadPacingConfig();
  const cooldownMs =
    options.retryAfterMs != null && options.retryAfterMs > 0
      ? options.retryAfterMs
      : config.cooldownMs;
  const cooldownUntil = nowMs + cooldownMs;
  const family = familyFor(runner);

  for (const member of family) {
    const prev = cooldownUntilByProvider.get(member) ?? 0;
    cooldownUntilByProvider.set(member, Math.max(prev, cooldownUntil));
    rateLimitHitsByProvider.set(member, (rateLimitHitsByProvider.get(member) ?? 0) + 1);
    lastRateLimitAtByProvider.set(member, nowMs);
  }

  pushEvent({
    at: new Date(nowMs).toISOString(),
    kind: "rate_limit",
    runner,
    cooldownUntil: new Date(cooldownUntil).toISOString(),
    reason: options.retryAfterMs != null ? "retry_after" : "default_cooldown",
  });

  return { cooldownUntil, family };
}

/** Snapshot for llm-stats / heartbeat. */
export function pacingAuditSnapshot(nowMs: number = Date.now()): {
  byProvider: Record<
    string,
    {
      lastUsedAt: string | null;
      rateLimitHits: number;
      lastRateLimitAt: string | null;
      cooldownUntil: string | null;
      inCooldown: boolean;
      authMode: AuthMode;
    }
  >;
  recentEvents: PacingEvent[];
  lastInvokeAt: string | null;
} {
  const byProvider: Record<
    string,
    {
      lastUsedAt: string | null;
      rateLimitHits: number;
      lastRateLimitAt: string | null;
      cooldownUntil: string | null;
      inCooldown: boolean;
      authMode: AuthMode;
    }
  > = {};

  for (const runner of PROVIDERS) {
    const cool = cooldownUntilByProvider.get(runner) ?? null;
    byProvider[runner] = {
      lastUsedAt: lastUsedAtByProvider.has(runner)
        ? new Date(lastUsedAtByProvider.get(runner)!).toISOString()
        : null,
      rateLimitHits: rateLimitHitsByProvider.get(runner) ?? 0,
      lastRateLimitAt: lastRateLimitAtByProvider.has(runner)
        ? new Date(lastRateLimitAtByProvider.get(runner)!).toISOString()
        : null,
      cooldownUntil: cool != null ? new Date(cool).toISOString() : null,
      inCooldown: cool != null && cool > nowMs,
      authMode: authModeForRunner(runner),
    };
  }

  return {
    byProvider,
    recentEvents: [...pacingEvents],
    lastInvokeAt: lastInvokeAtMs != null ? new Date(lastInvokeAtMs).toISOString() : null,
  };
}

export function formatPacingLog(wait: PacingWait): string {
  if (wait.waitMs <= 0 || wait.reason === "none") {
    return `pacing waitMs=0 runner=${wait.runner} reason=none`;
  }
  return `pacing waitMs=${wait.waitMs} runner=${wait.runner} reason=${wait.reason}`;
}

export function formatSkippedLog(skipped: SkippedAttempt[]): string | null {
  if (skipped.length === 0) return null;
  return `pacing skipped: ${skipped.map((s) => `${s.runner}(${s.reason})`).join(", ")}`;
}

export function syncGlobalCooldowns(
  cooldowns?: Array<{ runner: string; cooldown_until: string | null }>,
): void {
  if (!cooldowns) return;
  const now = Date.now();
  for (const c of cooldowns) {
    const t = c.cooldown_until ? new Date(c.cooldown_until).getTime() : 0;
    const isAvailabilityMarker = c.runner.endsWith(MODEL_DISABLED_RUNNER_SUFFIX);
    const runner = (isAvailabilityMarker
      ? c.runner.slice(0, -MODEL_DISABLED_RUNNER_SUFFIX.length)
      : c.runner) as ProviderName;

    if (!PROVIDERS.includes(runner)) continue;

    if (isAvailabilityMarker) {
      if (t === MODEL_DISABLED_UNTIL_MS) disabledProviders.add(runner);
      else disabledProviders.delete(runner);
      continue;
    }

    // Accept the original unsuffixed sentinel for older control planes.
    if (t === MODEL_DISABLED_UNTIL_MS) {
      disabledProviders.add(c.runner as ProviderName);
      // The durable marker represents availability, not a usage-limit cooldown.
      // Keep it out of pacing/heartbeat cooldown state so disabled models do not
      // surface a misleading 12/31/9999 cooldown date.
      cooldownUntilByProvider.delete(c.runner as ProviderName);
      continue;
    }
    if (t > now) {
      cooldownUntilByProvider.set(runner, t);
    } else if (cooldownUntilByProvider.has(runner)) {
      // only clear if it was previously set globally and is now removed
      const current = cooldownUntilByProvider.get(runner)!;
      if (current < now || current === t || current === MODEL_DISABLED_UNTIL_MS) {
        cooldownUntilByProvider.delete(runner);
      }
    }
  }
}
