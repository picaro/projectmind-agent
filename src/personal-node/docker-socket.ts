import os from "node:os";
import path from "node:path";

import { probeDockerSocket } from "./docker.ts";

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * `IMEMORY_PERSONAL_NODE_DOCKER=0` turns the container executor off.
 * Unset or `1` turns it on; the runtime still reports unavailable until a socket answers.
 */
export function dockerExecutorEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.IMEMORY_PERSONAL_NODE_DOCKER?.trim() !== "0";
}

/** Sockets in the order they are tried. An explicit socket is the only candidate. */
export function dockerSocketCandidates(
  env: NodeJS.ProcessEnv,
  home: string = os.homedir(),
): string[] {
  const explicit = env.IMEMORY_PERSONAL_NODE_DOCKER_SOCKET?.trim();
  if (explicit) return [explicit];
  return [
    DEFAULT_DOCKER_SOCKET,
    path.join(home, ".docker", "run", "docker.sock"),
    path.join(home, ".orbstack", "run", "docker.sock"),
    path.join(home, ".colima", "default", "docker.sock"),
    path.join(home, ".rd", "docker.sock"),
  ];
}

export type DockerSocketResolution = { socketPath: string; reachable: boolean };

/**
 * First reachable candidate. When none answers, the first candidate is returned
 * unreachable so a later probe (Docker Desktop starting) can pick it up.
 */
export async function resolveDockerSocket(
  env: NodeJS.ProcessEnv,
  options: { home?: string; probe?: (socketPath: string) => Promise<boolean> } = {},
): Promise<DockerSocketResolution> {
  const probe = options.probe ?? probeDockerSocket;
  const candidates = dockerSocketCandidates(env, options.home);
  for (const socketPath of candidates) {
    if (await probe(socketPath)) return { socketPath, reachable: true };
  }
  return { socketPath: candidates[0] ?? DEFAULT_DOCKER_SOCKET, reachable: false };
}
