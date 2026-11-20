import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NODE_SERVER,
  defaultNodeServer,
  formatNodeStatus,
  runNodeCommand,
} from "./command.ts";
import { writeState } from "./state.ts";

const NODE = "550e8400-e29b-41d4-a716-446655440022";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

function capture() {
  const io = { out: "", err: "" };
  return {
    io,
    stdout: (line: string) => {
      io.out += line;
    },
    stderr: (line: string) => {
      io.err += line;
    },
  };
}

describe("defaultNodeServer", () => {
  it("prefers the explicit node server, then the MCP origin, then production", () => {
    expect(
      defaultNodeServer({
        IMEMORY_PERSONAL_NODE_SERVER: "http://127.0.0.1:8080/",
        IMEMORY_MCP_URL: "https://projectm.dev/api/mcp",
      }),
    ).toBe("http://127.0.0.1:8080");
    expect(defaultNodeServer({ IMEMORY_MCP_URL: "http://localhost:8080/api/mcp" })).toBe(
      "http://localhost:8080",
    );
    expect(defaultNodeServer({ IMEMORY_MCP_URL: "not a url" })).toBe(DEFAULT_NODE_SERVER);
    expect(defaultNodeServer({})).toBe(DEFAULT_NODE_SERVER);
  });
});

describe("formatNodeStatus", () => {
  it("says what to do next for each missing piece", () => {
    expect(
      formatNodeStatus({
        paired: null,
        docker: { enabled: true, socketPath: "/var/run/docker.sock", reachable: false },
        cloudflared: null,
      }),
    ).toEqual([
      "paired: no (run `projectmind-agent node pair`)",
      "docker: no socket answered (start Docker Desktop, OrbStack or Colima)",
      "cloudflared: not installed (downloaded on first run when a tunnel is needed)",
    ]);
    expect(
      formatNodeStatus({
        paired: { nodeId: NODE, server: "https://projectm.dev" },
        docker: { enabled: false, socketPath: "", reachable: false },
        cloudflared: "/opt/homebrew/bin/cloudflared",
      }),
    ).toEqual([
      `paired: yes (node ${NODE}, https://projectm.dev)`,
      "docker: off (IMEMORY_PERSONAL_NODE_DOCKER=0)",
      "cloudflared: /opt/homebrew/bin/cloudflared",
    ]);
  });
});

describe("runNodeCommand", () => {
  it("prints usage and fails without a subcommand", async () => {
    const c = capture();
    expect(await runNodeCommand([], {}, c)).toBe(1);
    expect(c.io.out).toContain("Usage: projectmind-agent node");
    expect(await runNodeCommand(["help"], {}, c)).toBe(0);
  });

  it("rejects an unknown subcommand", async () => {
    const c = capture();
    expect(await runNodeCommand(["deploy"], {}, c)).toBe(1);
    expect(c.io.err).toContain("Unknown node command: deploy");
  });

  it("reports status from local state", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pn-cmd-"));
    await writeState(dir, {
      sessionId: "550e8400-e29b-41d4-a716-446655440011",
      nodeId: NODE,
      deviceToken: "pnd_x",
      server: "http://127.0.0.1:8080",
      completedCommandIds: [],
    });
    const c = capture();
    const code = await runNodeCommand(
      ["status"],
      {
        IMEMORY_PERSONAL_NODE_STATE_DIR: dir,
        IMEMORY_PERSONAL_NODE_DOCKER: "0",
        PATH: "",
      },
      c,
    );
    expect(code).toBe(0);
    expect(c.io.out).toContain(`paired: yes (node ${NODE}, http://127.0.0.1:8080)`);
    expect(c.io.out).toContain("docker: off");
    expect(c.io.out).not.toContain("pnd_x");
  });

  it("does not pair again over an existing pairing without --force", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pn-cmd-"));
    await writeState(dir, {
      sessionId: "550e8400-e29b-41d4-a716-446655440011",
      nodeId: NODE,
      deviceToken: "pnd_x",
      completedCommandIds: [],
    });
    const c = capture();
    let fetched = false;
    const code = await runNodeCommand(["pair", "--state-dir", dir], {}, {
      ...c,
      pair: {
        fetchImpl: (async () => {
          fetched = true;
          return new Response("{}");
        }) as typeof fetch,
      },
    });
    expect(code).toBe(0);
    expect(fetched).toBe(false);
    expect(c.io.out).toContain(`Already paired as node ${NODE}`);
  });

  it("pairs from this computer against the MCP origin when no code is given", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pn-cmd-"));
    const c = capture();
    const urls: string[] = [];
    const opened: string[] = [];
    const code = await runNodeCommand(
      ["pair", "--state-dir", dir, "--no-browser"],
      { IMEMORY_MCP_URL: "http://localhost:8080/api/mcp" },
      {
        ...c,
        pair: {
          sleep: async () => {},
          openUrl: (url) => opened.push(url),
          fetchImpl: (async (url: string) => {
            urls.push(String(url));
            if (String(url).endsWith("/pairing-sessions")) {
              return new Response(
                JSON.stringify({
                  sessionId: "550e8400-e29b-41d4-a716-446655440011",
                  code: "ABCD-EFGH",
                }),
                { status: 201 },
              );
            }
            return new Response(JSON.stringify({ nodeId: NODE, deviceToken: "pnd_y" }));
          }) as typeof fetch,
        },
      },
    );
    expect(code).toBe(0);
    expect(urls[0]).toBe("http://localhost:8080/api/personal-nodes/pairing-sessions");
    expect(opened).toEqual([]);
    expect(c.io.out).toContain(`paired ${NODE}`);
  });

  it("hands a pair with a code to the node CLI", async () => {
    const c = capture();
    const code = await runNodeCommand(
      ["pair", "--session-id", "not-a-uuid", "--code", "ABCD-EFGH"],
      { IMEMORY_MCP_URL: "http://localhost:8080/api/mcp" },
      c,
    );
    expect(code).toBe(1);
    expect(c.io.err).toContain("session id must be a UUID.");
  });

  it("prints the node version", async () => {
    const c = capture();
    expect(await runNodeCommand(["version"], {}, c)).toBe(0);
    expect(c.io.out).toMatch(/^projectmind-agent@/);
  });
});
