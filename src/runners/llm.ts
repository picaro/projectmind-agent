import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveUnderCwd } from "../safety.js";
import { assertSafeShellCommand } from "./llm-shell.js";
import type { Runner, RunnerResult } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_STEPS = 110;
const SHELL_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 100_000;

export function resolveMaxSteps(configuredMaxSteps?: number): number {
  if (configuredMaxSteps && configuredMaxSteps > 0) {
    return configuredMaxSteps;
  }
  const envVal =
    process.env.MAX_AGENT_STEPS ||
    process.env.LLM_MAX_STEPS ||
    process.env.IMEMORY_LLM_MAX_STEPS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_STEPS;
}

type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

export async function runTool(cwd: string, name: string, argsJson: string): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return "Invalid JSON arguments";
  }

  if (name === "list_dir") {
    const rel = String(args.path ?? ".");
    const target = resolveUnderCwd(cwd, rel);
    if (!target) return "Path escapes workspace";
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .slice(0, 200)
      .map((e) => `${e.isDirectory() ? "dir" : "file"}\t${e.name}`)
      .join("\n");
  }

  if (name === "read_file") {
    const rel = String(args.path ?? "");
    const target = resolveUnderCwd(cwd, rel);
    if (!target) return "Path escapes workspace";
    const buf = await fs.readFile(target);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return buf.subarray(0, MAX_FILE_BYTES).toString("utf8") + "\n…[truncated]";
    }
    return buf.toString("utf8");
  }

  if (name === "write_file") {
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    const target = resolveUnderCwd(cwd, rel);
    if (!target) return "Path escapes workspace";
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return `Wrote ${content.length} bytes to ${rel}`;
  }

  if (name === "run_shell") {
    const command = String(args.command ?? "").trim();
    if (!command) return "Empty command";
    const blocked = assertSafeShellCommand(command);
    if (blocked) return blocked;
    try {
      const isWin = process.platform === "win32";
      const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/zsh";
      const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-lc", command];
      const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
        cwd,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 512_000,
        // Avoid inheriting cloud credentials the agent should not use via shell.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME || process.env.USERPROFILE,
          USER: process.env.USER || process.env.USERNAME,
          LANG: process.env.LANG,
          TMPDIR: process.env.TMPDIR || process.env.TEMP,
          TERM: process.env.TERM,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
        },
      });
      return [`stdout:`, stdout, `stderr:`, stderr].join("\n").slice(0, 12_000);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `Shell failed: ${e.message ?? err}\n${e.stdout ?? ""}\n${e.stderr ?? ""}`.slice(
        0,
        12_000,
      );
    }
  }

  return `Unknown tool: ${name}`;
}

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files in a directory relative to the workspace cwd",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 file relative to the workspace cwd",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 file relative to the workspace cwd",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a local shell command with cwd set to the workspace. Prefer tests and local tooling. Pipes, network tools (curl/ssh/etc), sudo, recursive rm, and interpreter one-liners are blocked.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

export function maskApiKey(key?: string | null): string {
  if (!key || !key.trim()) return "(none)";
  const trimmed = key.trim();
  const len = trimmed.length;
  if (len <= 8) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)} (len ${len})`;
  }
  if (trimmed.startsWith("sk-or-v1-")) {
    return `sk-or-v1-...${trimmed.slice(-4)} (len ${len})`;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)} (len ${len})`;
}

export function createOpenRouterRunner(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  httpReferer?: string;
  appTitle?: string;
  maxSteps?: number;
}): Runner {
  const headers: Record<string, string> = {
    "HTTP-Referer": options.httpReferer?.trim() || "https://projectm.dev/",
    "X-Title": options.appTitle?.trim() || "ProjectMind Agent",
    "X-OpenRouter-Title": options.appTitle?.trim() || "ProjectMind Agent",
  };
  return createOpenAiCompatibleRunner({
    ...options,
    name: "openrouter",
    label: "OpenRouter",
    defaultModel: "openai/gpt-4o-mini",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    missingKeyError: "OPENROUTER_API_KEY is required for openrouter runner",
    headers,
  });
}

export function createTokenRouterRunner(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxSteps?: number;
}): Runner {
  return createOpenAiCompatibleRunner({
    ...options,
    name: "tokenrouter",
    label: "TokenRouter",
    defaultModel: "openai/gpt-4o-mini",
    defaultBaseUrl: "https://api.tokenrouter.com/v1",
    missingKeyError: "TOKENROUTER_API_KEY is required for tokenrouter runner",
  });
}

function createOpenAiCompatibleRunner(options: {
  name: "openrouter" | "tokenrouter";
  label: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxSteps?: number;
  defaultModel: string;
  defaultBaseUrl: string;
  missingKeyError: string;
  headers?: Record<string, string>;
}): Runner {
  const model = options.model?.trim() || options.defaultModel;
  const baseUrl = (options.baseUrl?.trim() || options.defaultBaseUrl).replace(/\/+$/, "");
  const maxSteps = resolveMaxSteps(options.maxSteps);

  return {
    name: options.name,
    async run({ cwd, prompt, onLog, signal }): Promise<RunnerResult> {
      await onLog(
        `Starting ${options.label} runner (model=${model} base=${baseUrl}) in ${cwd}`,
        "status",
      );
      await onLog(`Prompt chars=${prompt.length}`, "log");

      if (!options.apiKey) {
        await onLog(
          `[ERROR] Missing API key for ${options.label} (${options.missingKeyError})`,
          "error",
        );
        return {
          status: "failed",
          summary: "",
          error: options.missingKeyError,
          model,
        };
      }

      const messages: Array<Record<string, unknown>> = [
        {
          role: "system",
          content: [
            "You are a coding agent working only inside the provided workspace.",
            "Use tools to inspect and edit files. Prefer small focused changes.",
            "When finished, reply with a short summary of what you changed (no more tool calls).",
          ].join(" "),
        },
        { role: "user", content: prompt },
      ];

      let lastAssistant = "";

      for (let step = 0; step < maxSteps; step += 1) {
        if (signal.aborted) {
          await onLog(`Aborted at step ${step + 1}`, "status");
          return { status: "cancelled", summary: "Cancelled", model };
        }

        await onLog(`LLM step ${step + 1}/${maxSteps} — requesting completion`, "status");
        const stepStarted = Date.now();

        const redactedKey = maskApiKey(options.apiKey);
        const payloadObj = {
          model,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
        };
        const payloadJson = JSON.stringify(payloadObj);
        const payloadBytes = Buffer.byteLength(payloadJson, "utf8");

        const maskedHeaders: Record<string, string> = {
          Authorization: `Bearer ${redactedKey}`,
          "Content-Type": "application/json",
          ...options.headers,
        };

        const payloadPreview =
          payloadJson.length > 1000
            ? `${payloadJson.slice(0, 1000)}... [truncated ${payloadJson.length} chars]`
            : payloadJson;

        await onLog(
          `[${options.label}] Triggering HTTP POST request (step ${step + 1}/${maxSteps})\n` +
          `  URL: ${baseUrl}/chat/completions\n` +
          `  Runner: ${options.label} (name: ${options.name})\n` +
          `  Model: ${model}\n` +
          `  API Key: ${redactedKey}\n` +
          `  Headers: ${JSON.stringify(maskedHeaders)}\n` +
          `  Messages Count: ${messages.length}\n` +
          `  Tools Count: ${TOOLS.length} (${TOOLS.map((t) => t.function.name).join(", ")})\n` +
          `  Payload Size: ${payloadBytes} bytes\n` +
          `  Payload Preview: ${payloadPreview}`,
          "log",
        );

        let response: Response;
        try {
          const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
              ...options.headers,
            },
            body: payloadJson,
            signal: fetchSignal,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await onLog(
            `[${options.label}] HTTP fetch exception for URL ${baseUrl}/chat/completions (API Key: ${redactedKey}): ${msg}`,
            "error",
          );
          return {
            status: "failed",
            summary: lastAssistant,
            error: `${options.label} request failed: ${msg}`,
            model,
          };
        }

        const duration = Date.now() - stepStarted;
        const interestingHeaders: Record<string, string> = {};
        for (const [key, val] of response.headers.entries()) {
          const lowerKey = key.toLowerCase();
          if (
            lowerKey.startsWith("x-") ||
            lowerKey.startsWith("cf-") ||
            lowerKey === "content-type" ||
            lowerKey === "retry-after" ||
            lowerKey.includes("ratelimit") ||
            lowerKey.includes("openrouter")
          ) {
            interestingHeaders[key] = val;
          }
        }

        await onLog(
          `[${options.label}] Response received from ${baseUrl}/chat/completions in ${duration}ms\n` +
          `  HTTP Status: ${response.status} ${response.statusText}\n` +
          `  Headers: ${JSON.stringify(interestingHeaders)}`,
          "log",
        );

        let responseText = "";
        try {
          responseText = await response.text();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await onLog(
            `[${options.label}] Failed to read response body text from ${baseUrl}/chat/completions: ${msg}`,
            "error",
          );
          return {
            status: "failed",
            summary: lastAssistant,
            error: `Failed to read response body: ${msg}`,
            model,
          };
        }

        if (!response.ok) {
          const retryAfter = response.headers.get("Retry-After");
          const retryHint = retryAfter ? ` retry-after: ${retryAfter}` : "";
          await onLog(
            `[${options.label}] HTTP ${response.status}${retryHint} Error Response from ${baseUrl}/chat/completions\n` +
            `  URL: ${baseUrl}/chat/completions\n` +
            `  API Key: ${redactedKey}\n` +
            `  Response Body: ${responseText.slice(0, 4000)}`,
            "error",
          );
          return {
            status: "failed",
            summary: "",
            error: `${options.label} ${response.status}:${retryHint} ${responseText.slice(0, 1000)}`,
            model,
          };
        }

        let json: {
          error?: any;
          choices?: Array<{
            message?: {
              role?: string;
              content?: string | null;
              tool_calls?: ToolCall[];
            };
          }>;
        };

        try {
          json = JSON.parse(responseText);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await onLog(
            `Failed to parse response JSON: ${msg}\n` +
            `  Raw response content (first 2000 chars): ${responseText.slice(0, 2000)}`,
            "error",
          );
          return {
            status: "failed",
            summary: "",
            error: `Failed to parse response JSON: ${msg}`,
            model,
          };
        }

        if (json.error) {
          await onLog(`API returned error block: ${JSON.stringify(json.error)}`, "error");
          const errorMsg =
            json.error.message ||
            json.error.error ||
            (typeof json.error === "string" ? json.error : JSON.stringify(json.error));
          return {
            status: "failed",
            summary: "",
            error: `${options.label} API error: ${errorMsg}`,
            model,
          };
        }

        const message = json.choices?.[0]?.message;
        if (!message) {
          await onLog(
            `Empty LLM response (no choices[0].message)\n` +
            `  JSON response: ${JSON.stringify(json).slice(0, 2000)}`,
            "error",
          );
          return {
            status: "failed",
            summary: "",
            error: "Empty LLM response",
            model,
          };
        }

        messages.push(message as Record<string, unknown>);
        const content = message.content?.trim() || "";
        if (content) {
          lastAssistant = content;
          await onLog(`[assistant step ${step + 1}] ${content.slice(0, 6000)}`, "log");
        }

        const toolCalls = message.tool_calls ?? [];
        await onLog(
          `Step ${step + 1} done in ${Date.now() - stepStarted}ms — tool_calls=${toolCalls.length}`,
          "status",
        );

        if (toolCalls.length === 0) {
          await onLog("No more tool calls — finishing", "status");
          return {
            status: "succeeded",
            summary: lastAssistant || "LLM finished without tool calls",
            model,
          };
        }

        for (const call of toolCalls) {
          if (signal.aborted) {
            return { status: "cancelled", summary: "Cancelled", model };
          }
          await onLog(
            `tool ${call.function.name}(${call.function.arguments.slice(0, 1500)})`,
            "log",
          );
          const toolStarted = Date.now();
          const result = await runTool(cwd, call.function.name, call.function.arguments);
          await onLog(
            `tool ${call.function.name} result (${Date.now() - toolStarted}ms):\n${result.slice(0, 6000)}`,
            "log",
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
      }

      await onLog(`Exceeded max steps (${maxSteps})`, "error");
      return {
        status: "failed",
        summary: lastAssistant,
        error: `Exceeded max steps (${maxSteps})`,
        model,
      };
    },
  };
}
