import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayRunner, type ExecutionModelGateway } from "./gateway.js";
import { createRunnerByName } from "./resolve.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const GATEWAY: ExecutionModelGateway = {
  baseUrl: "https://control.example/",
  completionsPath: "/api/executions/job-1/llm/completions",
  token: "grant-token-abc",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  policy: {
    accessMode: "AUTO",
    qualityTier: "standard",
    allowPaidFallback: false,
    maximumLlmCalls: 5,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function run(runner: ReturnType<typeof createGatewayRunner>, logs: string[] = []) {
  return runner.run({
    cwd: process.cwd(),
    prompt: "Make a focused change",
    onLog: async (message) => {
      logs.push(message);
    },
    signal: new AbortController().signal,
  });
}

describe("createGatewayRunner", () => {
  it("calls the execution endpoint with the grant token and no provider key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ text: "all done", toolCalls: [], model: "gpt-4o-mini" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run(
      createGatewayRunner({ name: "openrouter", executionId: "job-1", gateway: GATEWAY }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("all done");
    expect(result.model).toBe("gpt-4o-mini");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://control.example/api/executions/job-1/llm/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer grant-token-abc");

    // No provider endpoint and no provider credential are involved.
    expect(url).not.toContain("openrouter.ai");
    const body = JSON.parse(String(init.body)) as { messages: unknown[]; tools: unknown[] };
    expect(body.messages).toHaveLength(2);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(String(init.body)).not.toContain("sk-");
  });

  it("feeds tool results back through the gateway until the model stops calling tools", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          text: "",
          toolCalls: [{ id: "call-1", function: { name: "list_dir", arguments: '{"path":"."}' } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ text: "finished", toolCalls: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run(
      createGatewayRunner({ name: "tokenrouter", executionId: "job-1", gateway: GATEWAY }),
    );

    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
    ) as { messages: Array<{ role: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("treats a cancelled execution as cancelled, not as a retryable failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "Execution is no longer active", code: "EXECUTION_NOT_ACTIVE" },
            409,
          ),
        ),
    );

    const result = await run(
      createGatewayRunner({ name: "openrouter", executionId: "job-1", gateway: GATEWAY }),
    );
    expect(result.status).toBe("cancelled");
  });

  it("surfaces a budget refusal as a failure without leaking the token", async () => {
    const logs: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "Not enough credits", code: "INSUFFICIENT_CREDITS" }, 402),
        ),
    );

    const result = await run(
      createGatewayRunner({ name: "openrouter", executionId: "job-1", gateway: GATEWAY }),
      logs,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("INSUFFICIENT_CREDITS");
    expect(logs.join("\n")).not.toContain("grant-token-abc");
  });

  it("caps its own steps at the policy's maximumLlmCalls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        text: "",
        toolCalls: [{ id: "c", function: { name: "list_dir", arguments: '{"path":"."}' } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await run(
      createGatewayRunner({
        name: "openrouter",
        executionId: "job-1",
        gateway: { ...GATEWAY, policy: { ...GATEWAY.policy, maximumLlmCalls: 2 } },
      }),
    );

    expect(result.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createRunnerByName with an execution grant", () => {
  it("routes the HTTP runners through the gateway instead of the provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: "ok", toolCalls: [] }));
    vi.stubGlobal("fetch", fetchMock);

    for (const name of ["openrouter", "tokenrouter"] as const) {
      const runner = createRunnerByName(name, null, {
        executionId: "job-1",
        gateway: GATEWAY,
      });
      // The runner keeps its identity so queue history and cooldowns are unchanged.
      expect(runner.name).toBe(name);
      await run(runner);
    }

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("/api/executions/job-1/llm/completions");
    }
  });

  it("falls back to the direct provider path when no grant was issued", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { role: "assistant", content: "done" } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENROUTER_API_KEY = "sk-or-v1-testkey000000000";

    try {
      await run(createRunnerByName("openrouter", null, null) as never);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("openrouter.ai");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
