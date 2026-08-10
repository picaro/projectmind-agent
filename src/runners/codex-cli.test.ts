import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexCliRunner, extractCodexUsageDelta } from "./codex-cli.js";

describe("extractCodexUsageDelta", () => {
  it("extracts input/output/cached tokens from a turn.completed event", () => {
    const stats = extractCodexUsageDelta({
      type: "turn.completed",
      usage: { input_tokens: 24_763, cached_input_tokens: 24_448, output_tokens: 122 },
    });

    expect(stats).toEqual({
      inputTokens: 24_763,
      outputTokens: 122,
      cacheReadTokens: 24_448,
      totalTokens: 24_885,
    });
  });

  it("returns null for non-turn.completed event types", () => {
    expect(extractCodexUsageDelta({ type: "turn.started" })).toBeNull();
  });

  it("returns null when the event carries no usage object", () => {
    expect(extractCodexUsageDelta({ type: "turn.completed" })).toBeNull();
  });
});

describe("createCodexCliRunner", () => {
  it("allows jobs to run outside a Git repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-codex-args-"));
    const command = path.join(dir, "codex");
    fs.writeFileSync(
      command,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--skip-git-repo-check" ]; then
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"Git check skipped"}}'
    exit 0
  fi
done
echo "missing --skip-git-repo-check" >&2
exit 42
`,
      { mode: 0o755 },
    );

    const runner = createCodexCliRunner({ command });
    const result = await runner.run({
      cwd: dir,
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("Git check skipped");
  });

  it("reports accumulated token usage summed across multiple turn.completed events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-codex-usage-"));
    const command = path.join(dir, "codex");
    fs.writeFileSync(
      command,
      `#!/bin/sh
echo '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20}}'
echo '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":5,"output_tokens":8}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"All done"}}'
`,
      { mode: 0o755 },
    );

    const runner = createCodexCliRunner({ command });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.stats).toEqual({
      inputTokens: 150,
      outputTokens: 28,
      cacheReadTokens: 15,
      totalTokens: 178,
    });
  });

  it('treats the legacy "default" model sentinel as the Codex CLI default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-codex-"));
    const command = path.join(dir, "codex");
    fs.writeFileSync(
      command,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "-m" ]; then exit 42; fi
done
echo '{"type":"item.completed","item":{"type":"agent_message","text":"All done"}}'
`,
      { mode: 0o755 },
    );

    const runner = createCodexCliRunner({ command, model: "default" });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("All done");
    expect(result.model).toBe("default");
  });

  describe("authentication", () => {
    function makeEnvEchoCodex(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-codex-env-"));
      const command = path.join(dir, "codex");
      fs.writeFileSync(
        command,
        `#!/bin/sh
printf '{"type":"item.completed","item":{"type":"agent_message","text":"OPENAI=%s CODEX=%s"}}\\n' "\${OPENAI_API_KEY:-unset}" "\${CODEX_API_KEY:-unset}"
`,
        { mode: 0o755 },
      );
      return command;
    }

    async function runWith(apiKey: string | undefined, inherited: string | undefined) {
      const command = makeEnvEchoCodex();
      const prevOpenAi = process.env.OPENAI_API_KEY;
      const prevCodex = process.env.CODEX_API_KEY;
      if (inherited === undefined) {
        delete process.env.OPENAI_API_KEY;
        delete process.env.CODEX_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = inherited;
        process.env.CODEX_API_KEY = inherited;
      }
      try {
        const runner = createCodexCliRunner({ command, apiKey });
        return await runner.run({
          cwd: process.cwd(),
          prompt: "do the thing",
          onLog: () => {},
          signal: new AbortController().signal,
        });
      } finally {
        if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevOpenAi;
        if (prevCodex === undefined) delete process.env.CODEX_API_KEY;
        else process.env.CODEX_API_KEY = prevCodex;
      }
    }

    it("strips a configured key by default so Codex uses subscription auth", async () => {
      const result = await runWith("sk-configured", undefined);
      expect(result.status).toBe("succeeded");
      expect(result.summary).toBe("OPENAI=unset CODEX=unset");
    });

    it("strips an inherited key when none is configured, so Codex uses subscription auth", async () => {
      const result = await runWith(undefined, "sk-leaked-from-shell");
      expect(result.status).toBe("succeeded");
      expect(result.summary).toBe("OPENAI=unset CODEX=unset");
    });

    it("strips both configured and inherited keys", async () => {
      const result = await runWith("sk-configured", "sk-leaked-from-shell");
      expect(result.status).toBe("succeeded");
      expect(result.summary).toBe("OPENAI=unset CODEX=unset");
    });

    it("allows API-key auth only with an explicit opt-in", async () => {
      const previous = process.env.IMEMORY_CODEX_AUTH_MODE;
      process.env.IMEMORY_CODEX_AUTH_MODE = "api_key";
      try {
        const result = await runWith("sk-configured", "sk-leaked-from-shell");
        expect(result.status).toBe("succeeded");
        expect(result.summary).toBe("OPENAI=sk-configured CODEX=sk-configured");
      } finally {
        if (previous === undefined) delete process.env.IMEMORY_CODEX_AUTH_MODE;
        else process.env.IMEMORY_CODEX_AUTH_MODE = previous;
      }
    });
  });
});
