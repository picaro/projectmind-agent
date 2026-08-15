import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCursorCliRunner,
  formatCursorCliExitError,
  parseCursorCliModelRejection,
  pickClosestCursorCliModel,
  resolveCursorCliModelFlag,
} from "./cursor-cli.js";

describe("resolveCursorCliModelFlag", () => {
  it("omits the ProjectMind default sentinel", () => {
    expect(resolveCursorCliModelFlag("default")).toBeUndefined();
    expect(resolveCursorCliModelFlag("")).toBeUndefined();
    expect(resolveCursorCliModelFlag(null)).toBeUndefined();
  });

  it("maps stale Anthropic / recovery ids onto current Cursor CLI catalog ids", () => {
    expect(resolveCursorCliModelFlag("claude-3-5-sonnet")).toBe("claude-4.5-sonnet");
    expect(resolveCursorCliModelFlag("claude-3.5-sonnet")).toBe("claude-4.5-sonnet");
    expect(resolveCursorCliModelFlag("claude-sonnet-4.5")).toBe("claude-4.5-sonnet");
  });

  it("passes through ids that are already Cursor CLI catalog names", () => {
    expect(resolveCursorCliModelFlag("claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(resolveCursorCliModelFlag("claude-4.5-sonnet")).toBe("claude-4.5-sonnet");
    expect(resolveCursorCliModelFlag("composer-2.5")).toBe("composer-2.5");
  });
});

describe("parseCursorCliModelRejection", () => {
  it("extracts the rejected id and available catalog from Cursor CLI stderr", () => {
    const parsed = parseCursorCliModelRejection(
      "Cannot use this model: claude-3-5-sonnet. Available models: auto, claude-4.5-sonnet, claude-4.5-opus-high",
    );
    expect(parsed).toEqual({
      rejected: "claude-3-5-sonnet",
      available: ["auto", "claude-4.5-sonnet", "claude-4.5-opus-high"],
    });
  });

  it("returns null when the output is not a model-catalog rejection", () => {
    expect(parseCursorCliModelRejection("agent: command not found")).toBeNull();
  });
});

describe("pickClosestCursorCliModel", () => {
  const catalog = [
    "auto",
    "composer-2.5",
    "claude-4.5-opus-high",
    "claude-4.5-opus-high-thinking",
    "claude-4.5-sonnet",
    "claude-4.5-sonnet-thinking",
    "claude-sonnet-5-medium",
    "claude-4-sonnet",
    "gpt-5.2",
  ];

  it("prefers the matching family over other vendors", () => {
    expect(pickClosestCursorCliModel("claude-3-5-sonnet", catalog)).toBe("claude-4.5-sonnet");
    expect(pickClosestCursorCliModel("claude-opus-4-5", catalog)).toBe("claude-4.5-opus-high");
  });

  it("falls back to auto when no family match exists", () => {
    expect(pickClosestCursorCliModel("mystery-model", catalog)).toBe("auto");
  });
});

describe("formatCursorCliExitError", () => {
  it("does not dump the available-models catalog into the job error", () => {
    const output =
      "Cannot use this model: claude-3-5-sonnet. Available models: auto, high-fast, composer-2.5-fast, " +
      "claude-opus-5-low, ".repeat(80) +
      "glm-5.2-max";
    const error = formatCursorCliExitError(1, output);
    expect(error).toBe(
      "Cursor CLI exited with code 1: cannot use model claude-3-5-sonnet (not in the current Cursor CLI catalog)",
    );
    expect(error.length).toBeLessThan(200);
  });
});

describe("createCursorCliRunner", () => {
  it('treats the legacy "default" model sentinel as the Cursor CLI default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-cursor-"));
    const command = path.join(dir, "agent");
    fs.writeFileSync(
      command,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--model" ]; then exit 42; fi
done
echo '{"type":"result","result":"All done"}'
`,
      { mode: 0o755 },
    );

    const runner = createCursorCliRunner({ command, model: "default" });
    const result = await runner.run({
      cwd: dir,
      prompt: "do the thing",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.model).toBe("default");
  });

  it("maps claude-3-5-sonnet before spawning so Cursor CLI never sees the stale id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-cursor-"));
    const command = path.join(dir, "agent");
    fs.writeFileSync(
      command,
      `#!/bin/sh
model=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--model" ]; then model="$arg"; fi
  prev="$arg"
done
if [ "$model" = "claude-3-5-sonnet" ]; then
  echo "Cannot use this model: claude-3-5-sonnet. Available models: auto, claude-4.5-sonnet" >&2
  exit 1
fi
if [ "$model" != "claude-4.5-sonnet" ]; then
  echo "unexpected model: $model" >&2
  exit 3
fi
echo '{"type":"result","result":"ok"}'
`,
      { mode: 0o755 },
    );

    const logs: string[] = [];
    const runner = createCursorCliRunner({ command, model: "claude-3-5-sonnet" });
    const result = await runner.run({
      cwd: dir,
      prompt: "do the thing",
      onLog: (msg) => {
        logs.push(msg);
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.model).toBe("claude-4.5-sonnet");
    expect(logs.some((m) => m.includes("Mapped Cursor CLI model claude-3-5-sonnet → claude-4.5-sonnet"))).toBe(
      true,
    );
  });

  it("retries with the closest catalog id when Cursor CLI rejects an unmapped model", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-fake-cursor-"));
    const command = path.join(dir, "agent");
    fs.writeFileSync(
      command,
      `#!/bin/sh
model=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--model" ]; then model="$arg"; fi
  prev="$arg"
done
if [ "$model" = "claude-sonnet-legacy" ]; then
  echo "Cannot use this model: claude-sonnet-legacy. Available models: auto, claude-4.5-sonnet, claude-4.5-opus-high" >&2
  exit 1
fi
if [ "$model" != "claude-4.5-sonnet" ]; then
  echo "unexpected model: $model" >&2
  exit 3
fi
echo '{"type":"result","result":"ok after remap"}'
`,
      { mode: 0o755 },
    );

    const logs: string[] = [];
    const runner = createCursorCliRunner({ command, model: "claude-sonnet-legacy" });
    const result = await runner.run({
      cwd: dir,
      prompt: "do the thing",
      onLog: (msg) => {
        logs.push(msg);
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("ok after remap");
    expect(result.model).toBe("claude-4.5-sonnet");
    expect(logs.some((m) => /retrying with claude-4\.5-sonnet/.test(m))).toBe(true);
  });
});
