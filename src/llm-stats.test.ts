import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("returns an empty store for a missing, corrupt, or non-object file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "imemory-llm-stats-"));
    expect((await loadLlmStats(path.join(dir, "missing.json"))).byLlm).toEqual({});

    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{", "utf8");
    expect((await loadLlmStats(bad)).byLlm).toEqual({});

    const arrayFile = path.join(dir, "array.json");
    await writeFile(arrayFile, JSON.stringify({ byLlm: [], updatedAt: "x" }), "utf8");
    expect((await loadLlmStats(arrayFile)).byLlm).toEqual({});
  });

  it("floors a legacy numeric count and keeps accumulating across months", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "imemory-llm-stats-"));
    const filePath = path.join(dir, "usage.json");
    await writeFile(
      filePath,
      JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", byLlm: { "cursor_cli/default": 1.9 } }),
      "utf8",
    );
    const january = await recordLlmUsage({
      runner: "cursor_cli",
      model: null,
      filePath,
      now: new Date("2026-01-31T23:00:00.000Z"),
      syncPacing: false,
    });
    expect(january.byLlm["cursor_cli/default"]?.count).toBe(2);

    const february = await recordLlmUsage({
      runner: "cursor_cli",
      model: null,
      filePath,
      now: new Date("2026-02-01T00:30:00.000Z"),
      syncPacing: false,
    });
    expect(february.byLlm["cursor_cli/default"]?.count).toBe(3);
    expect(february.byLlm["cursor_cli/default"]?.lastUsedAt).toBe("2026-02-01T00:30:00.000Z");
  });

  it("folds deprecated Grok 4.6 and Opus 4.5 usage onto current model ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "imemory-llm-stats-"));
    const filePath = path.join(dir, "usage.json");
    await writeFile(
      filePath,
      JSON.stringify({
        updatedAt: "2026-10-15T00:00:00.000Z",
        byLlm: {
          "cursor_cli/cursor-grok-4.6-high": {
            count: 504,
            lastUsedAt: "2026-10-15T16:54:31.962Z",
          },
          "cursor_cli/claude-opus-4-5": {
            count: 138,
            lastUsedAt: "2026-08-20T16:09:53.588Z",
          },
          "cursor_cli/grok-4.7-high": {
            count: 2,
            lastUsedAt: "2026-11-01T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    const stats = await loadLlmStats(filePath);
    expect(stats.byLlm["cursor_cli/cursor-grok-4.6-high"]).toBeUndefined();
    expect(stats.byLlm["cursor_cli/claude-opus-4-5"]).toBeUndefined();
    expect(stats.byLlm["cursor_cli/grok-4.7-high"]?.count).toBe(506);
    expect(stats.byLlm["cursor_cli/claude-opus-5-5-high"]?.count).toBe(138);

    const meta = toLlmUsageMeta(stats);
    expect(meta.byLlm["cursor_cli/grok-4.7-high"]).toBe(506);
    expect(meta.byLlm["cursor_cli/claude-opus-5-5-high"]).toBe(138);

    const recorded = await recordLlmUsage({
      runner: "cursor_cli",
      model: "cursor-grok-4.6-high-fast",
      filePath,
      now: new Date("2026-11-14T00:00:00.000Z"),
      syncPacing: false,
    });
    expect(recorded.byLlm["cursor_cli/grok-4.7-high-fast"]?.count).toBe(1);
    expect(recorded.byLlm["cursor_cli/cursor-grok-4.6-high-fast"]).toBeUndefined();
  });

  it("omits pacing metadata when nothing has been recorded", () => {
    resetProviderPacing();
    const meta = toLlmUsageMeta({ updatedAt: new Date(0).toISOString(), byLlm: {} });
    expect(meta.byLlm).toEqual({});
    expect(meta.pacing).toBeUndefined();
  });
});
