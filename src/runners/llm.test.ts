import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterRunner, createTokenRouterRunner, maskApiKey } from "./llm.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("maskApiKey", () => {
  it("correctly redacts API keys safely without leaking", () => {
    expect(maskApiKey(null)).toBe("(none)");
    expect(maskApiKey("")).toBe("(none)");
    expect(maskApiKey("12345")).toBe("12***5 (len 5)");
    expect(maskApiKey("sk-or-v1-abcdef1234567890")).toBe("sk-or-v1-...7890 (len 25)");
    expect(maskApiKey("tr-secret-key-123456")).toBe("tr-secre...3456 (len 20)");
  });
});

describe("createTokenRouterRunner", () => {
  it("uses the TokenRouter OpenAI-compatible endpoint, model, and credentials", async () => {
    const logs: Array<{ message: string; type: string }> = [];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTokenRouterRunner({
      apiKey: "tr-key-1234567890",
      model: "anthropic/claude-sonnet-4",
    }).run({
      cwd: process.cwd(),
      prompt: "Make a focused change",
      onLog: async (msg, type) => {
        logs.push({ message: msg, type: type || "log" });
      },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      summary: "done",
      model: "anthropic/claude-sonnet-4",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tokenrouter.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tr-key-1234567890" });
    expect(logs.some((l) => l.message.includes("Triggering HTTP POST request"))).toBe(true);
    expect(logs.some((l) => l.message.includes("https://api.tokenrouter.com/v1/chat/completions"))).toBe(true);
  });

  it("fails clearly when the agent has no TokenRouter key", async () => {
    const result = await createTokenRouterRunner({ apiKey: "" }).run({
      cwd: process.cwd(),
      prompt: "test",
      onLog: () => {},
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "TOKENROUTER_API_KEY is required for tokenrouter runner",
    });
  });
});

describe("createOpenRouterRunner", () => {
  it("uses the OpenRouter endpoint, model, credentials, and optional attribution headers with detailed tracking logs", async () => {
    const logs: Array<{ message: string; type: string }> = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const runner = createOpenRouterRunner({
      apiKey: "sk-or-v1-secret123456",
      model: "anthropic/claude-sonnet-4",
      httpReferer: "https://projectmind.app",
      appTitle: "ProjectMind Agent",
    });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "Make a focused change",
      onLog: async (msg, type) => {
        logs.push({ message: msg, type: type || "log" });
      },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      summary: "done",
      model: "anthropic/claude-sonnet-4",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk-or-v1-secret123456",
      "HTTP-Referer": "https://projectmind.app",
      "X-OpenRouter-Title": "ProjectMind Agent",
      "X-Title": "ProjectMind Agent",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "anthropic/claude-sonnet-4" });

    // Assert detailed tracking log outputs
    const triggerLog = logs.find((l) => l.message.includes("Triggering HTTP POST request"));
    expect(triggerLog).toBeDefined();
    expect(triggerLog?.message).toContain("URL: https://openrouter.ai/api/v1/chat/completions");
    expect(triggerLog?.message).toContain("API Key: sk-or-v1-...3456");
    expect(triggerLog?.message).toContain("Payload Size:");

    const respLog = logs.find((l) => l.message.includes("Response received from"));
    expect(respLog).toBeDefined();
    expect(respLog?.message).toContain("HTTP Status: 200");
  });

  it("surfaces Retry-After so provider pacing can honor OpenRouter throttling", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("rate limited", { status: 429, headers: { "Retry-After": "12" } }),
        ),
    );
    const result = await createOpenRouterRunner({ apiKey: "or-key" }).run({
      cwd: process.cwd(),
      prompt: "test",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.error).toContain("OpenRouter 429");
    expect(result.error).toContain("retry-after: 12");
  });

  it("fails clearly when the agent has no OpenRouter key", async () => {
    const result = await createOpenRouterRunner({ apiKey: "" }).run({
      cwd: process.cwd(),
      prompt: "test",
      onLog: () => {},
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "OPENROUTER_API_KEY is required for openrouter runner",
    });
  });

  it("respects maxSteps option or MAX_AGENT_STEPS environment variable", async () => {
    let stepCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      stepCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: `call_${stepCount}`,
                      function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createOpenRouterRunner({ apiKey: "or-key", maxSteps: 3 }).run({
      cwd: process.cwd(),
      prompt: "test",
      onLog: () => {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Exceeded max steps (3)");
    expect(stepCount).toBe(3);
  });
});
