/**
 * Configuration presets for common agent setups.
 * Used by the setup wizard to generate appropriate .env configurations.
 */

export type PresetId = "cursor-only" | "multi-runner" | "minimal" | "enterprise";

export type ConfigPreset = {
  id: PresetId;
  name: string;
  description: string;
  recommended: boolean;
  envVars: Record<string, string>;
  requiredInputs: string[];
  optionalInputs: string[];
};

export const CONFIG_PRESETS: Record<PresetId, ConfigPreset> = {
  "cursor-only": {
    id: "cursor-only",
    name: "Cursor Only",
    description: "Simple setup using only the Cursor SDK. Recommended for most users.",
    recommended: true,
    envVars: {
      IMEMORY_MCP_URL: "https://projectm.dev/api/mcp",
      IMEMORY_DEFAULT_RUNNER: "cursor_sdk",
    },
    requiredInputs: ["IMEMORY_API_KEY", "IMEMORY_WORKSPACE_ALLOWLIST", "CURSOR_API_KEY"],
    optionalInputs: [],
  },
  
  "multi-runner": {
    id: "multi-runner",
    name: "Multi-Runner (Auto Cascade)",
    description: "Use multiple AI assistants with automatic fallback. Best for reliability.",
    recommended: false,
    envVars: {
      IMEMORY_MCP_URL: "https://projectm.dev/api/mcp",
      IMEMORY_DEFAULT_RUNNER: "auto",
    },
    requiredInputs: ["IMEMORY_API_KEY", "IMEMORY_WORKSPACE_ALLOWLIST"],
    optionalInputs: [
      "CURSOR_API_KEY",
      "CODEX_API_KEY",
      "ANTHROPIC_API_KEY",
      "COPILOT_GITHUB_TOKEN",
    ],
  },
  
  "minimal": {
    id: "minimal",
    name: "Minimal (Any LLM API)",
    description: "Use any OpenAI-compatible API endpoint. For advanced users.",
    recommended: false,
    envVars: {
      IMEMORY_MCP_URL: "https://projectm.dev/api/mcp",
      IMEMORY_DEFAULT_RUNNER: "llm_api",
      IMEMORY_LLM_MODEL: "gpt-4o-mini",
      IMEMORY_LLM_BASE_URL: "https://api.openai.com/v1",
    },
    requiredInputs: ["IMEMORY_API_KEY", "IMEMORY_WORKSPACE_ALLOWLIST", "OPENAI_API_KEY"],
    optionalInputs: ["IMEMORY_LLM_MODEL", "IMEMORY_LLM_BASE_URL"],
  },
  
  "enterprise": {
    id: "enterprise",
    name: "Enterprise",
    description: "Custom configuration for enterprise deployments with specific requirements.",
    recommended: false,
    envVars: {
      IMEMORY_DEFAULT_RUNNER: "auto",
    },
    requiredInputs: [
      "IMEMORY_API_KEY",
      "IMEMORY_MCP_URL",
      "IMEMORY_WORKSPACE_ALLOWLIST",
      "IMEMORY_AGENT_KEY",
    ],
    optionalInputs: [
      "IMEMORY_PROJECT_SLUG",
      "IMEMORY_MANAGED_WORKSPACE_ROOT",
      "IMEMORY_DEFAULT_RUNNER",
    ],
  },
};

export function getPresetById(id: string): ConfigPreset | null {
  return CONFIG_PRESETS[id as PresetId] || null;
}

export function getRecommendedPreset(): ConfigPreset {
  return CONFIG_PRESETS["cursor-only"];
}

export function listPresets(): ConfigPreset[] {
  return Object.values(CONFIG_PRESETS);
}

export function generateEnvFromPreset(
  preset: ConfigPreset,
  inputs: Record<string, string>,
): string {
  const lines: string[] = [
    `# ProjectMind Agent Configuration`,
    `# Preset: ${preset.name}`,
    `# ${preset.description}`,
    "",
  ];
  
  // Add required inputs
  for (const key of preset.requiredInputs) {
    const value = inputs[key] || "";
    lines.push(`${key}=${value}`);
  }
  
  lines.push("");
  
  // Add preset-specific env vars
  for (const [key, value] of Object.entries(preset.envVars)) {
    if (!preset.requiredInputs.includes(key)) {
      lines.push(`${key}=${value}`);
    }
  }
  
  // Add optional inputs if provided
  const hasOptional = preset.optionalInputs.some((key) => inputs[key]);
  if (hasOptional) {
    lines.push("");
    lines.push("# Optional configuration");
    for (const key of preset.optionalInputs) {
      if (inputs[key]) {
        lines.push(`${key}=${inputs[key]}`);
      }
    }
  }
  
  lines.push("");
  lines.push("# For more options, see .env.advanced.example");
  lines.push("");
  
  return lines.join("\n");
}

/**
 * Detect which preset best matches the current environment.
 * Useful for suggesting a preset during setup.
 */
export async function detectBestPreset(deps?: {
  hasCursorKey?: boolean;
  hasCursorCli?: boolean;
  hasCodexCli?: boolean;
  hasClaudeCli?: boolean;
  hasCopilotCli?: boolean;
}): Promise<ConfigPreset> {
  const {
    hasCursorKey = !!process.env.CURSOR_API_KEY,
    hasCursorCli = false,
    hasCodexCli = false,
    hasClaudeCli = false,
    hasCopilotCli = false,
  } = deps || {};
  
  // Count how many runners are available
  const runnerCount =
    (hasCursorKey ? 1 : 0) +
    (hasCursorCli ? 1 : 0) +
    (hasCodexCli ? 1 : 0) +
    (hasClaudeCli ? 1 : 0) +
    (hasCopilotCli ? 1 : 0);
  
  // If Cursor key is set and it's the only runner, recommend cursor-only
  if (hasCursorKey && runnerCount === 1) {
    return CONFIG_PRESETS["cursor-only"];
  }
  
  // If multiple runners are available, recommend multi-runner
  if (runnerCount >= 2) {
    return CONFIG_PRESETS["multi-runner"];
  }
  
  // Default to cursor-only as the simplest starting point
  return CONFIG_PRESETS["cursor-only"];
}
