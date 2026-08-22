import { runCliProcess, tryParseJsonLine } from "./cli-process.js";
import type { Runner, RunnerResult, RunnerUsageStats } from "./types.js";
import { appendCliMcpArgs } from "../projectmind-mcp.js";

/**
 * Claude Code's `stream-json` terminal event carries usage/cost/timing, e.g.:
 * { type: "result", duration_ms, total_cost_usd, usage: { input_tokens, output_tokens, ... } }
 */
export function extractUsageStats(obj: Record<string, unknown>): RunnerUsageStats | null {
  if (obj.type !== "result") return null;

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const usage = (obj.usage ?? null) as Record<string, unknown> | null;
  const inputTokens = usage ? num(usage.input_tokens) : undefined;
  const outputTokens = usage ? num(usage.output_tokens) : undefined;
  const cacheReadTokens = usage ? num(usage.cache_read_input_tokens) : undefined;
  const cacheCreationTokens = usage ? num(usage.cache_creation_input_tokens) : undefined;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheCreationTokens ?? 0)
      : undefined;

  const stats: RunnerUsageStats = {
    durationMs: num(obj.duration_ms),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costUsd: num(obj.total_cost_usd),
  };

  const hasAnyValue = Object.values(stats).some((v) => v !== undefined);
  return hasAnyValue ? stats : null;
}

function summarizeClaudeEvent(obj: Record<string, unknown>): string | null {
  const type = typeof obj.type === "string" ? obj.type : "event";

  if (type === "assistant" || type === "message" || type === "text") {
    const message = obj.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const texts =
      message?.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text!) ?? [];
    if (texts.length) return texts.join("\n");
    if (typeof obj.text === "string" && obj.text) return obj.text;
    if (typeof obj.result === "string" && obj.result) return obj.result;
    if (typeof obj.content === "string" && obj.content) return obj.content;
  }

  if (type === "result") {
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.text === "string") return obj.text;
  }

  if (type === "error" || type === "system") {
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
    const msg =
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.message === "string" && obj.message) ||
      JSON.stringify(obj).slice(0, 2_000);
    return subtype ? `[${type}/${subtype}] ${msg}` : `[${type}] ${msg}`;
  }

  if (type === "tool_use" || type === "tool_call" || type === "user") {
    try {
      return `[${type}] ${JSON.stringify(obj).slice(0, 3_000)}`;
    } catch {
      return `[${type}]`;
    }
  }

  try {
    return `[${type}] ${JSON.stringify(obj).slice(0, 3_000)}`;
  } catch {
    return `[${type}]`;
  }
}

function extractClaudeSummary(stdout: string, lastMessage: string): string {
  if (lastMessage.trim()) return lastMessage.trim().slice(0, 8_000);

  const lines = stdout.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParseJsonLine(lines[i]!);
    if (!obj) continue;
    if (typeof obj.result === "string" && obj.result.trim()) {
      return obj.result.trim().slice(0, 8_000);
    }
    if (obj.type === "result" && typeof obj.text === "string" && obj.text.trim()) {
      return obj.text.trim().slice(0, 8_000);
    }
  }

  const plain = lines
    .filter((l) => !tryParseJsonLine(l))
    .join("\n")
    .trim();
  return plain.slice(0, 8_000);
}

/**
 * Anthropic Claude Code CLI (`claude`) non-interactive runner.
 * Uses print mode + optional skip-permissions for headless Mac-agent jobs.
 */
export function createClaudeCliRunner(options: {
  /** Binary name or path. Default: claude */
  command?: string;
  apiKey?: string;
  model?: string;
  /**
   * Skip permission prompts (required for unattended runs).
   * Default true; set IMEMORY_CLAUDE_SKIP_PERMISSIONS=0 to disable.
   */
  skipPermissions?: boolean;
  /** Extra args after fixed flags, before -p prompt. */
  extraArgs?: string[];
}): Runner {
  const command =
    options.command?.trim() ||
    process.env.IMEMORY_CLAUDE_CLI_BIN?.trim() ||
    process.env.CLAUDE_CLI_BIN?.trim() ||
    "claude";
  const configuredModel =
    options.model?.trim() || process.env.IMEMORY_CLAUDE_MODEL?.trim() || undefined;
  // Older agent settings and jobs used "default" as the Auto sentinel. Claude
  // treats it as a literal model ID, so omit --model and let the CLI choose.
  const model = configuredModel?.toLowerCase() === "default" ? undefined : configuredModel;
  const skipPermissions =
    options.skipPermissions ?? process.env.IMEMORY_CLAUDE_SKIP_PERMISSIONS?.trim() !== "0";
  const permissionMode = process.env.IMEMORY_CLAUDE_PERMISSION_MODE?.trim() || undefined;

  return {
    name: "claude_cli",
    async run({ cwd, prompt, onLog, signal, mcp }): Promise<RunnerResult> {
      const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];

      if (model) {
        args.push("--model", model);
      }
      if (permissionMode) {
        args.push("--permission-mode", permissionMode);
      } else if (skipPermissions) {
        args.push("--dangerously-skip-permissions");
      }
      if (options.extraArgs?.length) {
        args.push(...options.extraArgs);
      }
      const spawnArgs = appendCliMcpArgs(args, mcp);
      spawnArgs.push(prompt);

      await onLog(
        `Starting Claude CLI (${command}) in ${cwd}` +
          (model ? ` model=${model}` : "") +
          (permissionMode
            ? ` permission-mode=${permissionMode}`
            : skipPermissions
              ? " skip-permissions"
              : ""),
        "status",
      );

      const env: NodeJS.ProcessEnv = {};
      if (options.apiKey?.trim()) {
        env.ANTHROPIC_API_KEY = options.apiKey.trim();
      }

      let lastMessage = "";
      let sessionId: string | undefined;
      let failed = false;
      let failMessage = "";
      let usageStats: RunnerUsageStats | null = null;

      const result = await runCliProcess({
        command,
        args: spawnArgs,
        cwd,
        env: Object.keys(env).length ? env : undefined,
        signal,
        onLog,
        onStdoutLine: async (line) => {
          const obj = tryParseJsonLine(line);
          if (!obj) return false;

          if (typeof obj.session_id === "string") {
            sessionId = obj.session_id;
          }
          if (obj.type === "result") {
            usageStats = extractUsageStats(obj) ?? usageStats;
          }
          if (obj.type === "result" && obj.is_error === true) {
            failed = true;
            failMessage =
              (typeof obj.result === "string" && obj.result) ||
              (typeof obj.error === "string" && obj.error) ||
              failMessage;
          }
          if (obj.type === "error") {
            failed = true;
            failMessage =
              (typeof obj.error === "string" && obj.error) ||
              (typeof obj.message === "string" && obj.message) ||
              failMessage;
          }

          const summary = summarizeClaudeEvent(obj);
          if (summary) {
            if (
              obj.type === "assistant" ||
              obj.type === "message" ||
              obj.type === "text" ||
              obj.type === "result"
            ) {
              lastMessage = summary;
            }
            await onLog(summary.slice(0, 7_000), "log");
          }
          return true;
        },
      });

      const resolvedModel = model || "default";

      if (result.cancelled || signal.aborted) {
        return {
          status: "cancelled",
          summary: lastMessage || "Cancelled",
          externalRunId: sessionId,
          model: resolvedModel,
          stats: usageStats ?? undefined,
        };
      }

      if (failed || result.code !== 0) {
        const errTail = (result.stderr || failMessage || result.stdout).trim().slice(-4_000);
        return {
          status: "failed",
          summary: lastMessage,
          error:
            failMessage ||
            `Claude CLI exited with code ${result.code ?? "?"}` + (errTail ? `: ${errTail}` : ""),
          externalRunId: sessionId,
          model: resolvedModel,
          stats: usageStats ?? undefined,
        };
      }

      return {
        status: "succeeded",
        summary: extractClaudeSummary(result.stdout, lastMessage) || "Claude CLI finished",
        externalRunId: sessionId,
        model: resolvedModel,
        stats: usageStats ?? undefined,
      };
    },
  };
}
