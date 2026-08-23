import fs from "node:fs";
import path from "node:path";
import { runCliProcess, tryParseJsonLine } from "./cli-process.js";
import type { Runner, RunnerResult } from "./types.js";

function summarizeCursorCliEvent(obj: Record<string, unknown>): string | null {
  const type = typeof obj.type === "string" ? obj.type : "event";

  if (type === "assistant" || type === "message" || type === "text") {
    const message = obj.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const texts =
      message?.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text!) ?? [];
    if (texts.length) return texts.join("\n");
    if (typeof obj.text === "string" && obj.text) return obj.text;
    if (typeof obj.content === "string" && obj.content) return obj.content;
  }

  if (type === "tool_call" || type === "tool-call" || type === "tool_call_started") {
    const name =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.toolName === "string" && obj.toolName) ||
      "tool";
    const args = obj.arguments ?? obj.args ?? obj.input;
    const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {}).slice(0, 2_000);
    return `[tool_call] ${name}(${argsStr})`;
  }

  if (type === "tool_result" || type === "tool-result" || type === "tool_call_completed") {
    const name =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.toolName === "string" && obj.toolName) ||
      "tool";
    const result = obj.result ?? obj.content ?? obj.output;
    const resultStr =
      typeof result === "string" ? result : JSON.stringify(result ?? {}).slice(0, 4_000);
    return `[tool_result] ${name}: ${resultStr}`;
  }

  if (type === "result" || type === "done" || type === "completed") {
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.text === "string") return obj.text;
  }

  if (type === "error") {
    const msg =
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.message === "string" && obj.message) ||
      JSON.stringify(obj).slice(0, 2_000);
    return `[error] ${msg}`;
  }

  if (type === "system" || type === "status" || type === "thinking") {
    const text =
      (typeof obj.text === "string" && obj.text) ||
      (typeof obj.message === "string" && obj.message) ||
      JSON.stringify(obj).slice(0, 2_000);
    return `[${type}] ${text}`;
  }

  try {
    return `[${type}] ${JSON.stringify(obj).slice(0, 3_000)}`;
  } catch {
    return `[${type}]`;
  }
}

function extractFinalSummary(stdout: string, lastAssistant: string): string {
  if (lastAssistant.trim()) return lastAssistant.trim().slice(0, 8_000);

  // Prefer last JSON result event
  const lines = stdout.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParseJsonLine(lines[i]!);
    if (!obj) continue;
    if (typeof obj.result === "string" && obj.result.trim()) {
      return obj.result.trim().slice(0, 8_000);
    }
    if (obj.type === "result" && typeof obj.text === "string") {
      return obj.text.trim().slice(0, 8_000);
    }
  }

  // Fall back to trailing non-JSON text
  const plain = lines
    .filter((l) => !tryParseJsonLine(l))
    .join("\n")
    .trim();
  return plain.slice(0, 8_000);
}

/**
 * Control-plane recovery and Anthropic API ids that Cursor CLI no longer
 * accepts. Mapped to the closest current Cursor CLI catalog id so a retry
 * does not fail with a 400-line "Available models:" dump.
 */
const CURSOR_CLI_MODEL_ALIASES: Record<string, string> = {
  "claude-3-5-sonnet": "claude-4.5-sonnet",
  "claude-3.5-sonnet": "claude-4.5-sonnet",
  "claude-3-5-sonnet-latest": "claude-4.5-sonnet",
  "claude-3.5-sonnet-latest": "claude-4.5-sonnet",
  "claude-3-5-haiku": "claude-4.5-sonnet",
  "claude-3.5-haiku": "claude-4.5-sonnet",
  "claude-sonnet-4": "claude-4-sonnet",
  "claude-sonnet-4.5": "claude-4.5-sonnet",
  "claude-4-opus": "claude-4.5-opus-high",
  "claude-4.5-opus": "claude-4.5-opus-high",
};

const MODEL_FAMILY_TOKENS = new Set([
  "opus",
  "sonnet",
  "haiku",
  "gpt",
  "gemini",
  "grok",
  "composer",
  "codex",
  "kimi",
  "glm",
]);

function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, "-").replace(/\./g, "-");
}

/**
 * Resolve the `--model` flag for Cursor CLI.
 * `default` is a ProjectMind sentinel, not a Cursor catalog id — omit the flag.
 */
export function resolveCursorCliModelFlag(model?: string | null): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const key = trimmed.toLowerCase();
  if (key === "default") return undefined;
  return CURSOR_CLI_MODEL_ALIASES[key] ?? trimmed;
}

export function parseCursorCliModelRejection(
  text: string,
): { rejected: string; available: string[] } | null {
  const match = text.match(/Cannot use this model:\s*([^\s.]+)\.\s*Available models:\s*(.*)/is);
  if (!match) return null;
  const rejected = match[1]!.trim();
  const available = match[2]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!rejected || available.length === 0) return null;
  return { rejected, available };
}

export function pickClosestCursorCliModel(
  requested: string,
  available: string[],
): string | undefined {
  const reqNorm = normalizeModelId(requested);
  const reqTokens = reqNorm.split("-").filter((t) => t && t !== "latest");
  const family = reqTokens.find((t) => MODEL_FAMILY_TOKENS.has(t));
  const familyWanted = family === "haiku" ? "sonnet" : family;

  let best: { id: string; score: number } | undefined;
  for (const id of available) {
    if (!id || id === "auto") continue;
    const tokens = normalizeModelId(id).split("-").filter(Boolean);
    const tokenSet = new Set(tokens);
    let score = 0;
    if (familyWanted && tokenSet.has(familyWanted)) score += 20;
    for (const t of reqTokens) {
      if (tokenSet.has(t)) score += 2;
    }
    if (/thinking/i.test(id)) score -= 4;
    if (/-fast$/i.test(id)) score -= 2;
    if (/-max$/i.test(id) || /xhigh/i.test(id)) score -= 1;
    if (familyWanted && new RegExp(`${familyWanted}$`, "i").test(id)) score += 3;
    if (!best || score > best.score) best = { id, score };
  }
  if (best && best.score >= 20) return best.id;
  if (available.includes("auto")) return "auto";
  return best?.id;
}

export function formatCursorCliExitError(code: number | null, output: string): string {
  const text = output.trim();
  const rejection = parseCursorCliModelRejection(text);
  if (rejection) {
    return (
      `Cursor CLI exited with code ${code ?? "?"}: cannot use model ${rejection.rejected} ` +
      "(not in the current Cursor CLI catalog)"
    );
  }
  const head = text.slice(0, 800);
  return `Cursor CLI exited with code ${code ?? "?"}` + (head ? `: ${head}` : "");
}


/**
 * Cursor CLI discovers MCP servers from `<workspace>/.cursor/mcp.json` or `~/.cursor/mcp.json`.
 * It does not support `--mcp-config <path>` on argv.
 * If `--mcp-config` is provided in extraArgs, strip it from argv and ensure the config
 * is mirrored to `<cwd>/.cursor/mcp.json` if possible.
 */
export function sanitizeCursorCliExtraArgs(
  extraArgs: string[] | undefined,
  cwd: string,
): string[] {
  if (!extraArgs || extraArgs.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    if (arg === "--mcp-config") {
      const next = extraArgs[i + 1];
      if (next && !next.startsWith("-")) {
        tryMirrorMcpConfigFile(next, cwd);
        i++;
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      const filePath = arg.slice("--mcp-config=".length).trim();
      if (filePath) {
        tryMirrorMcpConfigFile(filePath, cwd);
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

function tryMirrorMcpConfigFile(sourcePath: string, cwd: string): void {
  try {
    if (fs.existsSync(sourcePath)) {
      const dotCursor = path.join(cwd, ".cursor");
      const targetFile = path.join(dotCursor, "mcp.json");
      if (!fs.existsSync(targetFile)) {
        fs.mkdirSync(dotCursor, { recursive: true });
        fs.copyFileSync(sourcePath, targetFile);
      }
    }
  } catch {
    // Best effort: never fail CLI invocation if copying MCP config throws
  }
}

export function createCursorCliRunner(options: {
  /** Binary name or path. Default: agent (Cursor Agent CLI). */
  command?: string;
  apiKey?: string;
  model?: string;
  /** Extra args after fixed flags, before the prompt. */
  extraArgs?: string[];
}): Runner {
  const command =
    options.command?.trim() ||
    process.env.IMEMORY_CURSOR_CLI_BIN?.trim() ||
    process.env.CURSOR_CLI_BIN?.trim() ||
    "agent";
  const configuredModel = options.model?.trim() || process.env.IMEMORY_CURSOR_MODEL?.trim();

  return {
    name: "cursor_cli",
    async run({ cwd, prompt, onLog, signal }): Promise<RunnerResult> {
      let model = resolveCursorCliModelFlag(configuredModel);
      if (model && model !== configuredModel) {
        await onLog(
          `Mapped Cursor CLI model ${configuredModel} → ${model}`,
          "status",
        );
      }

      let lastAssistant = "";

      const spawnOnce = async () => {
        const args = [
          "-p",
          "--force",
          "--trust",
          "--approve-mcps",
          "--workspace",
          cwd,
          "--output-format",
          "stream-json",
        ];
        if (model) {
          args.push("--model", model);
        }
        // Prefer CURSOR_API_KEY in env — never put the key on argv (spawn logs / ps).
        const sanitizedExtraArgs = sanitizeCursorCliExtraArgs(options.extraArgs, cwd);
        if (sanitizedExtraArgs.length) {
          args.push(...sanitizedExtraArgs);
        }
        args.push(prompt);

        await onLog(
          `Starting Cursor CLI (${command}) in ${cwd}` + (model ? ` model=${model}` : ""),
          "status",
        );

        return runCliProcess({
          command,
          args,
          cwd,
          env: options.apiKey?.trim() ? { CURSOR_API_KEY: options.apiKey.trim() } : undefined,
          signal,
          onLog,
          onStdoutLine: async (line) => {
            const obj = tryParseJsonLine(line);
            if (!obj) return false;
            const summary = summarizeCursorCliEvent(obj);
            if (summary) {
              if (
                obj.type === "assistant" ||
                obj.type === "message" ||
                obj.type === "text" ||
                obj.type === "result"
              ) {
                lastAssistant = summary;
              }
              await onLog(summary.slice(0, 7_000), "log");
            }
            return true;
          },
        });
      };

      let result = await spawnOnce();
      const resolvedModel = () => model || "default";

      if (result.cancelled || signal.aborted) {
        return {
          status: "cancelled",
          summary: lastAssistant || "Cancelled",
          model: resolvedModel(),
        };
      }

      if (result.code !== 0) {
        const rejection = parseCursorCliModelRejection(result.stderr || result.stdout);
        const fallback = rejection
          ? pickClosestCursorCliModel(rejection.rejected, rejection.available)
          : undefined;
        if (fallback && fallback !== model) {
          await onLog(
            `Cursor CLI rejected model ${model ?? configuredModel ?? "default"}; retrying with ${fallback}`,
            "status",
          );
          model = fallback;
          lastAssistant = "";
          result = await spawnOnce();
        }
      }

      if (result.cancelled || signal.aborted) {
        return {
          status: "cancelled",
          summary: lastAssistant || "Cancelled",
          model: resolvedModel(),
        };
      }

      if (result.code !== 0) {
        return {
          status: "failed",
          summary: lastAssistant,
          error: formatCursorCliExitError(result.code, result.stderr || result.stdout),
          model: resolvedModel(),
        };
      }

      return {
        status: "succeeded",
        summary: extractFinalSummary(result.stdout, lastAssistant) || "Cursor CLI finished",
        model: resolvedModel(),
      };
    },
  };
}
