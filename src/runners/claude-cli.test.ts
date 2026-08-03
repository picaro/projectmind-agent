import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeCliRunner, extractUsageStats } from "./claude-cli.js";

describe("extractUsageStats", () => {
  it("extracts tokens, cost, and duration from a result event", () => {
    const stats = extractUsageStats({
      type: "result",
      duration_ms: 12_345,
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    });

    expect(stats).toEqual({
      durationMs: 12_345,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      totalTokens: 165,
      costUsd: 0.0421,
    });
  });

  it("returns null for non-result event types", () => {
    expect(extractUsageStats({ type: "assistant", usage: { input_tokens: 1 } })).toBeNull();
  });

  it("returns null when the result event carries no usage/cost/duration values", () => {
    expect(extractUsageStats({ type: "result", result: "done" })).toBeNull();
  });

  it("tolerates a missing usage object", () => {
    const stats = extractUsageStats({ type: "result", duration_ms: 500, total_cost_usd: 0.01 });
    expect(stats).toEqual({
      durationMs: 500,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      totalTokens: undefined,
      costUsd: 0.01,
    });
  });
});

function writeFakeClaudeCli(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-claude-"));
  const scriptPath = path.join(dir, "claude");
  const body = lines.map((line) => `echo '${line.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return scriptPath;
}

describe("createClaudeCliRunner", () => {
  it('treats the legacy "default" model sentinel as the Claude CLI default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-claude-"));
    const command = path.join(dir, "claude");
    fs.writeFileSync(
      command,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--model" ]; then exit 42; fi
done
echo '{"type":"result","is_error":false,"result":"All done"}'
`,
      { mode: 0o755 },
    );

    const runner = createClaudeCliRunner({ command, model: "default" });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.model).toBe("default");
  });

  it("reports usage stats parsed from the CLI's terminal result event", async () => {
    const command = writeFakeClaudeCli([
      JSON.stringify({ type: "system", session_id: "sess-1" }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "All done",
        duration_ms: 4_200,
        total_cost_usd: 0.0157,
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
    ]);

    const runner = createClaudeCliRunner({ command, model: "claude-opus-4" });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.model).toBe("claude-opus-4");
    expect(result.externalRunId).toBe("sess-1");
    expect(result.stats).toEqual({
      durationMs: 4_200,
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      totalTokens: 280,
      costUsd: 0.0157,
    });
  });

  it("omits stats when the CLI never emits a result event", async () => {
    const command = writeFakeClaudeCli([JSON.stringify({ type: "system", session_id: "sess-2" })]);

    const runner = createClaudeCliRunner({ command });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.stats).toBeUndefined();
  });
});
