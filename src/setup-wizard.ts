import { createInterface } from "node:readline";
import { writeFile, access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve, dirname } from "node:path";
import { stdin, stdout } from "node:process";
import {
  commandExists,
  cursorApiKey,
  cursorCliBin,
  codexCliBin,
  antigravityCliBin,
  claudeCliBin,
  copilotCliBin,
  codexApiKey,
  claudeApiKey,
  copilotApiKey,
  type AutoRunnerName,
} from "./runners/resolve.js";
import { parseAllowlist } from "./safety.js";
import { normalizeMcpBaseUrl } from "./machine.js";
import { envFileHasImemoryApiKey, isImemoryApiKey } from "./api-key.js";

const PRODUCTION_MCP_URL = "https://projectm.dev/api/mcp";
const LOCAL_MCP_URL = "http://localhost:8080/api/mcp";

export type SetupWizardResult = {
  success: boolean;
  envPath: string;
  config?: {
    apiKey: string;
    mcpUrl: string;
    workspaceAllowlist: string[];
    runner?: AutoRunnerName;
  };
};

type RunnerAvailability = {
  runner: AutoRunnerName;
  available: boolean;
  reason: string;
};

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = await prompt(`${question}${suffix}`);
  
  if (!answer) return defaultYes;
  const normalized = answer.toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function detectAvailableRunners(): Promise<RunnerAvailability[]> {
  const results: RunnerAvailability[] = [];
  
  // cursor_sdk - requires CURSOR_API_KEY
  const cursorKey = cursorApiKey();
  if (cursorKey) {
    results.push({
      runner: "cursor_sdk",
      available: true,
      reason: "CURSOR_API_KEY found in environment",
    });
  } else {
    results.push({
      runner: "cursor_sdk",
      available: false,
      reason: "CURSOR_API_KEY not set",
    });
  }
  
  // cursor_cli - requires agent binary
  const cursorBin = cursorCliBin();
  const cursorCliExists = await commandExists(cursorBin);
  if (cursorCliExists) {
    results.push({
      runner: "cursor_cli",
      available: true,
      reason: `Found ${cursorBin} on PATH`,
    });
  } else {
    results.push({
      runner: "cursor_cli",
      available: false,
      reason: `${cursorBin} not found on PATH`,
    });
  }
  
  // codex_cli - requires codex binary
  const codexBin = codexCliBin();
  const codexExists = await commandExists(codexBin);
  if (codexExists) {
    results.push({
      runner: "codex_cli",
      available: true,
      reason: `Found ${codexBin} on PATH`,
    });
  } else {
    results.push({
      runner: "codex_cli",
      available: false,
      reason: `${codexBin} not found on PATH`,
    });
  }
  
  // antigravity_cli - requires agy binary
  const agyBin = antigravityCliBin();
  const agyExists = await commandExists(agyBin);
  if (agyExists) {
    results.push({
      runner: "antigravity_cli",
      available: true,
      reason: `Found ${agyBin} on PATH`,
    });
  } else {
    results.push({
      runner: "antigravity_cli",
      available: false,
      reason: `${agyBin} not found on PATH`,
    });
  }
  
  // claude_cli - requires claude binary
  const claudeBin = claudeCliBin();
  const claudeExists = await commandExists(claudeBin);
  if (claudeExists) {
    results.push({
      runner: "claude_cli",
      available: true,
      reason: `Found ${claudeBin} on PATH`,
    });
  } else {
    results.push({
      runner: "claude_cli",
      available: false,
      reason: `${claudeBin} not found on PATH`,
    });
  }
  
  // copilot_cli - requires copilot binary
  const copilotBin = copilotCliBin();
  const copilotExists = await commandExists(copilotBin);
  if (copilotExists) {
    results.push({
      runner: "copilot_cli",
      available: true,
      reason: `Found ${copilotBin} on PATH`,
    });
  } else {
    results.push({
      runner: "copilot_cli",
      available: false,
      reason: `${copilotBin} not found on PATH`,
    });
  }
  
  return results;
}

async function testMcpConnectivity(mcpUrl: string): Promise<boolean> {
  try {
    const url = new URL(normalizeMcpBaseUrl(mcpUrl));
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok || response.status === 400; // 400 might mean auth required, which is OK
  } catch {
    return false;
  }
}

function validateAllowlistPaths(paths: string[]): { valid: boolean; reason?: string } {
  if (paths.length === 0) {
    return { valid: false, reason: "At least one workspace path is required" };
  }
  
  for (const path of paths) {
    if (!path.trim()) {
      return { valid: false, reason: "Workspace paths cannot be empty" };
    }
    if (!resolve(path)) {
      return { valid: false, reason: `Invalid path: ${path}` };
    }
  }
  
  return { valid: true };
}

function generateEnvContent(config: {
  apiKey: string;
  mcpUrl: string;
  workspaceAllowlist: string[];
  cursorApiKey?: string;
  runner?: AutoRunnerName;
}): string {
  const lines: string[] = [
    "# ProjectMind Agent Configuration",
    "# Generated by setup wizard",
    "",
    "# Project API key from ProjectMind → Project → Settings → API keys",
    `IMEMORY_API_KEY=${config.apiKey}`,
    "",
    "# ProjectMind MCP endpoint",
    `IMEMORY_MCP_URL=${config.mcpUrl}`,
    "",
    "# Workspace allowlist - comma-separated absolute paths",
    `IMEMORY_WORKSPACE_ALLOWLIST=${config.workspaceAllowlist.join(",")}`,
    "",
  ];
  
  if (config.cursorApiKey) {
    lines.push("# Cursor SDK API key (for cursor_sdk runner)");
    lines.push(`CURSOR_API_KEY=${config.cursorApiKey}`);
    lines.push("");
  }
  
  if (config.runner && config.runner !== "cursor_sdk") {
    lines.push("# Default runner (auto will cascade through available runners)");
    lines.push(`IMEMORY_DEFAULT_RUNNER=${config.runner}`);
    lines.push("");
  }
  
  lines.push("# For more configuration options, see .env.example");
  lines.push("");
  
  return lines.join("\n");
}

export async function runSetupWizard(envPath: string): Promise<SetupWizardResult> {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║       ProjectMind Agent - Setup Wizard                   ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  
  console.log("This wizard will help you configure the ProjectMind agent.\n");
  
  // Step 1: API Key
  console.log("Step 1/4: ProjectMind API Key");
  console.log("Prefer browser login (no paste): run 'projectmind-agent login' in another terminal,");
  console.log("or paste a key from ProjectMind → Project → Settings → API keys.\n");

  const useBrowser = await promptYesNo("Use browser login now?", true);
  let apiKey = "";
  if (useBrowser) {
    const { runDeviceLogin } = await import("./device-login.js");
    const login = await runDeviceLogin({ envPath });
    if (!login.success || !login.apiKey) {
      return { success: false, envPath };
    }
    apiKey = login.apiKey;
  } else {
    apiKey = await prompt("Enter your ProjectMind API key");
    if (!isImemoryApiKey(apiKey)) {
      console.log("\n❌ Invalid API key. Keys should start with imk_, imgk_, or imbk_");
      return { success: false, envPath };
    }
  }
  
  // Step 2: MCP URL
  console.log("\nStep 2/4: MCP URL");
  console.log("Use the production URL unless you're running ProjectMind locally.\n");
  
  const useProduction = await promptYesNo("Use production URL (https://projectm.dev)?", true);
  const mcpUrl = useProduction ? PRODUCTION_MCP_URL : await prompt("Enter MCP URL", LOCAL_MCP_URL);
  
  console.log("\nTesting MCP connectivity...");
  const connected = await testMcpConnectivity(mcpUrl);
  if (!connected) {
    console.log("⚠️  Warning: Could not connect to MCP URL. You can continue, but verify the URL is correct.");
    const continueAnyway = await promptYesNo("Continue anyway?", true);
    if (!continueAnyway) {
      return { success: false, envPath };
    }
  } else {
    console.log("✓ MCP connection successful");
  }
  
  // Step 3: Workspace Allowlist
  console.log("\nStep 3/4: Workspace Allowlist");
  console.log("Specify directories where the agent is allowed to work.");
  console.log("You can add multiple paths separated by commas.\n");
  
  const cwd = process.cwd();
  const allowlistInput = await prompt("Enter workspace paths (comma-separated)", cwd);
  const workspaceAllowlist = allowlistInput
    .split(",")
    .map(p => resolve(p.trim()))
    .filter(Boolean);
  
  const allowlistValidation = validateAllowlistPaths(workspaceAllowlist);
  if (!allowlistValidation.valid) {
    console.log(`\n❌ ${allowlistValidation.reason}`);
    return { success: false, envPath };
  }
  
  console.log("\nWorkspace paths configured:");
  workspaceAllowlist.forEach(p => console.log(`  • ${p}`));
  
  // Step 4: Runner Detection
  console.log("\nStep 4/4: Runner Detection");
  console.log("Detecting available AI coding assistants...\n");
  
  const runners = await detectAvailableRunners();
  const available = runners.filter(r => r.available);
  const unavailable = runners.filter(r => !r.available);
  
  if (available.length > 0) {
    console.log("✓ Available runners:");
    available.forEach(r => console.log(`  • ${r.runner} - ${r.reason}`));
  }
  
  if (unavailable.length > 0) {
    console.log("\n✗ Unavailable runners:");
    unavailable.forEach(r => console.log(`  • ${r.runner} - ${r.reason}`));
  }
  
  let cursorApiKeyInput: string | undefined;
  let selectedRunner: AutoRunnerName | undefined;
  
  if (available.length === 0) {
    console.log("\n⚠️  No runners are currently available.");
    console.log("You can still configure the agent and add runners later.");
    
    const addCursorKey = await promptYesNo("\nWould you like to add a CURSOR_API_KEY now?", true);
    if (addCursorKey) {
      cursorApiKeyInput = await prompt("Enter your Cursor API key");
      if (cursorApiKeyInput && cursorApiKeyInput.trim()) {
        selectedRunner = "cursor_sdk";
        console.log("✓ Cursor SDK will be used");
      }
    }
  } else {
    console.log("\nThe agent will automatically use available runners (auto mode).");
    
    const customize = await promptYesNo("Would you like to select a specific runner?", false);
    if (customize && available.length > 0) {
      console.log("\nAvailable runners:");
      available.forEach((r, i) => console.log(`  ${i + 1}. ${r.runner}`));
      
      const selection = await prompt(`Select runner (1-${available.length})`, "1");
      const index = parseInt(selection, 10) - 1;
      if (index >= 0 && index < available.length) {
        selectedRunner = available[index].runner;
        console.log(`✓ ${selectedRunner} selected`);
      }
    }
    
    // Offer to add CURSOR_API_KEY if not present
    if (!cursorApiKey()) {
      const addCursorKey = await promptYesNo("\nWould you like to add a CURSOR_API_KEY for the Cursor SDK runner?", false);
      if (addCursorKey) {
        cursorApiKeyInput = await prompt("Enter your Cursor API key");
      }
    }
  }
  
  // Generate and save configuration
  console.log("\n\nGenerating configuration...");
  
  const envContent = generateEnvContent({
    apiKey,
    mcpUrl,
    workspaceAllowlist,
    cursorApiKey: cursorApiKeyInput,
    runner: selectedRunner,
  });
  
  try {
    await writeFile(envPath, envContent, "utf8");
    console.log(`✓ Configuration saved to: ${envPath}`);
  } catch (err) {
    console.log(`\n❌ Failed to write configuration: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, envPath };
  }
  
  // Summary
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║       Setup Complete!                                     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  
  console.log("Configuration summary:");
  console.log(`  • API Key: ${apiKey.substring(0, 12)}...`);
  console.log(`  • MCP URL: ${mcpUrl}`);
  console.log(`  • Workspaces: ${workspaceAllowlist.length} path(s)`);
  console.log(`  • Runner: ${selectedRunner || "auto (cascade)"}`);
  
  if (available.length === 0 && !cursorApiKeyInput) {
    console.log("\n⚠️  No runners are configured. To run jobs, install one of:");
    console.log("  • Cursor Agent CLI: https://cursor.com");
    console.log("  • Codex CLI: npm i -g @openai/codex");
    console.log("  • Claude CLI: https://code.claude.com");
    console.log("  • Or set CURSOR_API_KEY for the Cursor SDK runner");
  }
  
  console.log("\nTo start the agent, run:");
  console.log("  projectmind-agent");
  console.log("\nFor diagnostics, run:");
  console.log("  projectmind-agent doctor\n");
  
  return {
    success: true,
    envPath,
    config: {
      apiKey,
      mcpUrl,
      workspaceAllowlist,
      runner: selectedRunner,
    },
  };
}

export async function shouldRunSetupWizard(envPath: string): Promise<boolean> {
  // Key may already be loaded from another .env location (next to binary, shell, etc.).
  // Browser pairing defaults to imgk_; project keys use imk_; buckets use imbk_.
  if (isImemoryApiKey(process.env.IMEMORY_API_KEY) || isImemoryApiKey(process.env.MCP_API_KEY)) {
    return false;
  }

  try {
    await access(envPath, fsConstants.R_OK);
    const content = await readFile(envPath, "utf8");
    // API key is enough to start. Allowlist is optional when managed workspaces
    // (~/.imemory/workspaces) are in use; doctor can still warn about it.
    return !envFileHasImemoryApiKey(content);
  } catch {
    // .env doesn't exist
    return true;
  }
}
