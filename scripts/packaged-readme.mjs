/**
 * Per-platform README.txt content for desktop agent download zips.
 * Each package gets instructions tailored to that OS and how to run it.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const PRODUCTION_MCP_URL = "https://projectm.dev/api/mcp";
export const LOCAL_MCP_URL = "http://localhost:8080/api/mcp";

const ENV_SETUP_STEPS = `2. Edit the included \`.env\` (sample values + production app URL already filled in):
   - \`IMEMORY_API_KEY\` — project API key from ProjectMind → Settings → API keys
   - \`IMEMORY_MCP_URL\` — already set to \`${PRODUCTION_MCP_URL}\` (use \`${LOCAL_MCP_URL}\` for local)
   - \`IMEMORY_WORKSPACE_ALLOWLIST\` — comma-separated absolute paths the agent may use`;

const MACOS_TRUST_SECTION = `
## macOS: make the agent trusted (Gatekeeper)

Downloads are unsigned, so macOS may show “cannot be opened because it is from an unidentified developer” or block the binary.

1. In Terminal, from this folder:
   \`xattr -dr com.apple.quarantine .\`
   Or double-click \`clear-quarantine.command\` in Finder.
2. If it is still blocked: System Settings → Privacy & Security → Security → Open Anyway, then confirm.
3. Or in Finder: Control-click \`imemory-agent\` → Open → Open.
`;

const WINDOWS_SMARTSCREEN_SECTION = `
## Windows: SmartScreen / “Windows protected your PC”

Unsigned downloads may be blocked by Microsoft Defender SmartScreen.

1. Click **More info**, then **Run anyway** (or Allow on this device).
2. Or right-click \`imemory-agent.exe\` → Properties → check **Unblock** → Apply → OK, then run again.
`;

/**
 * @param {{ id: string, label: string, os: string, arch?: string }} target
 * @param {string} version
 */
export function buildPackagedReadme(target, version) {
  const os = target.os;
  const label = target.label;
  const ver = String(version || "0.0.0");

  if (os === "nodejs") {
    return `# ProjectMind desktop agent (${label})

Version: ${ver}

Requires **Node.js 22.13+** (cross-platform; matches \`@cursor/sdk\`). Supports the \`cursor_sdk\` runner after \`npm install\`.

## How to run (Node.js)

1. Unzip this archive into a folder.
${ENV_SETUP_STEPS}
3. In a terminal in this folder:

\`\`\`
npm install
npm start
\`\`\`

**Important:** use \`npm start\` (not bare \`npm run\`). Bare \`npm run\` only lists scripts and does not start the agent.

On macOS you can also double-click \`start.command\` after editing \`.env\`.

Optional: set \`CURSOR_API_KEY\` in \`.env\` to use the Cursor SDK runner (\`cursor_sdk\` / \`auto\`).

The agent heartbeats to ProjectMind and polls for jobs. Stop with Ctrl+C.

When ProjectMind publishes a newer agent under \`/downloads/agent/\`, this install checks the online manifest and auto-updates (preserves \`.env\`, then restarts). Disable with \`IMEMORY_AGENT_AUTO_UPDATE=0\`.

## Notes

- Prefer this build when you already have Node.js and want \`cursor_sdk\`.
- Native macOS / Windows / Ubuntu zips do not require Node.js (CLI runners only).
- Put \`.env\` next to \`imemory-agent.cjs\` or in the current working directory.
- \`npm install\` may show engine warnings if Node is older than 22.13 — upgrade Node, then reinstall.
`;
  }

  if (os === "macos") {
    return `# ProjectMind desktop agent (${label})

Version: ${ver}

Native macOS binary — **no Node.js required**.

## How to run (macOS)

1. Unzip this archive (e.g. double-click in Finder, or \`unzip\` in Terminal).
${ENV_SETUP_STEPS}
3. Clear Gatekeeper quarantine (recommended before first run):

\`\`\`
xattr -dr com.apple.quarantine .
\`\`\`

   Or double-click \`clear-quarantine.command\` in this folder.
4. Install a runner CLI on PATH when needed (Cursor Agent \`agent\`, Codex \`codex\`, or Antigravity \`agy\`).
5. In Terminal, \`cd\` into this folder and run:

\`\`\`
./imemory-agent
\`\`\`

The agent heartbeats to ProjectMind and polls for jobs. Stop with Ctrl+C.
${MACOS_TRUST_SECTION}
## Notes

- Unsigned zip build (no code signature / notarization yet).
- Built for macOS (${target.arch === "arm64" ? "Apple Silicon" : target.arch === "x64" ? "Intel" : "this Mac"}).
- Auto-updates from ProjectMind \`/downloads/agent/manifest.json\` when a newer version is published (preserves \`.env\`). Disable with \`IMEMORY_AGENT_AUTO_UPDATE=0\`.
- \`cursor_sdk\` runner needs Node + \`@cursor/sdk\` — use the **Node.js** download zip, or a source checkout.
- Packaged native builds use CLI/API runners (\`cursor_cli\`, \`codex_cli\`, \`antigravity_cli\`, \`claude_cli\`, \`copilot_cli\`, \`openrouter\`, \`tokenrouter\`, \`llm_api\`).
- Put \`.env\` next to the executable or in the current working directory.
`;
  }

  if (os === "windows") {
    return `# ProjectMind desktop agent (${label})

Version: ${ver}

Native Windows binary — **no Node.js required**.

## How to run (Windows)

1. Unzip this archive (right-click → Extract All…, or Expand-Archive in PowerShell).
${ENV_SETUP_STEPS}
3. Install a runner CLI on PATH when needed (Cursor Agent \`agent\`, Codex \`codex\`, or Antigravity \`agy\`).
4. Open **Command Prompt** or **PowerShell**, \`cd\` into this folder, and run:

\`\`\`
.\\imemory-agent.exe
\`\`\`

Or double-click \`imemory-agent.exe\` after editing \`.env\` (a console window stays open while the agent runs).

The agent heartbeats to ProjectMind and polls for jobs. Stop with Ctrl+C.
${WINDOWS_SMARTSCREEN_SECTION}
## Notes

- Unsigned zip build (no Authenticode signature yet).
- Built for Windows x64.
- Auto-updates from ProjectMind \`/downloads/agent/manifest.json\` when a newer version is published (preserves \`.env\`). Disable with \`IMEMORY_AGENT_AUTO_UPDATE=0\`.
- \`cursor_sdk\` runner needs Node + \`@cursor/sdk\` — use the **Node.js** download zip, or a source checkout.
- Packaged native builds use CLI/API runners (\`cursor_cli\`, \`codex_cli\`, \`antigravity_cli\`, \`claude_cli\`, \`copilot_cli\`, \`openrouter\`, \`tokenrouter\`, \`llm_api\`).
- Put \`.env\` next to \`imemory-agent.exe\` or in the current working directory.
`;
  }

  if (os === "ubuntu") {
    return `# ProjectMind desktop agent (${label})

Version: ${ver}

Native Linux (glibc) binary — **no Node.js required**. Works on Ubuntu and most desktop Linux distros.

## How to run (Ubuntu / Linux)

1. Unzip this archive:

\`\`\`
unzip imemory-agent-ubuntu-x64.zip -d imemory-agent
cd imemory-agent
\`\`\`

${ENV_SETUP_STEPS}
3. Ensure the binary is executable (zip usually preserves this):

\`\`\`
chmod +x ./imemory-agent
\`\`\`

4. Install a runner CLI on PATH when needed (Cursor Agent \`agent\`, Codex \`codex\`, or Antigravity \`agy\`).
5. Run:

\`\`\`
./imemory-agent
\`\`\`

The agent heartbeats to ProjectMind and polls for jobs. Stop with Ctrl+C.

## Notes

- Unsigned zip build.
- Built for Ubuntu / Linux x64 (glibc). Not for musl-only distros (e.g. Alpine) without extra setup.
- Auto-updates from ProjectMind \`/downloads/agent/manifest.json\` when a newer version is published (preserves \`.env\`). Disable with \`IMEMORY_AGENT_AUTO_UPDATE=0\`.
- \`cursor_sdk\` runner needs Node + \`@cursor/sdk\` — use the **Node.js** download zip, or a source checkout.
- Packaged native builds use CLI/API runners (\`cursor_cli\`, \`codex_cli\`, \`antigravity_cli\`, \`claude_cli\`, \`copilot_cli\`, \`openrouter\`, \`tokenrouter\`, \`llm_api\`).
- Put \`.env\` next to the executable or in the current working directory.
`;
  }

  throw new Error(`Unknown packaged README os: ${os}`);
}

/**
 * Write README.txt (and macOS clear-quarantine helper) into a release stage folder.
 * @param {string} dir
 * @param {{ id: string, label: string, os: string, arch?: string }} target
 * @param {string} version
 * @param {{ writeClearQuarantine?: (dir: string) => Promise<void> }} [opts]
 */
export async function writePackagedReadme(dir, target, version, opts = {}) {
  const body = buildPackagedReadme(target, version);
  await writeFile(join(dir, "README.txt"), body, "utf8");
  if (target.os === "macos" && typeof opts.writeClearQuarantine === "function") {
    await opts.writeClearQuarantine(dir);
  }
  return body;
}

/** Default macOS quarantine helper used by the release build. */
export async function writeClearQuarantineHelper(dir) {
  const body = `#!/bin/bash
# Clears macOS download quarantine so ./imemory-agent can run (unsigned build).
cd "$(dirname "$0")" || exit 1
if ! command -v xattr >/dev/null 2>&1; then
  echo "xattr not found; use System Settings → Privacy & Security → Open Anyway instead."
  exit 1
fi
xattr -dr com.apple.quarantine .
echo "Quarantine cleared. You can run: ./imemory-agent"
`;
  const path = join(dir, "clear-quarantine.command");
  await writeFile(path, body, "utf8");
  const chmod = spawnSync("chmod", ["+x", path], { encoding: "utf8" });
  if (chmod.status !== 0) {
    throw new Error(`chmod failed for clear-quarantine.command: ${chmod.stderr || chmod.status}`);
  }
}
