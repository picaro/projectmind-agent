import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main } from "./cli.ts";
import { findCloudflared } from "./cloudflared.ts";
import { devicePair, type DevicePairDeps } from "./device-pair.ts";
import { dockerExecutorEnabled, resolveDockerSocket } from "./docker-socket.ts";
import { readState } from "./state.ts";
import { AGENT_VERSION } from "./types.ts";

/**
 * `projectmind-agent node <subcommand>`: the personal-hosting node (local cloud).
 * `run`, `heartbeat` and `version` go straight to the node CLI. `pair` without a
 * code starts pairing from this computer. `status` reads local state only.
 */

export const DEFAULT_NODE_SERVER = "https://projectm.dev";

export type NodeCommandIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  pair?: DevicePairDeps;
};

export function defaultStateDir(env: NodeJS.ProcessEnv): string {
  return (
    env.IMEMORY_PERSONAL_NODE_STATE_DIR?.trim() || path.join(os.homedir(), ".imemory", "personal-node")
  );
}

/** Explicit node server, else the origin of the agent's MCP URL, else production. */
export function defaultNodeServer(env: NodeJS.ProcessEnv): string {
  const explicit = env.IMEMORY_PERSONAL_NODE_SERVER?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const mcp = env.IMEMORY_MCP_URL?.trim();
  if (mcp) {
    try {
      return new URL(mcp).origin;
    } catch {
      // Fall through to production.
    }
  }
  return DEFAULT_NODE_SERVER;
}

export type NodeStatus = {
  paired: { nodeId: string; server: string | null } | null;
  docker: { enabled: boolean; socketPath: string; reachable: boolean };
  cloudflared: string | null;
};

export async function collectNodeStatus(env: NodeJS.ProcessEnv): Promise<NodeStatus> {
  const stateDir = defaultStateDir(env);
  let state: Awaited<ReturnType<typeof readState>> = null;
  try {
    state = await readState(stateDir);
  } catch {
    state = null;
  }
  const enabled = dockerExecutorEnabled(env);
  const socket = enabled
    ? await resolveDockerSocket(env)
    : { socketPath: "", reachable: false };
  let cloudflared = await findCloudflared(env);
  if (!cloudflared) {
    const downloaded = path.join(stateDir, "bin", "cloudflared");
    try {
      await access(downloaded, constants.X_OK);
      cloudflared = downloaded;
    } catch {
      cloudflared = null;
    }
  }
  return {
    paired: state ? { nodeId: state.nodeId, server: state.server ?? null } : null,
    docker: { enabled, ...socket },
    cloudflared,
  };
}

export function formatNodeStatus(status: NodeStatus): string[] {
  const lines: string[] = [];
  lines.push(
    status.paired
      ? `paired: yes (node ${status.paired.nodeId}${status.paired.server ? `, ${status.paired.server}` : ""})`
      : "paired: no (run `projectmind-agent node pair`)",
  );
  if (!status.docker.enabled) lines.push("docker: off (IMEMORY_PERSONAL_NODE_DOCKER=0)");
  else if (status.docker.reachable) lines.push(`docker: ${status.docker.socketPath}`);
  else lines.push("docker: no socket answered (start Docker Desktop, OrbStack or Colima)");
  lines.push(
    status.cloudflared
      ? `cloudflared: ${status.cloudflared}`
      : "cloudflared: not installed (downloaded on first run when a tunnel is needed)",
  );
  return lines;
}

function usage(): string {
  return [
    "Usage: projectmind-agent node <command>",
    "",
    "  pair       Pair this computer for local cloud (approve it in the browser)",
    "  run        Run the node: heartbeats, deploys, tunnel (Ctrl-C to stop)",
    "  heartbeat  Send one heartbeat and exit",
    "  status     Show pairing, Docker and cloudflared on this computer",
    "  version    Print the node version",
    "",
    "A running `projectmind-agent` starts `node run` on its own once this computer is paired.",
    "",
  ].join("\n");
}

function takeFlag(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export async function runNodeCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: NodeCommandIo,
): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    io.stdout(usage());
    return sub ? 0 : 1;
  }
  if (sub === "status") {
    io.stdout(`${AGENT_VERSION}\n`);
    for (const line of formatNodeStatus(await collectNodeStatus(env))) io.stdout(`${line}\n`);
    return 0;
  }
  if (sub === "pair") {
    const withServer: NodeJS.ProcessEnv = {
      ...env,
      IMEMORY_PERSONAL_NODE_SERVER: defaultNodeServer(env),
    };
    const hasCode = Boolean(takeFlag(args, "--code") || env.IMEMORY_PERSONAL_NODE_CODE?.trim());
    if (hasCode) return main(args, withServer, { stdout: io.stdout, stderr: io.stderr });
    const server = takeFlag(args, "--server") || defaultNodeServer(env);
    const stateDir = takeFlag(args, "--state-dir") || defaultStateDir(env);
    const existing = await readState(stateDir).catch(() => null);
    if (existing && !args.includes("--force")) {
      io.stdout(
        `Already paired as node ${existing.nodeId}. Pass --force to pair this computer again.\n`,
      );
      return 0;
    }
    try {
      const paired = await devicePair(
        { server, stateDir, name: takeFlag(args, "--name") },
        {
          ...io.pair,
          stdout: io.stdout,
          openUrl: args.includes("--no-browser") ? undefined : io.pair?.openUrl,
        },
      );
      io.stdout(`paired ${paired.nodeId}\n`);
      io.stdout("Start it with `projectmind-agent` (or `projectmind-agent node run`).\n");
      return 0;
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : "Pairing failed."}\n`);
      return 1;
    }
  }
  if (sub === "run" || sub === "heartbeat" || sub === "version" || sub === "--version") {
    return main(args, env, { stdout: io.stdout, stderr: io.stderr });
  }
  io.stderr(`Unknown node command: ${sub}\n\n${usage()}`);
  return 1;
}
