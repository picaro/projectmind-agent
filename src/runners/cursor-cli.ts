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
  const model = options.model?.trim() || process.env.IMEMORY_CURSOR_MODEL?.trim();

  return {
    name: "cursor_cli",
    async run({ cwd, prompt, onLog, signal }): Promise<RunnerResult> {
      const args = [
        "-p",
        "--force",
        "--trust",
        "--workspace",
        cwd,
        "--output-format",
        "stream-json",
      ];

      if (model) {
        args.push("--model", model);
      }
      // Prefer CURSOR_API_KEY in env — never put the key on argv (spawn logs / ps).
      if (options.extraArgs?.length) {
        args.push(...options.extraArgs);
      }
      args.push(prompt);

      await onLog(
        `Starting Cursor CLI (${command}) in ${cwd}` + (model ? ` model=${model}` : ""),
        "status",
      );

      let lastAssistant = "";
      const result = await runCliProcess({
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

      const resolvedModel = model || "default";

      if (result.cancelled || signal.aborted) {
        return {
          status: "cancelled",
          summary: lastAssistant || "Cancelled",
          model: resolvedModel,
        };
      }

      if (result.code !== 0) {
        const errTail = (result.stderr || result.stdout).trim().slice(-4_000);
        return {
          status: "failed",
          summary: lastAssistant,
          error:
            `Cursor CLI exited with code ${result.code ?? "?"}` + (errTail ? `: ${errTail}` : ""),
          model: resolvedModel,
        };
      }

      return {
        status: "succeeded",
        summary: extractFinalSummary(result.stdout, lastAssistant) || "Cursor CLI finished",
        model: resolvedModel,
      };
    },
  };
}
