import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAntigravityCliRunner, resolveAntigravityCliModel } from "./antigravity-cli.js";

describe("resolveAntigravityCliModel", () => {
  it("maps Cursor Grok High onto an agy catalog id", () => {
    expect(resolveAntigravityCliModel("cursor-grok-4.6-high")).toBe("claude-opus-4-6-thinking");
    expect(resolveAntigravityCliModel("cursor-grok-4.6-high-fast")).toBe(
      "claude-opus-4-6-thinking",
    );
  });

  it("drops other Cursor and Composer leftovers", () => {
    expect(resolveAntigravityCliModel("cursor-small")).toBeUndefined();
    expect(resolveAntigravityCliModel("composer-2.5")).toBeUndefined();
    expect(resolveAntigravityCliModel("auto")).toBeUndefined();
  });

  it("keeps native agy ids", () => {
    expect(resolveAntigravityCliModel("gemini-3.7-flash-high")).toBe("gemini-3.7-flash-high");
  });
});

describe("createAntigravityCliRunner", () => {
  it("does not pass cursor-grok-4.6-high to agy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-agy-"));
    const command = path.join(dir, "agy");
    fs.writeFileSync(
      command,
      `#!/bin/sh
model=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--model" ]; then model="$arg"; fi
  prev="$arg"
done
if [ "$model" = "cursor-grok-4.6-high" ]; then
  echo 'error: invalid model selection' >&2
  exit 1
fi
echo "model=$model"
`,
      { mode: 0o755 },
    );

    const runner = createAntigravityCliRunner({
      command,
      model: "cursor-grok-4.6-high",
      skipPermissions: false,
    });
    const result = await runner.run({
      cwd: dir,
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.summary).toContain("model=claude-opus-4-6-thinking");
    expect(result.model).toBe("claude-opus-4-6-thinking");
  });
});
