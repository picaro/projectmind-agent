import type { Runner, RunnerResult } from "./types.js";

function summarizeEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return String(event);
  }
  const ev = event as Record<string, unknown>;
  const type = typeof ev.type === "string" ? ev.type : "unknown";

  if (type === "assistant") {
    const message = ev.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const texts =
      message?.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text!) ?? [];
    if (texts.length) return texts.join("\n");
    return "[assistant] (no text)";
  }

  if (type === "thinking") {
    const text = typeof ev.text === "string" ? ev.text : JSON.stringify(ev).slice(0, 2_000);
    return `[thinking] ${text}`;
  }

  if (type === "tool_call" || type === "tool-call") {
    const name =
      (ev.name as string | undefined) ||
      (ev.toolName as string | undefined) ||
      (ev.tool_call as { name?: string } | undefined)?.name ||
      "tool";
    const args =
      ev.arguments ?? ev.args ?? (ev.tool_call as { arguments?: unknown } | undefined)?.arguments;
    const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 0);
    return `[tool_call] ${name}(${String(argsStr).slice(0, 2_000)})`;
  }

  if (type === "tool_result" || type === "tool-result") {
    const name = (ev.name as string | undefined) || (ev.toolName as string | undefined) || "tool";
    const result = ev.result ?? ev.content ?? ev.output;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 0);
    return `[tool_result] ${name}: ${String(resultStr).slice(0, 4_000)}`;
  }

  if (type === "status" || type === "system") {
    const text =
      (typeof ev.text === "string" && ev.text) ||
      (typeof ev.message === "string" && ev.message) ||
      JSON.stringify(ev).slice(0, 2_000);
    return `[${type}] ${text}`;
  }

  if (type === "user") {
    const text = (typeof ev.text === "string" && ev.text) || JSON.stringify(ev).slice(0, 2_000);
    return `[user] ${text}`;
  }

  // Fallback: log type + compact JSON so we don't silently drop events
  try {
    return `[${type}] ${JSON.stringify(ev).slice(0, 3_000)}`;
  } catch {
    return `[${type}]`;
  }
}

export function createCursorSdkRunner(options: { apiKey: string; model?: string }): Runner {
  const model = options.model?.trim() || "composer-2.5";

  return {
    name: "cursor_sdk",
    async run({ cwd, prompt, onLog, signal }): Promise<RunnerResult> {
      if (!options.apiKey) {
        return {
          status: "failed",
          summary: "",
          error: "CURSOR_API_KEY is required for cursor_sdk runner",
          model,
        };
      }

      const { Agent, CursorAgentError } = await import("@cursor/sdk");

      await onLog(`Starting Cursor SDK agent (model=${model}) in ${cwd}`, "status");
      await onLog(`Prompt chars=${prompt.length}`, "log");

      try {
        const createStarted = Date.now();
        await using agent = await Agent.create({
          apiKey: options.apiKey,
          model: { id: model },
          local: { cwd },
        });
        await onLog(`Agent.create OK in ${Date.now() - createStarted}ms`, "status");

        const sendStarted = Date.now();
        const run = await agent.send(prompt);
        await onLog(`Cursor run started: ${run.id} (send ${Date.now() - sendStarted}ms)`, "status");

        const cancelIfNeeded = async () => {
          if (signal.aborted && run.supports("cancel")) {
            await onLog("Cancel requested — calling run.cancel()", "status");
            await run.cancel();
          }
        };
        signal.addEventListener("abort", () => {
          void cancelIfNeeded();
        });

        let eventCount = 0;
        for await (const event of run.stream()) {
          if (signal.aborted) break;
          eventCount += 1;
          const line = summarizeEvent(event);
          if (line) {
            await onLog(line.slice(0, 7_000), "log");
          }
          if (eventCount % 25 === 0) {
            await onLog(`Stream progress: ${eventCount} events so far`, "status");
          }
        }

        await onLog(`Stream ended after ${eventCount} events`, "status");

        if (signal.aborted) {
          await cancelIfNeeded();
          return {
            status: "cancelled",
            summary: "Cancelled",
            externalRunId: run.id,
            model,
          };
        }

        const result = await run.wait();
        await onLog(`run.wait() => status=${result.status} id=${result.id}`, "status");

        if (result.status === "error") {
          return {
            status: "failed",
            summary: "",
            error: `Cursor run failed (${result.id})`,
            externalRunId: result.id,
            model,
          };
        }

        return {
          status: "succeeded",
          summary:
            typeof result.result === "string"
              ? result.result.slice(0, 8000)
              : `Cursor run finished (${result.status})`,
          externalRunId: result.id,
          model,
        };
      } catch (err) {
        if (err instanceof CursorAgentError) {
          await onLog(`CursorAgentError: ${err.message}`, "error");
          return {
            status: "failed",
            summary: "",
            error: `Cursor startup failed: ${err.message}`,
            model,
          };
        }
        await onLog(`Runner error: ${err instanceof Error ? err.message : String(err)}`, "error");
        return {
          status: "failed",
          summary: "",
          error: err instanceof Error ? err.message : String(err),
          model,
        };
      }
    },
  };
}
