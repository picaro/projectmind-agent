import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  class CursorAgentError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "CursorAgentError";
    }
  }
  return { CursorAgentError, create: vi.fn() };
});

vi.mock("@cursor/sdk", () => ({
  CursorAgentError: sdk.CursorAgentError,
  Agent: {
    create: (...args: unknown[]) => sdk.create(...args),
  },
}));

import { createCursorSdkRunner, cursorSdkCreateOptions } from "./cursor.js";

const silentLog = async () => {};

function disposableAgent(run: Record<string, unknown>) {
  return {
    send: async () => run,
    [Symbol.asyncDispose]: async () => {},
  };
}

describe("cursorSdkCreateOptions", () => {
  it("omits mcpServers when delegation MCP is not provided", () => {
    const options = cursorSdkCreateOptions({
      apiKey: "cursor-key",
      model: "composer-2.5",
      cwd: "/tmp/ws",
    });
    expect(options.mcpServers).toBeUndefined();
    expect(options.local).toEqual({ cwd: "/tmp/ws" });
  });

  it("passes ProjectMind HTTP MCP when delegation is allowed", () => {
    const options = cursorSdkCreateOptions({
      apiKey: "cursor-key",
      model: "composer-2.5",
      cwd: "/tmp/ws",
      mcp: { url: "https://projectm.dev/api/mcp", apiKey: "imk_test" },
    });
    expect(options.mcpServers).toEqual({
      projectmind: {
        type: "http",
        url: "https://projectm.dev/api/mcp",
        headers: { Authorization: "Bearer imk_test" },
      },
    });
  });
});

describe("createCursorSdkRunner", () => {
  it("fails before creating an agent when the API key is missing", async () => {
    sdk.create.mockClear();
    const runner = createCursorSdkRunner({ apiKey: "" });
    const result = await runner.run({
      cwd: "/tmp/ws",
      prompt: "hi",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "CURSOR_API_KEY is required for cursor_sdk runner",
      model: "composer-2.5",
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("returns a sliced string result and logs the default model", async () => {
    const logs: string[] = [];
    sdk.create.mockResolvedValue(
      disposableAgent({
        id: "run-1",
        supports: () => false,
        cancel: async () => {},
        stream: async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: "working" }] } };
        },
        wait: async () => ({ status: "finished", id: "run-1", result: "z".repeat(9000) }),
      }),
    );
    const runner = createCursorSdkRunner({ apiKey: "key" });
    const result = await runner.run({
      cwd: "/tmp/ws",
      prompt: "hi",
      onLog: async (message) => {
        logs.push(message);
      },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("succeeded");
    expect(result.summary).toHaveLength(8000);
    expect(result.stats).toBeUndefined();
    expect(logs.some((line) => line.includes("model=composer-2.5"))).toBe(true);
    expect(logs.some((line) => line.includes("working"))).toBe(true);
  });

  it("uses a non-string result as a finished status summary", async () => {
    sdk.create.mockResolvedValue(
      disposableAgent({
        id: "run-2",
        supports: () => false,
        cancel: async () => {},
        stream: async function* () {},
        wait: async () => ({ status: "finished", id: "run-2", result: { ok: true } }),
      }),
    );
    const runner = createCursorSdkRunner({ apiKey: "key", model: "custom" });
    const result = await runner.run({
      cwd: "/tmp/ws",
      prompt: "hi",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      summary: "Cursor run finished (finished)",
      model: "custom",
    });
  });

  it("fails when the run status is error", async () => {
    sdk.create.mockResolvedValue(
      disposableAgent({
        id: "run-3",
        supports: () => false,
        cancel: async () => {},
        stream: async function* () {},
        wait: async () => ({ status: "error", id: "run-3" }),
      }),
    );
    const runner = createCursorSdkRunner({ apiKey: "key" });
    const result = await runner.run({
      cwd: "/tmp/ws",
      prompt: "hi",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("run-3");
  });

  it("maps CursorAgentError and generic failures", async () => {
    sdk.create.mockRejectedValueOnce(new sdk.CursorAgentError("bad key"));
    const runner = createCursorSdkRunner({ apiKey: "key" });
    const startup = await runner.run({
      cwd: "/tmp/ws",
      prompt: "hi",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(startup.error).toContain("Cursor startup failed: bad key");

    sdk.create.mockRejectedValueOnce(new Error("socket hang up"));
    const generic = await runner.run({
      cwd: "/tmp/ws",
      prompt: "hi",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(generic).toMatchObject({ status: "failed", error: "socket hang up" });
  });

  it("cancels when the signal aborts during the stream", async () => {
    const controller = new AbortController();
    let cancelled = false;
    sdk.create.mockResolvedValue(
      disposableAgent({
        id: "run-4",
        supports: () => true,
        cancel: async () => {
          cancelled = true;
        },
        stream: async function* () {
          yield { type: "status", text: "working" };
          controller.abort();
          yield { type: "status", text: "should not be logged after abort" };
        },
        wait: async () => ({ status: "finished", id: "run-4", result: "nope" }),
      }),
    );
    const runner = createCursorSdkRunner({ apiKey: "key" });
    const result = await runner.run({
      cwd: "/tmp/ws",
      prompt: "hi",
      onLog: silentLog,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(cancelled).toBe(true);
  });
});
