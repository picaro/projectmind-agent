/**
 * package.json (+ optional macOS start helper) for the Node.js agent zip.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Matches @cursor/sdk engines; Node.js zip needs this for cursor_sdk. */
export const NODEJS_AGENT_ENGINES = { node: ">=22.13" };

/**
 * Pin undici above the GHSA range pulled in by @cursor/sdk → @connectrpc/connect-node.
 * Without this, `npm install` prints "Run `npm audit` for details" and looks broken.
 */
export const NODEJS_AGENT_OVERRIDES = {
  undici: "6.27.0",
};

export const POSTINSTALL_HINT = `
✓ ProjectMind agent dependencies installed.

Start the agent with:

  npm start

(not bare \`npm run\` — that only lists scripts and does not start anything)

Requires Node.js 22.13+. Edit \`.env\` first (API key + workspace allowlist).
`.trim();

export const POSTINSTALL_HINT_FILENAME = "postinstall-hint.cjs";

/**
 * @param {string} version
 * @param {string} cursorSdkRange
 */
export function buildNodejsPackageJson(version, cursorSdkRange) {
  return {
    name: "projectmind-agent",
    version: String(version || "0.0.0"),
    private: true,
    description: "ProjectMind desktop agent (Node.js) — heartbeat + claim/run task jobs",
    type: "commonjs",
    main: "./projectmind-agent.cjs",
    bin: {
      "projectmind-agent": "./projectmind-agent.cjs",
      "imemory-agent": "./projectmind-agent.cjs"
    },
    scripts: {
      start: "node ./projectmind-agent.cjs",
      postinstall: `node ./${POSTINSTALL_HINT_FILENAME}`,
    },
    dependencies: {
      "@cursor/sdk": cursorSdkRange || "^1.0.24",
    },
    overrides: { ...NODEJS_AGENT_OVERRIDES },
    engines: { ...NODEJS_AGENT_ENGINES },
  };
}

/** Tiny script printed after `npm install` so users see `npm start` (not bare `npm run`). */
export async function writePostinstallHint(dir) {
  const body = `"use strict";\nconsole.log(${JSON.stringify(`\n${POSTINSTALL_HINT}\n`)});\n`;
  const path = join(dir, POSTINSTALL_HINT_FILENAME);
  await writeFile(path, body, "utf8");
  return path;
}

/** Double-click helper for macOS Finder users who unzip the Node.js zip. */
export async function writeNodejsStartHelper(dir) {
  const body = `#!/bin/bash
# Start ProjectMind desktop agent (Node.js zip).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 22.13+ from https://nodejs.org then re-open this file."
  read -r -p "Press Enter to close…"
  exit 1
fi
if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (first run)…"
  npm install || { read -r -p "Press Enter to close…"; exit 1; }
fi
echo "Starting agent (Ctrl+C to stop)…"
npm start
read -r -p "Agent stopped. Press Enter to close…"
`;
  const path = join(dir, "start.command");
  await writeFile(path, body, "utf8");
  const chmod = spawnSync("chmod", ["+x", path], { encoding: "utf8" });
  if (chmod.status !== 0) {
    throw new Error(`chmod failed for start.command: ${chmod.stderr || chmod.status}`);
  }
  return path;
}
