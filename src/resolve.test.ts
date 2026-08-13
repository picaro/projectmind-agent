import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  isRetryableRunnerFailure,
  resolveAutoRunnerChain,
  resolveRunnerAttempts,
  handleRunnerResult,
  resetRunnerOverride,
  runnerOverride,
} from "./runners/resolve.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.IMEMORY_DEFAULT_RUNNER;
  delete process.env.IMEMORY_DEFAULT_AI;
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetRunnerOverride();
});

describe("resolveAutoRunnerChain", () => {
  it("prefers Cursor SDK when API key is present, then CLIs", async () => {
    const chain = await resolveAutoRunnerChain({
      cursorKey: "cursor_test_key",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      claudeBin: "claude",
      copilotBin: "copilot",
      openRouterKey: "",
      tokenRouterKey: "",
      llmApiKey: "",
      commandExists: async (cmd) =>
        cmd === "agent" ||
        cmd === "codex" ||
        cmd === "agy" ||
        cmd === "claude" ||
        cmd === "copilot",
    });
    expect(chain).toEqual([
      "cursor_sdk",
      "cursor_cli",
      "codex_cli",
      "antigravity_cli",
      "claude_cli",
      "copilot_cli",
    ]);
  });

  it("includes openrouter and tokenrouter when keys are configured", async () => {
    const chain = await resolveAutoRunnerChain({
      cursorKey: "",
      commandExists: async () => false,
      openRouterKey: "or_key",
      tokenRouterKey: "tr_key",
    });
    expect(chain).toEqual(["openrouter", "tokenrouter"]);
  });

  it("skips SDK when no API key", async () => {
    const chain = await resolveAutoRunnerChain({
      cursorKey: "",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      claudeBin: "claude",
      copilotBin: "copilot",
      openRouterKey: "",
      tokenRouterKey: "",
      llmApiKey: "",
      commandExists: async (cmd) =>
        cmd === "agent" ||
        cmd === "codex" ||
        cmd === "agy" ||
        cmd === "claude" ||
        cmd === "copilot",
    });
    expect(chain).toEqual([
      "cursor_cli",
      "codex_cli",
      "antigravity_cli",
      "claude_cli",
      "copilot_cli",
    ]);
  });

  it("skips missing binaries", async () => {
    const chain = await resolveAutoRunnerChain({
      cursorKey: "",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      claudeBin: "claude",
      copilotBin: "copilot",
      openRouterKey: "",
      tokenRouterKey: "",
      llmApiKey: "",
      commandExists: async (cmd) => cmd === "agent",
    });
    expect(chain).toEqual(["cursor_cli"]);
  });

  it("includes antigravity when only agy is available", async () => {
    const chain = await resolveAutoRunnerChain({
      cursorKey: "",
      commandExists: async (cmd) => cmd === "agy",
      antigravityBin: "agy",
      openRouterKey: "",
      tokenRouterKey: "",
      llmApiKey: "",
    });
    expect(chain).toEqual(["antigravity_cli"]);
  });

  it("includes claude and copilot when those binaries exist", async () => {
    const chain = await resolveAutoRunnerChain({
      cursorKey: "",
      commandExists: async (cmd) => cmd === "claude" || cmd === "copilot",
      claudeBin: "claude",
      copilotBin: "copilot",
      openRouterKey: "",
      tokenRouterKey: "",
      llmApiKey: "",
    });
    expect(chain).toEqual(["claude_cli", "copilot_cli"]);
  });

  it("returns empty when nothing is available", async () => {
    const chain = await resolveAutoRunnerChain({
      cursorKey: "",
      commandExists: async () => false,
      openRouterKey: "",
      tokenRouterKey: "",
      llmApiKey: "",
    });
    expect(chain).toEqual([]);
  });
});

describe("resolveRunnerAttempts", () => {
  it("pins only explicit runner when hardRule is true", async () => {
    const deps = {
      cursorKey: "",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      claudeBin: "claude",
      copilotBin: "copilot",
      commandExists: async (cmd: string) =>
        cmd === "agent" ||
        cmd === "codex" ||
        cmd === "agy" ||
        cmd === "claude" ||
        cmd === "copilot",
    };
    expect(await resolveRunnerAttempts("claude_cli", deps, { hardRule: true })).toEqual(["claude_cli"]);
    expect(await resolveRunnerAttempts("codex_cli", deps, { hardRule: true })).toEqual(["codex_cli"]);
  });

  it("places explicit runner first and appends remaining auto cascade when hardRule is false", async () => {
    const deps = {
      cursorKey: "",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      claudeBin: "claude",
      copilotBin: "copilot",
      commandExists: async (cmd: string) =>
        cmd === "agent" ||
        cmd === "codex" ||
        cmd === "agy" ||
        cmd === "claude" ||
        cmd === "copilot",
    };
    expect(await resolveRunnerAttempts("claude_cli", deps, { hardRule: false })).toEqual([
      "claude_cli",
      "cursor_cli",
      "codex_cli",
      "antigravity_cli",
      "copilot_cli",
    ]);
  });

  it("uses auto cascade for cursor_sdk and auto when no API key", async () => {
    const deps = {
      cursorKey: "",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      claudeBin: "claude",
      copilotBin: "copilot",
      commandExists: async (cmd: string) =>
        cmd === "agent" ||
        cmd === "codex" ||
        cmd === "agy" ||
        cmd === "claude" ||
        cmd === "copilot",
    };
    expect(await resolveRunnerAttempts("cursor_sdk", deps)).toEqual([
      "cursor_cli",
      "codex_cli",
      "antigravity_cli",
      "claude_cli",
      "copilot_cli",
    ]);
    expect(await resolveRunnerAttempts("auto", deps)).toEqual([
      "cursor_cli",
      "codex_cli",
      "antigravity_cli",
      "claude_cli",
      "copilot_cli",
    ]);
  });

  it("includes SDK first when API key is present", async () => {
    const deps = {
      cursorKey: "cursor_test_key",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      commandExists: async (cmd: string) => cmd === "agent" || cmd === "codex" || cmd === "agy",
    };
    expect(await resolveRunnerAttempts("cursor_sdk", deps)).toEqual([
      "cursor_sdk",
      "cursor_cli",
      "codex_cli",
      "antigravity_cli",
    ]);
  });
});

describe("isRetryableRunnerFailure", () => {
  it("retries startup / missing binary failures", () => {
    expect(
      isRetryableRunnerFailure({
        status: "failed",
        summary: "",
        error: "CURSOR_API_KEY is required for cursor_sdk runner",
      }),
    ).toBe(true);
    expect(
      isRetryableRunnerFailure({
        status: "failed",
        summary: "",
        error: "Failed to spawn agent: ENOENT",
      }),
    ).toBe(true);
    expect(
      isRetryableRunnerFailure({
        status: "failed",
        summary: "",
        error: "Cursor CLI exited with code 127",
      }),
    ).toBe(true);
  });

  it("does not retry successful or cancelled results", () => {
    expect(isRetryableRunnerFailure({ status: "succeeded", summary: "ok" })).toBe(false);
    expect(isRetryableRunnerFailure({ status: "cancelled", summary: "Cancelled" })).toBe(false);
  });

  it("does not retry mid-run task failures", () => {
    expect(
      isRetryableRunnerFailure({
        status: "failed",
        summary: "",
        error: "Cursor run failed (run_abc)",
      }),
    ).toBe(false);
  });

  it("retries on rate-limit / resource_exhausted so the next provider can run", () => {
    expect(
      isRetryableRunnerFailure({
        status: "failed",
        summary: "",
        error: "RetriableError: [resource_exhausted] Error.",
      }),
    ).toBe(true);
    expect(
      isRetryableRunnerFailure({
        status: "failed",
        summary: "",
        error: "HTTP 429 rate limit exceeded",
      }),
    ).toBe(true);
  });
});

describe("default runner from environment", () => {
  const originalEnv = { ...process.env };

  const deps = {
    cursorKey: "",
    cursorBin: "agent",
    codexBin: "codex",
    antigravityBin: "agy",
    claudeBin: "claude",
    copilotBin: "copilot",
    commandExists: async (cmd: string) =>
      ["agent", "codex", "agy", "claude", "copilot"].includes(cmd),
  };

  afterEach(async () => {
    process.env = { ...originalEnv };
    resetRunnerOverride();
    const { resetProviderPacing } = await import("./provider-pacing.js");
    resetProviderPacing();
  });

  it("respects IMEMORY_DEFAULT_RUNNER, keeping the cascade behind it", async () => {
    process.env.IMEMORY_DEFAULT_RUNNER = "antigravity_cli";
    const attempts = await resolveRunnerAttempts("auto", deps);
    expect(attempts).toEqual([
      "antigravity_cli",
      "cursor_cli",
      "codex_cli",
      "claude_cli",
      "copilot_cli",
    ]);
  });

  it("respects IMEMORY_DEFAULT_AI, keeping the cascade behind it", async () => {
    delete process.env.IMEMORY_DEFAULT_RUNNER;
    process.env.IMEMORY_DEFAULT_AI = "codex_cli";
    const attempts = await resolveRunnerAttempts("auto", deps);
    expect(attempts).toEqual([
      "codex_cli",
      "cursor_cli",
      "antigravity_cli",
      "claude_cli",
      "copilot_cli",
    ]);
  });

  it("still has runners available when the default runner is disabled server-side", async () => {
    const { planAttempts, syncGlobalCooldowns } = await import("./provider-pacing.js");
    syncGlobalCooldowns([
      { runner: "cursor_cli", cooldown_until: "2999-01-01T00:00:00.000Z" },
      { runner: "cursor_cli::disabled", cooldown_until: "9999-12-31T23:59:59.999Z" },
      { runner: "codex_cli::disabled", cooldown_until: "9999-12-31T23:59:59.999Z" },
      { runner: "copilot_cli::disabled", cooldown_until: "9999-12-31T23:59:59.999Z" },
    ]);
    process.env.IMEMORY_DEFAULT_RUNNER = "cursor_cli";

    const attempts = await resolveRunnerAttempts("auto", deps);
    const { available } = planAttempts(attempts, { rotate: false });

    expect(available).toEqual(["antigravity_cli", "claude_cli"]);
  });
});

describe("runner auto-switching on resource exhaustion", () => {
  afterEach(() => {
    resetRunnerOverride();
  });

  it("switches to antigravity_cli after 2 Cursor resource exhaustion errors", async () => {
    const deps = {
      cursorKey: "cursor_test_key",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      commandExists: async (cmd: string) => cmd === "agent" || cmd === "codex" || cmd === "agy",
    };

    // Before error, auto resolves normally (e.g. cursor_sdk cascading)
    let attempts = await resolveRunnerAttempts("auto", deps);
    expect(attempts[0]).toBe("cursor_sdk");

    // First Cursor failure: resource exhausted
    handleRunnerResult("cursor_cli", {
      status: "failed",
      summary: "",
      error: "Cursor CLI exited with code 1: RetriableError: [resource_exhausted] Error.",
    });

    // Still auto resolves normally (needs 2 errors)
    attempts = await resolveRunnerAttempts("auto", deps);
    expect(attempts[0]).toBe("cursor_sdk");

    // Second Cursor failure: rate limit
    handleRunnerResult("cursor_sdk", {
      status: "failed",
      summary: "",
      error: "rate limit exceeded",
    });

    // Now it should override and resolve directly to antigravity_cli!
    attempts = await resolveRunnerAttempts("auto", deps);
    expect(attempts).toEqual(["antigravity_cli"]);

    // Explicit cursor_cli pin must not be overridden by the exhaustion fallback
    attempts = await resolveRunnerAttempts("cursor_cli", deps);
    expect(attempts).toEqual(["cursor_cli"]);

    // If antigravity_cli itself fails, it resets the override
    handleRunnerResult("antigravity_cli", {
      status: "failed",
      summary: "",
      error: "Antigravity CLI exited with code 1: Some other error",
    });

    attempts = await resolveRunnerAttempts("auto", deps);
    expect(attempts[0]).toBe("cursor_sdk");
  });

  it("does not switch override to antigravity_cli if it is disabled or in cooldown", async () => {
    const deps = {
      cursorKey: "cursor_test_key",
      cursorBin: "agent",
      codexBin: "codex",
      antigravityBin: "agy",
      commandExists: async (cmd: string) => cmd === "agent" || cmd === "codex" || cmd === "agy",
    };

    // First, sync global cooldown to disable antigravity_cli
    const { syncGlobalCooldowns } = await import("./provider-pacing.js");
    syncGlobalCooldowns([
      { runner: "antigravity_cli::disabled", cooldown_until: "9999-12-31T23:59:59.999Z" }
    ]);

    // Two Cursor failures: resource exhausted
    handleRunnerResult("cursor_cli", {
      status: "failed",
      summary: "",
      error: "rate limit exceeded",
    });
    handleRunnerResult("cursor_sdk", {
      status: "failed",
      summary: "",
      error: "rate limit exceeded",
    });

    // It should NOT set override to antigravity_cli because it is disabled
    expect(runnerOverride).toBeNull();

    // Now let's try with cooldown (not disabled)
    // Clear disabled first
    syncGlobalCooldowns([
      { runner: "antigravity_cli::disabled", cooldown_until: null }
    ]);
    const { recordRateLimit } = await import("./provider-pacing.js");
    recordRateLimit("antigravity_cli");

    handleRunnerResult("cursor_cli", {
      status: "failed",
      summary: "",
      error: "rate limit exceeded",
    });
    handleRunnerResult("cursor_sdk", {
      status: "failed",
      summary: "",
      error: "rate limit exceeded",
    });

    // It should NOT set override to antigravity_cli because it is in cooldown
    expect(runnerOverride).toBeNull();
  });

  it("resets cursor failure count on success", () => {
    // First error
    handleRunnerResult("cursor_cli", {
      status: "failed",
      summary: "",
      error: "rate limit",
    });
    // Success
    handleRunnerResult("cursor_cli", {
      status: "succeeded",
      summary: "success",
    });
    // Another failure (should be count 1 again, not switching yet)
    handleRunnerResult("cursor_cli", {
      status: "failed",
      summary: "",
      error: "rate limit",
    });

    // We shouldn't have switched since it wasn't consecutive
    expect(runnerOverride).toBeNull();
  });
});
