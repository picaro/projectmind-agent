import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitBeforeInvoke,
  authModeForRunner,
  filterPreferAuth,
  formatPacingLog,
  isInCooldown,
  isProviderDisabled,
  isRateLimitError,
  loadPacingConfig,
  orderByCapacity,
  parseRetryAfterMs,
  pacingAuditSnapshot,
  planAttempts,
  recordInvoke,
  recordRateLimit,
  resetProviderPacing,
  syncGlobalCooldowns,
  type ProviderPacingConfig,
} from "./provider-pacing.js";

const baseConfig = (): ProviderPacingConfig => ({
  minGapMs: 1_000,
  gapJitterMs: 0,
  cooldownMs: 5_000,
  maxRpm: {
    cursor_sdk: 2,
    cursor_cli: 2,
    codex_cli: 10,
    antigravity_cli: 10,
    claude_cli: 10,
    copilot_cli: 10,
    openrouter: 10,
    tokenrouter: 10,
  },
  preferAuthenticated: true,
});

beforeEach(() => {
  resetProviderPacing();
});

afterEach(() => {
  resetProviderPacing();
  vi.restoreAllMocks();
});

describe("isRateLimitError / parseRetryAfterMs", () => {
  it("detects common rate-limit shapes", () => {
    expect(isRateLimitError("resource_exhausted")).toBe(true);
    expect(isRateLimitError("HTTP 429 Too Many Requests")).toBe(true);
    expect(isRateLimitError("rate limit exceeded")).toBe(true);
    expect(isRateLimitError("quota exceeded")).toBe(true);
    expect(isRateLimitError("Individual quota reached. Resets in 1h20m35s.")).toBe(true);
    expect(isRateLimitError("You've hit your usage limit")).toBe(true);
    expect(isRateLimitError("Cursor run failed")).toBe(false);
  });

  it("parses Retry-After seconds and ms", () => {
    expect(parseRetryAfterMs("retry-after: 12")).toBe(12_000);
    expect(parseRetryAfterMs("Retry-After=1.5")).toBe(1_500);
    expect(parseRetryAfterMs("retry_after_ms=2500")).toBe(2_500);
    expect(parseRetryAfterMs("Individual quota reached. Resets in 1h20m35s.")).toBe(4_835_000);
    expect(parseRetryAfterMs("Resets in 44m45s.")).toBe(2_685_000);
    expect(parseRetryAfterMs("no hint")).toBeNull();
  });
});

describe("loadPacingConfig", () => {
  it("reads env overrides", () => {
    const cfg = loadPacingConfig({
      IMEMORY_PROVIDER_MIN_GAP_MS: "20000",
      IMEMORY_PROVIDER_GAP_JITTER_MS: "1000",
      IMEMORY_PROVIDER_COOLDOWN_MS: "60000",
      IMEMORY_CURSOR_MAX_RPM: "3",
      IMEMORY_PREFER_AUTHENTICATED: "0",
    });
    expect(cfg.minGapMs).toBe(20_000);
    expect(cfg.gapJitterMs).toBe(1_000);
    expect(cfg.cooldownMs).toBe(60_000);
    expect(cfg.maxRpm.cursor_sdk).toBe(3);
    expect(cfg.preferAuthenticated).toBe(false);
  });
});

describe("authModeForRunner", () => {
  it("reports api_key when Cursor key is set", () => {
    expect(authModeForRunner("cursor_sdk", { CURSOR_API_KEY: "k" })).toBe("api_key");
    expect(authModeForRunner("cursor_cli", { CURSOR_API_KEY: "k" })).toBe("api_key");
    expect(authModeForRunner("cursor_cli", {})).toBe("cli_login");
    expect(authModeForRunner("antigravity_cli", {})).toBe("cli_login");
    expect(authModeForRunner("claude_cli", { ANTHROPIC_API_KEY: "k" })).toBe("api_key");
    expect(authModeForRunner("claude_cli", {})).toBe("cli_login");
    expect(authModeForRunner("copilot_cli", { COPILOT_GITHUB_TOKEN: "k" })).toBe("api_key");
    expect(authModeForRunner("copilot_cli", {})).toBe("cli_login");
    expect(authModeForRunner("openrouter", { OPENROUTER_API_KEY: "k" })).toBe("api_key");
    expect(authModeForRunner("openrouter", {})).toBe("unknown");
    expect(authModeForRunner("tokenrouter", { TOKENROUTER_API_KEY: "k" })).toBe("api_key");
    expect(authModeForRunner("tokenrouter", {})).toBe("unknown");
  });
});

describe("filterPreferAuth / planAttempts", () => {
  it("skips cursor_cli when key and sdk are present", () => {
    const { kept, skipped } = filterPreferAuth(
      ["cursor_sdk", "cursor_cli", "antigravity_cli"],
      { CURSOR_API_KEY: "k" },
      baseConfig(),
    );
    expect(kept).toEqual(["cursor_sdk", "antigravity_cli"]);
    expect(skipped).toEqual([{ runner: "cursor_cli", reason: "prefer_auth" }]);
  });

  it("keeps cursor_cli when no API key", () => {
    const { kept } = filterPreferAuth(
      ["cursor_cli", "antigravity_cli"],
      { CURSOR_API_KEY: "" },
      baseConfig(),
    );
    expect(kept).toEqual(["cursor_cli", "antigravity_cli"]);
  });

  it("skips cooling-down runners even when no alternative is available", () => {
    recordRateLimit("cursor_sdk", { nowMs: 1_000, config: baseConfig() });
    const planned = planAttempts(["cursor_sdk", "antigravity_cli"], {
      nowMs: 1_500,
      env: { CURSOR_API_KEY: "k" },
      config: baseConfig(),
      rotate: false,
    });
    expect(planned.available).toEqual(["antigravity_cli"]);
    expect(planned.skipped.some((s) => s.runner === "cursor_sdk" && s.reason === "cooldown")).toBe(
      true,
    );

    const allCool = planAttempts(["cursor_sdk"], {
      nowMs: 1_500,
      env: { CURSOR_API_KEY: "k" },
      config: baseConfig(),
      rotate: false,
    });
    expect(allCool.available).toEqual([]);
    expect(allCool.skipped).toContainEqual({ runner: "cursor_sdk", reason: "cooldown" });
  });

  it("removes disabled runners without falling back to them", () => {
    syncGlobalCooldowns([
      { runner: "cursor_sdk::disabled", cooldown_until: "9999-12-31T23:59:59.999Z" },
      { runner: "codex_cli::disabled", cooldown_until: "9999-12-31T23:59:59.999Z" },
    ]);

    expect(pacingAuditSnapshot(1_500).byProvider.cursor_sdk).toMatchObject({
      cooldownUntil: null,
      inCooldown: false,
    });

    const planned = planAttempts(["cursor_sdk", "codex_cli"], {
      nowMs: 1_500,
      env: { CURSOR_API_KEY: "k" },
      config: baseConfig(),
      rotate: false,
    });

    expect(planned.available).toEqual([]);
    expect(planned.skipped).toEqual([
      { runner: "cursor_sdk", reason: "disabled" },
      { runner: "codex_cli", reason: "disabled" },
    ]);

    syncGlobalCooldowns([
      { runner: "cursor_sdk::disabled", cooldown_until: null },
      { runner: "codex_cli::disabled", cooldown_until: null },
    ]);
    expect(
      planAttempts(["cursor_sdk", "codex_cli"], {
        nowMs: 1_500,
        env: { CURSOR_API_KEY: "k" },
        config: baseConfig(),
        rotate: false,
      }).available,
    ).toEqual(["cursor_sdk", "codex_cli"]);
  });

  it("keeps a turned-off provider disabled when receiving both a disabled marker and a plain row", () => {
    syncGlobalCooldowns([
      { runner: "cursor_cli::disabled", cooldown_until: "9999-12-31T23:59:59.999Z" },
      { runner: "cursor_cli", cooldown_until: null },
    ]);

    expect(isProviderDisabled("cursor_cli")).toBe(true);

    const planned = planAttempts(["cursor_cli"], {
      nowMs: 1_500,
      config: baseConfig(),
      rotate: false,
    });
    expect(planned.available).toEqual([]);
    expect(planned.skipped).toEqual([{ runner: "cursor_cli", reason: "disabled" }]);
  });
});

describe("orderByCapacity", () => {
  it("prefers least-recently-used runners", () => {
    recordInvoke("cursor_sdk", 100);
    recordInvoke("antigravity_cli", 200);
    expect(orderByCapacity(["cursor_sdk", "antigravity_cli"], 300)).toEqual([
      "cursor_sdk",
      "antigravity_cli",
    ]);
  });
});

describe("awaitBeforeInvoke", () => {
  it("waits for min gap with no jitter", async () => {
    const sleeps: number[] = [];
    recordInvoke("codex_cli", 0);
    const wait = await awaitBeforeInvoke("antigravity_cli", {
      nowMs: 200,
      config: baseConfig(),
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(wait.reason).toBe("min_gap");
    expect(wait.waitMs).toBe(800);
    expect(sleeps).toEqual([800]);
    expect(formatPacingLog(wait)).toContain("reason=min_gap");
  });

  it("clears a sticky local cooldown when the server sends null", () => {
    recordRateLimit("cursor_cli", {
      nowMs: 1_000,
      retryAfterMs: 60 * 60 * 1000,
      config: baseConfig(),
    });
    expect(isInCooldown("cursor_cli", 5_000)).toBe(true);
    expect(isInCooldown("cursor_sdk", 5_000)).toBe(true);

    syncGlobalCooldowns([
      { runner: "cursor_cli", cooldown_until: null },
      { runner: "cursor_sdk", cooldown_until: null },
    ]);

    expect(isInCooldown("cursor_cli", 5_000)).toBe(false);
    expect(isInCooldown("cursor_sdk", 5_000)).toBe(false);
  });

  it("waits for soft RPM cap", async () => {
    const sleeps: number[] = [];
    const cfg = baseConfig();
    cfg.minGapMs = 0;
    cfg.maxRpm.cursor_sdk = 2;
    recordInvoke("cursor_sdk", 0);
    recordInvoke("cursor_sdk", 10);
    const wait = await awaitBeforeInvoke("cursor_sdk", {
      nowMs: 20,
      config: cfg,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(wait.reason).toBe("rpm");
    expect(wait.waitMs).toBeGreaterThan(0);
    expect(sleeps).toEqual([wait.waitMs]);
  });

  it("waits for cooldown", async () => {
    const sleeps: number[] = [];
    recordRateLimit("codex_cli", {
      nowMs: 0,
      config: { ...baseConfig(), cooldownMs: 3_000 },
    });
    const wait = await awaitBeforeInvoke("codex_cli", {
      nowMs: 500,
      config: { ...baseConfig(), minGapMs: 0, cooldownMs: 3_000 },
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(wait.reason).toBe("cooldown");
    expect(wait.waitMs).toBe(2_500);
    expect(sleeps).toEqual([2_500]);
  });
});

describe("recordRateLimit", () => {
  it("cools down the Cursor family together", () => {
    const { family, cooldownUntil } = recordRateLimit("cursor_cli", {
      nowMs: 1_000,
      retryAfterMs: 10_000,
      config: baseConfig(),
    });
    expect(family).toEqual(["cursor_sdk", "cursor_cli"]);
    expect(cooldownUntil).toBe(11_000);
    expect(isInCooldown("cursor_sdk", 5_000)).toBe(true);
    expect(isInCooldown("cursor_cli", 5_000)).toBe(true);
    expect(isInCooldown("antigravity_cli", 5_000)).toBe(false);
  });
});
