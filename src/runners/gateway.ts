/**
 * HTTP runner that reaches models through the ProjectMind LLM gateway.
 *
 * This is the migrated form of the `openrouter` / `tokenrouter` runners: same
 * tool-calling loop, same `Runner` contract, but every completion goes to
 * `POST {baseUrl}/api/executions/{executionId}/llm/completions` authenticated
 * with the execution-scoped grant token from the claim response — never to a
 * provider endpoint with a local API key.
 *
 * The agent holds no provider credential in this path. Model choice, funding,
 * quota, and budget are decided server-side; the policy echoed in the claim
 * response is advisory (for pacing and logs), and the server re-enforces it on
 * every call.
 */

import { resolveMaxSteps, runTool, TOOLS } from "./llm.js";
import type { Runner, RunnerResult } from "./types.js";

export type ExecutionModelGateway = {
  baseUrl: string;
  completionsPath: string;
  token: string;
  expiresAt: string;
  policy?: {
    accessMode?: string;
    allowedBillingSources?: string[];
    qualityTier?: string;
    allowPaidFallback?: boolean;
    maximumMicroCredits?: number | null;
    maximumLlmCalls?: number;
    preferredModelAlias?: string | null;
  } | null;
};

type GatewayResponseBody = {
  text?: string;
  toolCalls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  model?: string;
  providerType?: string;
  billingSource?: string;
  usage?: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  };
  chargedMicroCredits?: number;
  callsUsed?: number;
  maximumLlmCalls?: number;
  error?: string;
  code?: string;
};

const REQUEST_TIMEOUT_MS = 180_000;

function completionsUrl(gateway: ExecutionModelGateway, executionId: string): string {
  const base = gateway.baseUrl.replace(/\/+$/, "");
  const path = gateway.completionsPath?.trim() || `/api/executions/${executionId}/llm/completions`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function createGatewayRunner(options: {
  /** Kept so job history, cooldowns, and stats keep their existing labels. */
  name: "openrouter" | "tokenrouter";
  executionId: string;
  gateway: ExecutionModelGateway;
  maxSteps?: number;
}): Runner {
  const url = completionsUrl(options.gateway, options.executionId);
  const maxSteps = resolveMaxSteps(options.maxSteps);
  const policyCap = options.gateway.policy?.maximumLlmCalls;
  const stepCap = policyCap && policyCap > 0 ? Math.min(maxSteps, policyCap) : maxSteps;

  return {
    name: options.name,
    async run({ cwd, prompt, onLog, signal }): Promise<RunnerResult> {
      await onLog(
        `Starting ProjectMind gateway runner (execution=${options.executionId}) in ${cwd}`,
        "status",
      );
      await onLog(
        `Gateway policy: accessMode=${options.gateway.policy?.accessMode ?? "unknown"} ` +
          `tier=${options.gateway.policy?.qualityTier ?? "unknown"} ` +
          `paidFallback=${options.gateway.policy?.allowPaidFallback ?? "unknown"} ` +
          `maxCalls=${policyCap ?? "unset"}`,
        "log",
      );

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
      let model: string | undefined;

      for (let step = 0; step < stepCap; step += 1) {
        if (signal.aborted) {
          await onLog(`Aborted at step ${step + 1}`, "status");
          return { status: "cancelled", summary: "Cancelled", model };
        }

        await onLog(`Gateway step ${step + 1}/${stepCap} — requesting completion`, "status");
        const started = Date.now();

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              // The grant token is execution-scoped and short-lived. It is never
              // logged, and it is not a provider credential.
              Authorization: `Bearer ${options.gateway.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ messages, tools: TOOLS }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await onLog(`[gateway] request to ${url} failed: ${msg}`, "error");
          return {
            status: "failed",
            summary: lastAssistant,
            error: `Gateway request failed: ${msg}`,
            model,
          };
        }

        let body: GatewayResponseBody;
        try {
          body = (await response.json()) as GatewayResponseBody;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: "failed",
            summary: lastAssistant,
            error: `Could not parse gateway response: ${msg}`,
            model,
          };
        }

        if (!response.ok) {
          const code = body.code ?? String(response.status);
          await onLog(
            `[gateway] HTTP ${response.status} (${code}) from ${url}: ${body.error ?? ""}`,
            "error",
          );
          // A cancelled or finished execution is not a runner failure to retry.
          const cancelled = code === "EXECUTION_NOT_ACTIVE" || code === "EXECUTION_CANCELLED";
          return {
            status: cancelled ? "cancelled" : "failed",
            summary: lastAssistant,
            error: `Gateway ${response.status} ${code}: ${body.error ?? "request refused"}`,
            model,
          };
        }

        model = body.model ?? model;
        const content = body.text?.trim() ?? "";
        const toolCalls = body.toolCalls ?? [];

        await onLog(
          `[gateway] step ${step + 1} done in ${Date.now() - started}ms ` +
            `model=${body.model ?? "?"} billing=${body.billingSource ?? "?"} ` +
            `tokens=${body.usage?.totalTokens ?? "?"} tool_calls=${toolCalls.length} ` +
            `calls=${body.callsUsed ?? "?"}/${body.maximumLlmCalls ?? "?"}`,
          "log",
        );

        messages.push({
          role: "assistant",
          content: body.text ?? "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        if (content) {
          lastAssistant = content;
          await onLog(`[assistant step ${step + 1}] ${content.slice(0, 6000)}`, "log");
        }

        if (toolCalls.length === 0) {
          await onLog("No more tool calls — finishing", "status");
          return {
            status: "succeeded",
            summary: lastAssistant || "Gateway run finished without tool calls",
            model,
          };
        }

        for (const call of toolCalls) {
          if (signal.aborted) return { status: "cancelled", summary: "Cancelled", model };
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
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }

      await onLog(`Exceeded max steps (${stepCap})`, "error");
      return {
        status: "failed",
        summary: lastAssistant,
        error: `Exceeded max steps (${stepCap})`,
        model,
      };
    },
  };
}
