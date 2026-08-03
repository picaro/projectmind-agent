import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Runner, RunnerName, RunnerResult } from "./types.js";
import { createCursorSdkRunner } from "./cursor.js";
import { createCursorCliRunner } from "./cursor-cli.js";
import { createCodexCliRunner } from "./codex-cli.js";
import { createAntigravityCliRunner } from "./antigravity-cli.js";
import { createClaudeCliRunner } from "./claude-cli.js";
import { createCopilotCliRunner } from "./copilot-cli.js";
import { createOpenRouterRunner, createTokenRouterRunner } from "./llm.js";
import { createGatewayRunner, type ExecutionModelGateway } from "./gateway.js";
import {
  isRateLimitError,
  parseRetryAfterMs,
  recordRateLimit,
  resetProviderPacing,
  type ProviderName,
  isProviderDisabled,
  isInCooldown,
} from "../provider-pacing.js";

const BLOCKED_MODEL = "gpt-5.6-sol";
const SAFE_MODEL = "luna";

function safeConfiguredModel(model?: string | null): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().replace(/_/g, ".") === BLOCKED_MODEL ? SAFE_MODEL : trimmed;
}

/** Runners the Mac agent can auto-select / fall through. */
export type AutoRunnerName =
  | "cursor_sdk"
  | "cursor_cli"
  | "codex_cli"
  | "antigravity_cli"
  | "claude_cli"
  | "copilot_cli"
  | "openrouter"
  | "tokenrouter";

export function cursorApiKey(): string {
  return process.env.CURSOR_API_KEY?.trim() || "";
}

export function codexApiKey(): string {
  return process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
}

export function claudeApiKey(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() || process.env.IMEMORY_CLAUDE_API_KEY?.trim() || "";
}

export function copilotApiKey(): string {
  return (
    process.env.COPILOT_GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    ""
  );
}

export function cursorCliBin(): string {
  return (
    process.env.IMEMORY_CURSOR_CLI_BIN?.trim() || process.env.CURSOR_CLI_BIN?.trim() || "agent"
  );
}

export function codexCliBin(): string {
  return process.env.IMEMORY_CODEX_CLI_BIN?.trim() || process.env.CODEX_CLI_BIN?.trim() || "codex";
}

export function antigravityCliBin(): string {
  return (
    process.env.IMEMORY_ANTIGRAVITY_CLI_BIN?.trim() ||
    process.env.ANTIGRAVITY_CLI_BIN?.trim() ||
    "agy"
  );
}

export function claudeCliBin(): string {
  return (
    process.env.IMEMORY_CLAUDE_CLI_BIN?.trim() || process.env.CLAUDE_CLI_BIN?.trim() || "claude"
  );
}

export function copilotCliBin(): string {
  return (
    process.env.IMEMORY_COPILOT_CLI_BIN?.trim() || process.env.COPILOT_CLI_BIN?.trim() || "copilot"
  );
}

/** True if `command` is an absolute/relative executable path or on PATH. */
export async function commandExists(command: string): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) return false;

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    try {
      await access(path.resolve(trimmed), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  return new Promise((resolve) => {
    const child = spawn("which", [trimmed], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Diagnostic info about why each provider was included or excluded from the
 * auto-resolve chain. Used for troubleshooting "no runners available" issues.
 */
export type RunnerAvailabilityEntry = {
  runner: AutoRunnerName;
  available: boolean;
  reason: string;
};

/**
 * Resolve the auto-runner chain AND return diagnostic info about why each
 * provider was included or excluded. This is the primary troubleshooting tool
 * for "why did my job get declined?" — it shows exactly which env vars and
 * binaries are missing on the agent machine.
 */
export async function resolveAutoRunnerChainWithDiagnostics(
  deps: {
    cursorKey?: string;
    commandExists?: (command: string) => Promise<boolean>;
    cursorBin?: string;
    codexBin?: string;
    antigravityBin?: string;
    claudeBin?: string;
    copilotBin?: string;
    openRouterKey?: string;
    tokenRouterKey?: string;
    llmApiKey?: string;
  } = {},
): Promise<{ chain: AutoRunnerName[]; diagnostics: RunnerAvailabilityEntry[] }> {
  const key = deps.cursorKey ?? cursorApiKey();
  const exists = deps.commandExists ?? commandExists;
  const cursorBin = deps.cursorBin ?? cursorCliBin();
  const codexBin = deps.codexBin ?? codexCliBin();
  const antigravityBin = deps.antigravityBin ?? antigravityCliBin();
  const claudeBin = deps.claudeBin ?? claudeCliBin();
  const copilotBin = deps.copilotBin ?? copilotCliBin();
  const openRouterKey =
    deps.openRouterKey ??
    (process.env.OPENROUTER_API_KEY?.trim() ||
      process.env.IMEMORY_OPENROUTER_API_KEY?.trim() ||
      "");
  const tokenRouterKey =
    deps.tokenRouterKey ??
    (process.env.TOKENROUTER_API_KEY?.trim() ||
      process.env.IMEMORY_TOKENROUTER_API_KEY?.trim() ||
      "");

  const chain: AutoRunnerName[] = [];
  const diagnostics: RunnerAvailabilityEntry[] = [];

  // cursor_sdk: requires CURSOR_API_KEY
  if (key) {
    chain.push("cursor_sdk");
    diagnostics.push({ runner: "cursor_sdk", available: true, reason: "CURSOR_API_KEY set" });
  } else {
    diagnostics.push({
      runner: "cursor_sdk",
      available: false,
      reason: "CURSOR_API_KEY not set",
    });
  }

  // cursor_cli: requires agent binary on PATH
  const cursorExists = await exists(cursorBin);
  if (cursorExists) {
    chain.push("cursor_cli");
    diagnostics.push({ runner: "cursor_cli", available: true, reason: `binary found: ${cursorBin}` });
  } else {
    diagnostics.push({
      runner: "cursor_cli",
      available: false,
      reason: `binary not found: ${cursorBin}`,
    });
  }

  // codex_cli: requires codex binary on PATH
  const codexExists = await exists(codexBin);
  if (codexExists) {
    chain.push("codex_cli");
    diagnostics.push({ runner: "codex_cli", available: true, reason: `binary found: ${codexBin}` });
  } else {
    diagnostics.push({
      runner: "codex_cli",
      available: false,
      reason: `binary not found: ${codexBin}`,
    });
  }

  // antigravity_cli: requires agy binary on PATH
  const antigravityExists = await exists(antigravityBin);
  if (antigravityExists) {
    chain.push("antigravity_cli");
    diagnostics.push({
      runner: "antigravity_cli",
      available: true,
      reason: `binary found: ${antigravityBin}`,
    });
  } else {
    diagnostics.push({
      runner: "antigravity_cli",
      available: false,
      reason: `binary not found: ${antigravityBin}`,
    });
  }

  // claude_cli: requires claude binary on PATH
  const claudeExists = await exists(claudeBin);
  if (claudeExists) {
    chain.push("claude_cli");
    diagnostics.push({ runner: "claude_cli", available: true, reason: `binary found: ${claudeBin}` });
  } else {
    diagnostics.push({
      runner: "claude_cli",
      available: false,
      reason: `binary not found: ${claudeBin}`,
    });
  }

  // copilot_cli: requires copilot binary on PATH
  const copilotExists = await exists(copilotBin);
  if (copilotExists) {
    chain.push("copilot_cli");
    diagnostics.push({
      runner: "copilot_cli",
      available: true,
      reason: `binary found: ${copilotBin}`,
    });
  } else {
    diagnostics.push({
      runner: "copilot_cli",
      available: false,
      reason: `binary not found: ${copilotBin}`,
    });
  }

  // openrouter: requires OPENROUTER_API_KEY or IMEMORY_OPENROUTER_API_KEY
  if (openRouterKey) {
    chain.push("openrouter");
    diagnostics.push({
      runner: "openrouter",
      available: true,
      reason: "OPENROUTER_API_KEY set",
    });
  } else {
    diagnostics.push({
      runner: "openrouter",
      available: false,
      reason: "OPENROUTER_API_KEY / IMEMORY_OPENROUTER_API_KEY not set",
    });
  }

  // tokenrouter: requires TOKENROUTER_API_KEY or IMEMORY_TOKENROUTER_API_KEY
  if (tokenRouterKey) {
    chain.push("tokenrouter");
    diagnostics.push({
      runner: "tokenrouter",
      available: true,
      reason: "TOKENROUTER_API_KEY set",
    });
  } else {
    diagnostics.push({
      runner: "tokenrouter",
      available: false,
      reason: "TOKENROUTER_API_KEY / IMEMORY_TOKENROUTER_API_KEY not set",
    });
  }



  return { chain, diagnostics };
}

/**
 * Format the diagnostics array into a human-readable string for logging.
 * Example: "cursor_sdk(key) cursor_cli(bin) codex_cli(missing) antigravity_cli(missing) ..."
 */
export function formatRunnerDiagnostics(diagnostics: RunnerAvailabilityEntry[]): string {
  return diagnostics
    .map((d) => `${d.runner}(${d.available ? "ok" : "missing"})`)
    .join(" ");
}

/**
 * Preferred order for auto mode:
 * 1. Cursor SDK when CURSOR_API_KEY is set
 * 2. Cursor CLI when the binary is available
 * 3. Codex CLI when the binary is available
 * 4. Antigravity CLI (`agy`) when the binary is available
 * 5. Claude Code CLI when the binary is available
 * 6. Copilot CLI when the binary is available
 */
export async function resolveAutoRunnerChain(
  deps: {
    cursorKey?: string;
    commandExists?: (command: string) => Promise<boolean>;
    cursorBin?: string;
    codexBin?: string;
    antigravityBin?: string;
    claudeBin?: string;
    copilotBin?: string;
    openRouterKey?: string;
    tokenRouterKey?: string;
  } = {},
): Promise<AutoRunnerName[]> {
  const { chain } = await resolveAutoRunnerChainWithDiagnostics(deps);
  return chain;
}

/**
 * Build a runner by name. `modelOverride` (job- or agent-configured model, from the
 * server) takes priority over the runner's local env-var default when non-empty.
 */
export function createRunnerByName(
  name: Exclude<RunnerName, "auto">,
  modelOverride?: string | null,
  /**
   * Execution-scoped gateway grant from the claim response. When present the
   * HTTP runners go through ProjectMind's LLM gateway instead of resolving a
   * provider key from the environment, so the server owns model choice,
   * funding, quota, and budget. Absent (older control plane, or a job with no
   * billable owner) they fall back to the legacy direct-to-provider path.
   */
  gatewayGrant?: { executionId: string; gateway: ExecutionModelGateway } | null,
): Runner {
  const override = safeConfiguredModel(modelOverride);

  if ((name === "openrouter" || name === "tokenrouter") && gatewayGrant?.gateway?.token) {
    return createGatewayRunner({
      name,
      executionId: gatewayGrant.executionId,
      gateway: gatewayGrant.gateway,
    });
  }

  if (name === "openrouter") {
    return createOpenRouterRunner({
      apiKey:
        process.env.OPENROUTER_API_KEY?.trim() ||
        process.env.IMEMORY_OPENROUTER_API_KEY?.trim() ||
        "",
      model:
        override ||
        safeConfiguredModel(
          process.env.IMEMORY_OPENROUTER_MODEL || process.env.OPENROUTER_MODEL,
        ),
      baseUrl:
        process.env.IMEMORY_OPENROUTER_BASE_URL?.trim() ||
        process.env.OPENROUTER_BASE_URL?.trim(),
      httpReferer:
        process.env.IMEMORY_OPENROUTER_HTTP_REFERER?.trim() ||
        process.env.OPENROUTER_HTTP_REFERER?.trim(),
      appTitle:
        process.env.IMEMORY_OPENROUTER_APP_TITLE?.trim() ||
        process.env.OPENROUTER_APP_TITLE?.trim(),
    });
  }

  if (name === "tokenrouter") {
    return createTokenRouterRunner({
      apiKey:
        process.env.TOKENROUTER_API_KEY?.trim() ||
        process.env.IMEMORY_TOKENROUTER_API_KEY?.trim() ||
        "",
      model:
        override ||
        safeConfiguredModel(
          process.env.IMEMORY_TOKENROUTER_MODEL || process.env.TOKENROUTER_MODEL,
        ),
      baseUrl:
        process.env.IMEMORY_TOKENROUTER_BASE_URL?.trim() ||
        process.env.TOKENROUTER_BASE_URL?.trim(),
    });
  }

  if (name === "cursor_cli") {
    return createCursorCliRunner({
      command: cursorCliBin(),
      apiKey: cursorApiKey() || undefined,
      model: override || safeConfiguredModel(process.env.IMEMORY_CURSOR_MODEL),
    });
  }

  if (name === "codex_cli") {
    return createCodexCliRunner({
      command: codexCliBin(),
      apiKey: codexApiKey() || undefined,
      model: override || safeConfiguredModel(process.env.IMEMORY_CODEX_MODEL),
      sandbox: process.env.IMEMORY_CODEX_SANDBOX?.trim(),
    });
  }

  if (name === "antigravity_cli") {
    return createAntigravityCliRunner({
      command: antigravityCliBin(),
      model: override || safeConfiguredModel(process.env.IMEMORY_ANTIGRAVITY_MODEL),
    });
  }

  if (name === "claude_cli") {
    return createClaudeCliRunner({
      command: claudeCliBin(),
      apiKey: claudeApiKey() || undefined,
      model: override || safeConfiguredModel(process.env.IMEMORY_CLAUDE_MODEL),
    });
  }

  if (name === "copilot_cli") {
    return createCopilotCliRunner({
      command: copilotCliBin(),
      apiKey: copilotApiKey() || undefined,
      model: override || safeConfiguredModel(process.env.IMEMORY_COPILOT_MODEL),
    });
  }

  return createCursorSdkRunner({
    apiKey: cursorApiKey(),
    model: override || safeConfiguredModel(process.env.IMEMORY_CURSOR_MODEL),
  });
}

/**
 * Startup / availability failures should fall through to the next runner.
 * Rate-limit / resource_exhausted also fall through so a healthy provider
 * can take over after cooldown is recorded.
 * Other mid-run task failures should not.
 */
export function isRetryableRunnerFailure(result: RunnerResult): boolean {
  if (result.status !== "failed") return false;
  const err = (result.error || "").toLowerCase();
  if (!err) return false;

  if (isRateLimitError(result.error)) return true;

  const patterns = [
    "required",
    "not found",
    "enoent",
    "failed to spawn",
    "exited with code 127",
    "startup failed",
    "cursor_api_key",
    "command not found",
    "no such file",
    "executable file not found",
    "is not recognized",
    "api error",
    "request failed",
    "failed to read response body",
    "empty llm response",
    "timeout",
    "bad gateway",
    "internal server error",
    "service unavailable",
    "gateway timeout",
    "fetch exception",
    "exceeded max steps",
    " 500",
    " 502",
    " 503",
    " 504",
  ];
  return patterns.some((p) => err.includes(p));
}

// Keep track of runtime state for runner auto-switching
export let runnerOverride: RunnerName | null = null;
export let cursorResourceExhaustionCount = 0;

export function resetRunnerOverride(): void {
  runnerOverride = null;
  cursorResourceExhaustionCount = 0;
  resetProviderPacing();
}

export function handleRunnerResult(
  runnerName: RunnerName,
  result: RunnerResult,
  logFn?: (msg: string) => void,
): void {
  if (result.status === "failed") {
    const isResourceExhausted = isRateLimitError(result.error);

    if (isResourceExhausted && runnerName !== "auto") {
      const { cooldownUntil, family } = recordRateLimit(runnerName as ProviderName, {
        retryAfterMs: parseRetryAfterMs(result.error),
      });
      const coolMsg = `Provider cooldown until ${new Date(cooldownUntil).toISOString()} for ${family.join(", ")}.`;
      if (logFn) logFn(coolMsg);
    }

    if (runnerName === "cursor_cli" || runnerName === "cursor_sdk") {
      if (isResourceExhausted) {
        cursorResourceExhaustionCount++;
        const countMsg = `Cursor runner encountered resource exhaustion (${cursorResourceExhaustionCount}/2).`;
        if (logFn) logFn(countMsg);
        if (cursorResourceExhaustionCount >= 2) {
          if (!isProviderDisabled("antigravity_cli") && !isInCooldown("antigravity_cli")) {
            runnerOverride = "antigravity_cli";
            const switchMsg = `Cursor runner encountered 2 consecutive resource exhaustion errors. Switching default runner override to antigravity_cli until it fails.`;
            if (logFn) logFn(switchMsg);
          }
        }
      }
    } else if (runnerName === "antigravity_cli" && runnerOverride === "antigravity_cli") {
      runnerOverride = null;
      cursorResourceExhaustionCount = 0;
      const resetMsg = `Antigravity CLI failed. Resetting runner override to default.`;
      if (logFn) logFn(resetMsg);
    }
  } else if (result.status === "succeeded") {
    if (runnerName === "cursor_cli" || runnerName === "cursor_sdk") {
      cursorResourceExhaustionCount = 0;
    }
  }
}

/**
 * Resolve which runners to attempt for a job.
 * - `auto` / `cursor_sdk` / unknown: key → cursor_sdk, then CLIs
 * - explicit CLI / API runner: that runner only
 *
 * Note: `cursor_sdk` uses the same cascade as `auto` so jobs queued with the
 * old default still fall through to CLI when CURSOR_API_KEY is missing.
 */
export async function resolveRunnerAttempts(
  requested: string,
  deps?: Parameters<typeof resolveAutoRunnerChain>[0],
  options?: { hardRule?: boolean },
): Promise<Array<Exclude<RunnerName, "auto">>> {
  const defaultRunner =
    process.env.IMEMORY_DEFAULT_RUNNER?.trim() || process.env.IMEMORY_DEFAULT_AI?.trim() || "auto";
  let runner = !requested || requested === "auto" ? defaultRunner : requested;

  const hardRule = options?.hardRule ?? false;

  // Apply runner override only for cascade modes. Explicit CLI pins must stay pinned
  // unless overridden by cascade logic.
  if (runnerOverride && (runner === "auto" || runner === "cursor_sdk")) {
    if (isProviderDisabled(runnerOverride) || isInCooldown(runnerOverride)) {
      runnerOverride = null;
    } else {
      runner = runnerOverride;
    }
  }

  const explicitRunners: string[] = [
    "cursor_cli",
    "codex_cli",
    "antigravity_cli",
    "claude_cli",
    "copilot_cli",
    "kiro_cli",
    "kimi_cli",
    "openrouter",
    "tokenrouter",
  ];

  if (explicitRunners.includes(runner)) {
    const specificRunner = runner as Exclude<RunnerName, "auto">;
    if (hardRule || !requested || requested === "auto" || runnerOverride) {
      return [specificRunner];
    }
    const chain = await resolveAutoRunnerChain(deps);
    const fallbackChain = chain.filter((r) => r !== specificRunner);
    return [specificRunner, ...fallbackChain];
  }

  // auto / cursor_sdk / unknown / empty → cascade
  const chain = await resolveAutoRunnerChain(deps);
  if (chain.length === 0) {
    // Last resort so the job surfaces a clear error from SDK
    return ["cursor_sdk"];
  }
  return chain;
}
