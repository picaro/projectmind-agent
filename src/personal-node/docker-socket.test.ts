import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCKER_SOCKET,
  dockerExecutorEnabled,
  dockerSocketCandidates,
  resolveDockerSocket,
} from "./docker-socket.ts";

const HOME = "/Users/someone";

describe("dockerExecutorEnabled", () => {
  it("is on unless explicitly set to 0", () => {
    expect(dockerExecutorEnabled({})).toBe(true);
    expect(dockerExecutorEnabled({ IMEMORY_PERSONAL_NODE_DOCKER: "1" })).toBe(true);
    expect(dockerExecutorEnabled({ IMEMORY_PERSONAL_NODE_DOCKER: " 0 " })).toBe(false);
  });
});

describe("dockerSocketCandidates", () => {
  it("tries the system socket, then Docker Desktop, OrbStack, Colima and Rancher Desktop", () => {
    expect(dockerSocketCandidates({}, HOME)).toEqual([
      DEFAULT_DOCKER_SOCKET,
      `${HOME}/.docker/run/docker.sock`,
      `${HOME}/.orbstack/run/docker.sock`,
      `${HOME}/.colima/default/docker.sock`,
      `${HOME}/.rd/docker.sock`,
    ]);
  });

  it("uses only an explicit socket", () => {
    expect(
      dockerSocketCandidates({ IMEMORY_PERSONAL_NODE_DOCKER_SOCKET: "/tmp/d.sock" }, HOME),
    ).toEqual(["/tmp/d.sock"]);
  });
});

describe("resolveDockerSocket", () => {
  it("returns the first reachable candidate", async () => {
    const probed: string[] = [];
    const result = await resolveDockerSocket(
      {},
      {
        home: HOME,
        probe: async (socketPath) => {
          probed.push(socketPath);
          return socketPath.includes(".docker/run");
        },
      },
    );
    expect(result).toEqual({ socketPath: `${HOME}/.docker/run/docker.sock`, reachable: true });
    expect(probed).toEqual([DEFAULT_DOCKER_SOCKET, `${HOME}/.docker/run/docker.sock`]);
  });

  it("falls back to the first candidate, unreachable, when nothing answers", async () => {
    const result = await resolveDockerSocket({}, { home: HOME, probe: async () => false });
    expect(result).toEqual({ socketPath: DEFAULT_DOCKER_SOCKET, reachable: false });
  });
});
