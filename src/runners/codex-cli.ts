import { runCliProcess, tryParseJsonLine } from "./cli-process.js";
import type { Runner, RunnerResult, RunnerUsageStats } from "./types.js";

/**
 * Codex CLI's `--json` stream reports token usage per turn, e.g.:
 * { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens } }
 * A run can contain multiple turns, so callers accumulate this across events.
 */
export function extractCodexUsageDelta(obj: Record<string, unknown>): RunnerUsageStats | null {
  if (obj.type !== "turn.completed") return null;

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const usage = (obj.usage ?? null) as Record<string, unknown> | null;
  if (!usage) return null;

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cached_input_tokens);
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;

  const stats: RunnerUsageStats = { inputTokens, outputTokens, cacheReadTokens, totalTokens };
  const hasAnyValue = Object.values(stats).some((v) => v !== undefined);
  return hasAnyValue ? stats : null;
}

function accumulateUsage(
  totals: RunnerUsageStats | null,
  delta: RunnerUsageStats,
): RunnerUsageStats {
  const add = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(totals?.inputTokens, delta.inputTokens),
    outputTokens: add(totals?.outputTokens, delta.outputTokens),
    cacheReadTokens: add(totals?.cacheReadTokens, delta.cacheReadTokens),
    totalTokens: add(totals?.totalTokens, delta.totalTokens),
  };
}

function summarizeCodexEvent(obj: Record<string, unknown>): string | null {
  const type = typeof obj.type === "string" ? obj.type : "event";

  if (type === "thread.started") {
    const id = typeof obj.thread_id === "string" ? obj.thread_id : "";
    return id ? `[thread] ${id}` : "[thread.started]";
  }

  if (type === "turn.started") return "[turn] started";
  if (type === "turn.completed") return "[turn] completed";
  if (type === "turn.failed") {
    const err = (typeof obj.error === "string" && obj.error) || JSON.stringify(obj).slice(0, 2_000);
    return `[turn] failed: ${err}`;
  }

  if (type === "error") {
    const msg =
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.error === "string" && obj.error) ||
      JSON.stringify(obj).slice(0, 2_000);
    return `[error] ${msg}`;
  }

  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item) return `[${type}]`;
    const itemType = typeof item.type === "string" ? item.type : "item";

    if (itemType === "agent_message" && typeof item.text === "string") {
      return item.text;
    }
    if (itemType === "reasoning" && typeof item.text === "string") {
      return `[reasoning] ${item.text.slice(0, 2_000)}`;
    }
    if (itemType === "command_execution") {
      const cmd = typeof item.command === "string" ? item.command : "?";
      const status = typeof item.status === "string" ? item.status : "";
      return `[command] ${cmd}${status ? ` (${status})` : ""}`;
    }
    if (itemType === "file_change" || itemType === "file_changes") {
      return `[file_change] ${JSON.stringify(item).slice(0, 2_000)}`;
    }
    if (itemType === "mcp_tool_call") {
      const name = typeof item.name === "string" ? item.name : "mcp";
      return `[mcp] ${name}`;
    }
    return `[${itemType}] ${JSON.stringify(item).slice(0, 2_000)}`;
  }

  try {
    return `[${type}] ${JSON.stringify(obj).slice(0, 3_000)}`;
  } catch {
    return `[${type}]`;
  }
}

function extractCodexSummary(stdout: string, lastMessage: string): string {
  if (lastMessage.trim()) return lastMessage.trim().slice(0, 8_000);

  const lines = stdout.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParseJsonLine(lines[i]!);
    if (!obj) continue;
    const item = obj.item as Record<string, unknown> | undefined;
    if (
      item &&
      item.type === "agent_message" &&
      typeof item.text === "string" &&
      item.text.trim()
    ) {
      return item.text.trim().slice(0, 8_000);
    }
  }

  // Non-JSON mode: stdout is the final message
  const plain = lines
    .filter((l) => !tryParseJsonLine(l))
    .join("\n")
    .trim();
  return plain.slice(0, 8_000);
}

export function createCodexCliRunner(options: {
  /** Binary name or path. Default: codex */
  command?: string;
  apiKey?: string;
  model?: string;
  /** Sandbox mode for automation. Default: workspace-write */
  sandbox?: string;
  extraArgs?: string[];
}): Runner {
  const command =
    options.command?.trim() ||
    process.env.IMEMORY_CODEX_CLI_BIN?.trim() ||
    process.env.CODEX_CLI_BIN?.trim() ||
    "codex";
  const configuredModel =
    options.model?.trim() || process.env.IMEMORY_CODEX_MODEL?.trim() || undefined;
  // Older agent settings and jobs used "default" as the Auto sentinel. Codex
  // treats it as a literal model ID, so omit -m and let the CLI choose.
  const model = configuredModel?.toLowerCase() === "default" ? undefined : configuredModel;
  const sandbox =
    options.sandbox?.trim() || process.env.IMEMORY_CODEX_SANDBOX?.trim() || "workspace-write";

  return {
    name: "codex_cli",
    async run({ cwd, prompt, onLog, signal }): Promise<RunnerResult> {
      const args = [
        "exec",
        "--json",
        "--sandbox",
        sandbox,
        "--ephemeral",
        "--skip-git-repo-check",
      ];

      if (model) {
        args.push("-m", model);
      }
      if (options.extraArgs?.length) {
        args.push(...options.extraArgs);
      }
      // Prompt last so flags stay unambiguous
      args.push(prompt);

      await onLog(
        `Starting Codex CLI (${command}) in ${cwd} sandbox=${sandbox}` +
          (model ? ` model=${model}` : ""),
        "status",
      );

      // Auth mode is billing-relevant: with a key present Codex uses metered API
      // billing, without one it uses the `codex login` subscription. runCliProcess
      // spawns with { ...process.env, ...env }, so leaving these unset would let a
      // key exported in the agent's own shell silently pick metered billing. Pin
      // both directions explicitly (spawn drops undefined entries).
      const env: NodeJS.ProcessEnv = {};
      const apiKey = options.apiKey?.trim();
      if (apiKey) {
        env.CODEX_API_KEY = apiKey;
        // Some installs still read OPENAI_API_KEY
        env.OPENAI_API_KEY = apiKey;
      } else {
        env.CODEX_API_KEY = undefined;
        env.OPENAI_API_KEY = undefined;
      }

      let lastMessage = "";
      let threadId: string | undefined;
      let failed = false;
      let failMessage = "";
      let usageStats: RunnerUsageStats | null = null;

      const result = await runCliProcess({
        command,
        args,
        cwd,
        env,
        signal,
        onLog,
        onStdoutLine: async (line) => {
          const obj = tryParseJsonLine(line);
          if (!obj) return false;

          if (typeof obj.thread_id === "string") {
            threadId = obj.thread_id;
          }
          if (obj.type === "turn.failed" || obj.type === "error") {
            failed = true;
            failMessage =
              (typeof obj.message === "string" && obj.message) ||
              (typeof obj.error === "string" && obj.error) ||
              failMessage;
          }
          const usageDelta = extractCodexUsageDelta(obj);
          if (usageDelta) {
            usageStats = accumulateUsage(usageStats, usageDelta);
          }

          const summary = summarizeCodexEvent(obj);
          if (summary) {
            const item = obj.item as Record<string, unknown> | undefined;
            if (item?.type === "agent_message" && typeof item.text === "string") {
              lastMessage = item.text;
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
          externalRunId: threadId,
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
            `Codex CLI exited with code ${result.code ?? "?"}` + (errTail ? `: ${errTail}` : ""),
          externalRunId: threadId,
          model: resolvedModel,
          stats: usageStats ?? undefined,
        };
      }

      return {
        status: "succeeded",
        summary: extractCodexSummary(result.stdout, lastMessage) || "Codex CLI finished",
        externalRunId: threadId,
        model: resolvedModel,
        stats: usageStats ?? undefined,
      };
    },
  };
}
