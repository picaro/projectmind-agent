import { describe, expect, it } from "vitest";
import { candidateHealthCheckRunners, checkRunnerHealth, runHealthCheck } from "./health-check.js";

describe("candidateHealthCheckRunners", () => {
  it("includes installed CLIs plus OpenRouter/TokenRouter when keys are configured", async () => {
    const chain = await candidateHealthCheckRunners({
      autoChainDeps: {
        cursorKey: "",
        commandExists: async (cmd) => cmd === "claude",
        claudeBin: "claude",
        cursorBin: "agent",
        codexBin: "codex",
        antigravityBin: "agy",
        copilotBin: "copilot",
      },
      openRouterApiKey: () => "or-test",
      tokenRouterApiKey: () => "tr-test",
    });
    expect(chain).toEqual(["claude_cli", "openrouter", "tokenrouter"]);
  });

  it("omits API runners when no key is configured", async () => {
    const chain = await candidateHealthCheckRunners({
      autoChainDeps: { cursorKey: "", commandExists: async () => false },
      openRouterApiKey: () => "",
      tokenRouterApiKey: () => "",
    });
    expect(chain).toEqual([]);
  });
});

describe("checkRunnerHealth", () => {
  it("reports ok when the runner succeeds", async () => {
    const result = await checkRunnerHealth("claude_cli", {
      createRunner: () => ({
        name: "claude_cli",
        run: async () => ({ status: "succeeded", summary: "OK", model: "claude-x" }),
      }),
    });
    expect(result).toMatchObject({ runner: "claude_cli", ok: true, model: "claude-x" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports failure with the runner's error", async () => {
    const result = await checkRunnerHealth("codex_cli", {
      createRunner: () => ({
        name: "codex_cli",
        run: async () => ({ status: "failed", summary: "", error: "command not found" }),
      }),
    });
    expect(result).toMatchObject({ runner: "codex_cli", ok: false, error: "command not found" });
  });

  it("reports failure when the runner throws", async () => {
    const result = await checkRunnerHealth("copilot_cli", {
      createRunner: () => ({
        name: "copilot_cli",
        run: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    });
    expect(result).toMatchObject({ runner: "copilot_cli", ok: false, error: "spawn ENOENT" });
  });

  it("aborts and reports failure when the runner exceeds the timeout", async () => {
    const result = await checkRunnerHealth("claude_cli", {
      timeoutMs: 10,
      createRunner: () => ({
        name: "claude_cli",
        run: async ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ status: "cancelled", summary: "" }));
          }),
      }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("runHealthCheck", () => {
  it("checks every candidate runner sequentially and returns one result per runner", async () => {
    const calls: string[] = [];
    const results = await runHealthCheck({
      autoChainDeps: { cursorKey: "", commandExists: async () => true, claudeBin: "claude" },
      llmApiKey: () => "sk-test",
      openRouterApiKey: () => "or-test",
      tokenRouterApiKey: () => "tr-test",
      createRunner: (name) => ({
        name,
        run: async () => {
          calls.push(name);
          return { status: "succeeded", summary: "OK" };
        },
      }),
    });
    expect(results.map((r) => r.runner)).toEqual(calls);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
