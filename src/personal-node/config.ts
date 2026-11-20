import os from "node:os";
import path from "node:path";

import { archFromProcess, NODE_ARCHES, type NodeArch } from "./types.ts";

export type CliCommand = "pair" | "heartbeat" | "run";

export type CliConfig = {
  command: CliCommand;
  server: string;
  stateDir: string;
  sessionId?: string;
  code?: string;
  arch: NodeArch;
  once: boolean;
};

function takeValue(argv: string[], index: number, flag: string): string {
  const inline = argv[index]?.includes("=") ? argv[index]?.slice(flag.length + 1) : undefined;
  const value = inline && inline.length > 0 ? inline : argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv): CliConfig {
  const command = argv[0];
  if (command !== "pair" && command !== "heartbeat" && command !== "run") {
    throw new Error(
      "Usage: personal-node-agent <pair|heartbeat|run|version> [--server URL] [--state-dir DIR]",
    );
  }
  let server = env.IMEMORY_PERSONAL_NODE_SERVER?.trim() || "";
  let stateDir = env.IMEMORY_PERSONAL_NODE_STATE_DIR?.trim() || "";
  let sessionId = env.IMEMORY_PERSONAL_NODE_SESSION_ID?.trim() || "";
  let code = env.IMEMORY_PERSONAL_NODE_CODE?.trim() || "";
  let archText = "";
  let once = false;

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const name = flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag;
    if (name === "--once") {
      once = true;
      continue;
    }
    const value = takeValue(argv, index, name);
    if (!flag.includes("=")) index += 1;
    if (name === "--server") server = value;
    else if (name === "--state-dir") stateDir = value;
    else if (name === "--session-id") sessionId = value;
    else if (name === "--code") code = value;
    else if (name === "--arch") archText = value;
    else throw new Error(`Unknown flag ${name}.`);
  }

  // `run` after `pair` reads the origin from the state file. Pair still needs one.
  if (!server && command !== "run") {
    throw new Error(
      "Set --server or IMEMORY_PERSONAL_NODE_SERVER (for example http://127.0.0.1:8080).",
    );
  }
  if (!stateDir) stateDir = path.join(os.homedir(), ".imemory", "personal-node");
  let arch = archFromProcess();
  if (archText) {
    if (!NODE_ARCHES.includes(archText as NodeArch)) {
      throw new Error("Arch must be arm64, amd64, or unknown.");
    }
    arch = archText as NodeArch;
  }
  if (command === "pair" && (!sessionId || !code)) {
    throw new Error(
      "pair requires --session-id and --code (or the matching IMEMORY_PERSONAL_NODE_* variables).",
    );
  }

  return {
    command,
    server,
    stateDir,
    sessionId: sessionId || undefined,
    code: code || undefined,
    arch,
    once,
  };
}
