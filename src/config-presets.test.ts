import { describe, expect, it } from "vitest";
import {
  detectBestPreset,
  generateEnvFromPreset,
  getPresetById,
  getRecommendedPreset,
  listPresets,
} from "./config-presets.js";

describe("config presets", () => {
  it("returns null for an unknown id and recommends cursor-only", () => {
    expect(getPresetById("nope")).toBeNull();
    expect(getPresetById("cursor-only")?.id).toBe("cursor-only");
    expect(getRecommendedPreset().id).toBe("cursor-only");
    expect(listPresets().map((preset) => preset.id)).toEqual([
      "cursor-only",
      "multi-runner",
      "minimal",
      "enterprise",
    ]);
  });

  it("writes empty required keys and skips blank optional keys", () => {
    const preset = getPresetById("cursor-only");
    expect(preset).not.toBeNull();
    const env = generateEnvFromPreset(preset!, {
      IMEMORY_API_KEY: "imk_a=b",
      IMEMORY_WORKSPACE_ALLOWLIST: "",
    });
    expect(env).toContain("IMEMORY_API_KEY=imk_a=b");
    expect(env).toContain("IMEMORY_WORKSPACE_ALLOWLIST=");
    expect(env).toContain("CURSOR_API_KEY=");
    expect(env).not.toContain("Optional configuration");
    expect(env.split("\n").filter((line) => line.startsWith("IMEMORY_MCP_URL="))).toHaveLength(1);
  });

  it("keeps a newline inside a value and can emit an optional key twice", () => {
    const preset = getPresetById("minimal");
    expect(preset).not.toBeNull();
    const env = generateEnvFromPreset(preset!, {
      IMEMORY_API_KEY: "imk_line\nbreak",
      IMEMORY_WORKSPACE_ALLOWLIST: "/tmp/ws",
      OPENAI_API_KEY: "sk",
      IMEMORY_LLM_MODEL: "custom-model",
    });
    expect(env).toContain("IMEMORY_API_KEY=imk_line\nbreak");
    expect(env).toContain("IMEMORY_LLM_MODEL=gpt-4o-mini");
    expect(env).toContain("IMEMORY_LLM_MODEL=custom-model");
  });

  it("picks cursor-only for a single Cursor key and multi-runner when several exist", async () => {
    await expect(
      detectBestPreset({
        hasCursorKey: true,
        hasCursorCli: false,
        hasCodexCli: false,
        hasClaudeCli: false,
        hasCopilotCli: false,
      }),
    ).resolves.toMatchObject({ id: "cursor-only" });

    await expect(
      detectBestPreset({
        hasCursorKey: true,
        hasCursorCli: true,
        hasCodexCli: false,
        hasClaudeCli: false,
        hasCopilotCli: false,
      }),
    ).resolves.toMatchObject({ id: "multi-runner" });

    await expect(
      detectBestPreset({
        hasCursorKey: false,
        hasCursorCli: false,
        hasCodexCli: false,
        hasClaudeCli: false,
        hasCopilotCli: false,
      }),
    ).resolves.toMatchObject({ id: "cursor-only" });

    await expect(
      detectBestPreset({
        hasCursorKey: false,
        hasCursorCli: true,
        hasCodexCli: true,
        hasClaudeCli: false,
        hasCopilotCli: false,
      }),
    ).resolves.toMatchObject({ id: "multi-runner" });
  });
});
