import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { llmUsageKey, loadLlmStats, recordLlmUsage, toLlmUsageMeta } from "./llm-stats.js";
import { recordInvoke, recordRateLimit, resetProviderPacing } from "./provider-pacing.js";

afterEach(() => {
  resetProviderPacing();
});

describe("llm-stats", () => {
  it("builds stable runner/model keys", () => {
    expect(llmUsageKey("cursor_sdk", "composer-2.5")).toBe("cursor_sdk/composer-2.5");
    expect(llmUsageKey("antigravity_cli", "  ")).toBe("antigravity_cli/default");
  });

  it("records and persists per-LLM counts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "imemory-llm-stats-"));
    const filePath = path.join(dir, "usage.json");

    await recordLlmUsage({
      runner: "antigravity_cli",
      model: "Gemini 3.5 Flash (High)",
      filePath,
      now: new Date("2026-07-19T12:00:00.000Z"),
    });
    await recordLlmUsage({
      runner: "antigravity_cli",
      model: "Gemini 3.5 Flash (High)",
      filePath,
      now: new Date("2026-07-19T12:01:00.000Z"),
    });
    await recordLlmUsage({
      runner: "cursor_cli",
      model: null,
      filePath,
      now: new Date("2026-07-19T12:02:00.000Z"),
    });

    const stats = await loadLlmStats(filePath);
    expect(stats.byLlm["antigravity_cli/Gemini 3.5 Flash (High)"]?.count).toBe(2);
    expect(stats.byLlm["cursor_cli/default"]?.count).toBe(1);

    const meta = toLlmUsageMeta(stats);
    expect(meta.byLlm["antigravity_cli/Gemini 3.5 Flash (High)"]).toBe(2);
    expect(meta.byLlm["cursor_cli/default"]).toBe(1);

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("antigravity_cli/Gemini 3.5 Flash (High)");
  });

  it("persists pacing audit fields after rate limits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "imemory-llm-stats-"));
    const filePath = path.join(dir, "usage.json");

    recordInvoke("cursor_sdk", Date.parse("2026-07-19T12:00:00.000Z"));
    recordRateLimit("cursor_sdk", {
      nowMs: Date.parse("2026-07-19T12:00:01.000Z"),
      retryAfterMs: 60_000,
    });

    const stats = await recordLlmUsage({
      runner: "cursor_sdk",
      model: "composer-2.5",
      filePath,
      now: new Date("2026-07-19T12:00:02.000Z"),
    });

    expect(stats.byLlm["cursor_sdk/composer-2.5"]?.rateLimitHits).toBeGreaterThanOrEqual(1);
    expect(stats.byProvider?.cursor_sdk?.rateLimitHits).toBeGreaterThanOrEqual(1);
    expect(stats.byProvider?.cursor_sdk?.cooldownUntil).toBeTruthy();
    expect(stats.pacingEvents?.length).toBeGreaterThan(0);

    const meta = toLlmUsageMeta(stats);
    expect(meta.pacing?.rateLimitHits.cursor_sdk).toBeGreaterThanOrEqual(1);
  });
});
