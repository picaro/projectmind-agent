import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { runSetupWizard } from "./setup-wizard.js";
import { runHealthCheck, type ModelHealthResult } from "./health-check.js";
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
  resolveAutoRunnerChainWithDiagnostics,
  formatRunnerDiagnostics,
  type AutoRunnerName,
} from "./runners/resolve.js";
import { parseAllowlist, effectiveAllowlist } from "./safety.js";
import { normalizeMcpBaseUrl } from "./machine.js";
import { envFileHasImemoryApiKey } from "./api-key.js";
import { existsSync } from "node:fs";

type DiagnosticIssue = {
  category: "error" | "warning" | "info";
  message: string;
  fix?: string;
};

async function checkEnvFile(envPath: string): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];
  
  try {
    await access(envPath, fsConstants.R_OK);
  } catch {
    issues.push({
      category: "error",
      message: `.env file not found at ${envPath}`,
      fix: "Run 'projectmind-agent setup' to create configuration",
    });
    return issues;
  }
  
  const content = await readFile(envPath, "utf8");
  
  // Check for API key (imk_ / imgk_ from browser login / imbk_)
  if (!envFileHasImemoryApiKey(content)) {
    issues.push({
      category: "error",
      message: "IMEMORY_API_KEY is missing or invalid",
      fix: "Run 'projectmind-agent login' or paste a key (imk_/imgk_/imbk_) from ProjectMind settings",
    });
  }
  
  // Check for MCP URL
  const mcpUrlMatch = content.match(/IMEMORY_MCP_URL\s*=\s*(.+)/);
  if (!mcpUrlMatch) {
    issues.push({
      category: "warning",
      message: "IMEMORY_MCP_URL not set, will use default",
      fix: "Set IMEMORY_MCP_URL=https://projectm.dev/api/mcp in .env",
    });
  }
  
  // Allowlist is optional when managed workspaces are available.
  const allowlistMatch = content.match(/IMEMORY_WORKSPACE_ALLOWLIST\s*=\s*(.+)/);
  if (!allowlistMatch || !allowlistMatch[1].trim()) {
    issues.push({
      category: "warning",
      message: "IMEMORY_WORKSPACE_ALLOWLIST is not configured",
      fix: "Optional if using managed workspaces (~/.imemory/workspaces). Otherwise set comma-separated workspace paths in .env",
    });
  } else {
    const paths = parseAllowlist(allowlistMatch[1]);
    for (const path of paths) {
      if (!existsSync(path)) {
        issues.push({
          category: "warning",
          message: `Workspace path does not exist: ${path}`,
          fix: `Create the directory: mkdir -p "${path}"`,
        });
      }
    }
  }
  
  return issues;
}

async function checkMcpConnectivity(mcpUrl?: string): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];
  const url = mcpUrl || process.env.IMEMORY_MCP_URL || "http://localhost:8080/api/mcp";
  
  try {
    const normalized = new URL(normalizeMcpBaseUrl(url));
    const response = await fetch(normalized.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok && response.status !== 400) {
      issues.push({
        category: "warning",
        message: `MCP endpoint returned status ${response.status}`,
        fix: "Verify the MCP URL is correct and the ProjectMind service is running",
      });
    }
  } catch (err) {
    issues.push({
      category: "error",
      message: `Cannot connect to MCP endpoint: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Check your network connection and verify IMEMORY_MCP_URL is correct",
    });
  }
  
  return issues;
}

async function checkRunners(): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];
  const { chain, diagnostics } = await resolveAutoRunnerChainWithDiagnostics();
  
  const available = diagnostics.filter(d => d.available);
  const unavailable = diagnostics.filter(d => !d.available);
  
  if (available.length === 0) {
    issues.push({
      category: "error",
      message: "No runners are available",
      fix: "Install at least one CLI tool or set an API key:\n" +
        "  • Cursor SDK: Set CURSOR_API_KEY in .env\n" +
        "  • Cursor CLI: Install from https://cursor.com\n" +
        "  • Codex CLI: npm i -g @openai/codex\n" +
        "  • Claude CLI: Install from https://code.claude.com\n" +
        "  • Antigravity CLI: Install from https://antigravity.google\n" +
        "  • Copilot CLI: Install from https://docs.github.com/copilot",
    });
  } else {
    issues.push({
      category: "info",
      message: `✓ ${available.length} runner(s) available: ${available.map(d => d.runner).join(", ")}`,
    });
  }
  
  // Give specific help for each unavailable runner
  for (const diag of unavailable) {
    let fix = "";
    switch (diag.runner) {
      case "cursor_sdk":
        fix = "Set CURSOR_API_KEY in .env to enable Cursor SDK runner";
        break;
      case "cursor_cli":
        fix = `Install Cursor Agent CLI from https://cursor.com (looking for '${cursorCliBin()}' on PATH)`;
        break;
      case "codex_cli":
        fix = `Install Codex CLI: npm i -g @openai/codex (looking for '${codexCliBin()}' on PATH)`;
        break;
      case "antigravity_cli":
        fix = `Install Antigravity CLI from https://antigravity.google (looking for '${antigravityCliBin()}' on PATH)`;
        break;
      case "claude_cli":
        fix = `Install Claude CLI from https://code.claude.com (looking for '${claudeCliBin()}' on PATH)`;
        break;
      case "copilot_cli":
        fix = `Install Copilot CLI from https://docs.github.com/copilot (looking for '${copilotCliBin()}' on PATH)`;
        break;
      case "openrouter":
        fix = "Set OPENROUTER_API_KEY in .env to enable OpenRouter runner";
        break;
      case "tokenrouter":
        fix = "Set TOKENROUTER_API_KEY in .env to enable TokenRouter runner";
        break;
    }
    
    issues.push({
      category: "info",
      message: `✗ ${diag.runner} not available`,
      fix,
    });
  }
  
  return issues;
}

export async function runDoctorCommand(envPath: string): Promise<number> {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║       ProjectMind Agent - Diagnostics                    ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  
  console.log("Running diagnostics...\n");
  
  const allIssues: DiagnosticIssue[] = [];
  
  // Check 1: .env file
  console.log("→ Checking configuration file...");
  const envIssues = await checkEnvFile(envPath);
  allIssues.push(...envIssues);
  
  if (envIssues.length === 0) {
    console.log("  ✓ Configuration file is valid\n");
  } else {
    envIssues.forEach(issue => {
      const icon = issue.category === "error" ? "✗" : issue.category === "warning" ? "⚠" : "ℹ";
      console.log(`  ${icon} ${issue.message}`);
      if (issue.fix) console.log(`    Fix: ${issue.fix}`);
    });
    console.log();
  }
  
  // Check 2: MCP connectivity
  if (envIssues.every(i => i.category !== "error")) {
    console.log("→ Checking MCP connectivity...");
    const mcpIssues = await checkMcpConnectivity();
    allIssues.push(...mcpIssues);
    
    if (mcpIssues.length === 0) {
      console.log("  ✓ MCP connection successful\n");
    } else {
      mcpIssues.forEach(issue => {
        const icon = issue.category === "error" ? "✗" : issue.category === "warning" ? "⚠" : "ℹ";
        console.log(`  ${icon} ${issue.message}`);
        if (issue.fix) console.log(`    Fix: ${issue.fix}`);
      });
      console.log();
    }
  }
  
  // Check 3: Workspace allowlist
  console.log("→ Checking workspace allowlist...");
  const allowlist = effectiveAllowlist();
  if (allowlist.length === 0) {
    console.log("  ⚠ No workspace paths configured (managed workspaces may still work once cloned)");
    allIssues.push({
      category: "warning",
      message: "No workspace paths configured",
      fix: "Optional with managed workspaces. Or set IMEMORY_WORKSPACE_ALLOWLIST in .env",
    });
  } else {
    console.log(`  ✓ ${allowlist.length} workspace path(s) configured:`);
    allowlist.forEach(path => {
      const exists = existsSync(path);
      const status = exists ? "✓" : "✗";
      console.log(`    ${status} ${path}`);
      if (!exists) {
        allIssues.push({
          category: "warning",
          message: `Workspace path does not exist: ${path}`,
          fix: `Create it: mkdir -p "${path}"`,
        });
      }
    });
  }
  console.log();
  
  // Check 4: Runners
  console.log("→ Checking available runners...");
  const runnerIssues = await checkRunners();
  allIssues.push(...runnerIssues);
  
  runnerIssues.forEach(issue => {
    const icon = issue.category === "error" ? "✗" : issue.category === "warning" ? "⚠" : " ";
    console.log(`  ${icon} ${issue.message}`);
    if (issue.fix && issue.category !== "info") {
      issue.fix.split("\n").forEach(line => console.log(`    ${line}`));
    }
  });
  console.log();
  
  // Summary
  const errors = allIssues.filter(i => i.category === "error");
  const warnings = allIssues.filter(i => i.category === "warning");
  
  console.log("═══════════════════════════════════════════════════════════");
  console.log("Summary:");
  console.log(`  Errors: ${errors.length}`);
  console.log(`  Warnings: ${warnings.length}`);
  
  if (errors.length === 0 && warnings.length === 0) {
    console.log("\n✓ All checks passed! The agent is ready to run.");
    console.log("\nTo start the agent:");
    console.log("  projectmind-agent\n");
    return 0;
  } else if (errors.length > 0) {
    console.log("\n✗ Critical issues found. Fix errors before running the agent.");
    console.log("\nTo reconfigure:");
    console.log("  projectmind-agent setup\n");
    return 1;
  } else {
    console.log("\n⚠  Some warnings found. The agent may run, but some features might not work.");
    console.log("\nTo start anyway:");
    console.log("  projectmind-agent\n");
    return 0;
  }
}

export async function runTestCommand(): Promise<number> {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║       ProjectMind Agent - Health Check                   ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  
  console.log("Testing all configured runners...\n");
  console.log("This may take a minute as each runner is tested sequentially.\n");
  
  const results = await runHealthCheck();
  
  if (results.length === 0) {
    console.log("✗ No runners are configured for testing.");
    console.log("\nRun 'projectmind-agent doctor' to see what's missing.\n");
    return 1;
  }
  
  const passed = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  
  console.log("Results:");
  console.log("─────────────────────────────────────────────────────────\n");
  
  passed.forEach(r => {
    const durationSec = (r.durationMs / 1000).toFixed(2);
    const model = r.model ? ` (${r.model})` : "";
    console.log(`✓ ${r.runner}${model}`);
    console.log(`  Response time: ${durationSec}s\n`);
  });
  
  failed.forEach(r => {
    const durationSec = (r.durationMs / 1000).toFixed(2);
    console.log(`✗ ${r.runner}`);
    console.log(`  Error: ${r.error}`);
    console.log(`  Duration: ${durationSec}s\n`);
  });
  
  console.log("─────────────────────────────────────────────────────────");
  console.log(`Summary: ${passed.length} passed, ${failed.length} failed\n`);
  
  if (passed.length === 0) {
    console.log("✗ All runners failed. Check your configuration and API keys.");
    console.log("\nRun 'projectmind-agent doctor' for detailed diagnostics.\n");
    return 1;
  }
  
  return 0;
}

export async function runRunnersCommand(): Promise<number> {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║       ProjectMind Agent - Available Runners              ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  
  const { chain, diagnostics } = await resolveAutoRunnerChainWithDiagnostics();
  
  console.log("Auto-cascade order:");
  if (chain.length > 0) {
    chain.forEach((runner, i) => {
      console.log(`  ${i + 1}. ${runner}`);
    });
  } else {
    console.log("  (none available)");
  }
  
  console.log("\nDetailed status:");
  console.log("─────────────────────────────────────────────────────────\n");
  
  for (const diag of diagnostics) {
    const status = diag.available ? "✓ Available" : "✗ Not available";
    console.log(`${diag.runner}`);
    console.log(`  Status: ${status}`);
    console.log(`  ${diag.available ? "Ready" : "Reason"}: ${diag.reason}\n`);
  }
  
  const available = diagnostics.filter(d => d.available);
  if (available.length === 0) {
    console.log("No runners are currently available.");
    console.log("\nRun 'projectmind-agent doctor' to see how to enable them.\n");
  }
  
  return 0;
}

export async function runSetupCommand(envPath: string): Promise<number> {
  const result = await runSetupWizard(envPath);
  return result.success ? 0 : 1;
}

export async function runLoginCommand(envPath: string, args: string[] = []): Promise<number> {
  let mcpUrl = process.env.IMEMORY_MCP_URL?.trim() || "";
  let appOrigin = process.env.IMEMORY_APP_ORIGIN?.trim() || "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--mcp-url") mcpUrl = args[++i]?.trim() || mcpUrl;
    else if (args[i] === "--app-origin") appOrigin = args[++i]?.trim() || appOrigin;
  }
  const { runDeviceLogin } = await import("./device-login.js");
  const result = await runDeviceLogin({
    envPath,
    mcpUrl: mcpUrl || undefined,
    appOrigin: appOrigin || undefined,
  });
  return result.success ? 0 : 1;
}

export type CliCommand = "setup" | "login" | "doctor" | "test" | "runners" | "help" | "version";

export function parseCliCommand(args: string[]): { command: CliCommand | null; args: string[] } {
  if (args.length === 0) {
    return { command: null, args: [] };
  }
  
  const first = args[0].toLowerCase();
  
  if (["setup", "login", "doctor", "test", "runners", "help", "version"].includes(first)) {
    return { command: first as CliCommand, args: args.slice(1) };
  }
  
  return { command: null, args };
}

export function showHelp(version: string): void {
  console.log(`
ProjectMind Agent v${version}

Usage: projectmind-agent [command]

Commands:
  login       Browser pairing — mint API key without pasting
  setup       Run interactive setup wizard
  doctor      Run diagnostics and check configuration
  test        Test all configured runners
  runners     List available runners
  help        Show this help message
  version     Show version information
  
  (no command)  Start the agent (heartbeat and job polling)

Examples:
  projectmind-agent              # Start the agent
  projectmind-agent login        # Connect with browser (recommended)
  projectmind-agent setup        # Configure allowlist / runners
  projectmind-agent doctor       # Check for issues
  projectmind-agent test         # Test all runners

For more information: https://github.com/projectmind/projectmind-agent
`);
}

export function showVersion(version: string, buildDate: string | null): void {
  console.log(`ProjectMind Agent v${version}`);
  if (buildDate) {
    console.log(`Build date: ${buildDate}`);
  }
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
}
