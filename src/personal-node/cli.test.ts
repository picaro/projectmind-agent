import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "./cli.js";
import { buildHeartbeat } from "./heartbeat.js";
import { readState, stateFilePath, writeState } from "./state.js";

const NODE = "550e8400-e29b-41d4-a716-446655440010";
const SESSION = "550e8400-e29b-41d4-a716-446655440011";
const TOKEN = "pnd_testtokenvalue";
const CODE = "ABCD-EFGH";

describe("personal-node-agent cli", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("pairs without printing the token or the one-time code", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    let out = "";
    let err = "";
    const code = await main(
      [
        "pair",
        "--server",
        "http://127.0.0.1:8080",
        "--state-dir",
        dir,
        "--session-id",
        SESSION,
        "--code",
        CODE,
      ],
      {},
      {
        stdout: (line) => {
          out += line;
        },
        stderr: (line) => {
          err += line;
        },
        fetchImpl: async (url, init) => {
          expect(String(url)).toBe(
            "http://127.0.0.1:8080/api/personal-nodes/pairing-sessions/exchange",
          );
          const headers = init?.headers as Record<string, string>;
          expect(headers.authorization).toBeUndefined();
          const body = JSON.parse(String(init?.body)) as { code: string; sessionId: string };
          expect(body).toEqual({ code: CODE, sessionId: SESSION });
          return new Response(
            JSON.stringify({ nodeId: NODE, deviceToken: TOKEN, tokenType: "PersonalNode" }),
            { status: 200 },
          );
        },
      },
    );
    expect(code).toBe(0);
    expect(out).toBe(`paired ${NODE}\n`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(CODE);
    expect(err).not.toContain(TOKEN);
    expect(err).not.toContain(CODE);
    expect((await stat(stateFilePath(dir))).mode & 0o777).toBe(0o600);
  });

  it("does not echo the pairing code when exchange fails", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    let err = "";
    const code = await main(
      [
        "pair",
        "--server",
        "http://127.0.0.1:8080",
        "--state-dir",
        dir,
        "--session-id",
        SESSION,
        "--code",
        CODE,
      ],
      {},
      {
        stderr: (line) => {
          err += line;
        },
        fetchImpl: async () => new Response(`bad code ${CODE}`, { status: 409 }),
      },
    );
    expect(code).toBe(1);
    expect(err).not.toContain(CODE);
  });

  it("heartbeat reports runtime unavailable and tunnel unavailable when docker is off", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: TOKEN,
      completedCommandIds: [],
    });
    let out = "";
    let body: unknown;
    const code = await main(
      ["heartbeat", "--server", "http://127.0.0.1:8080", "--state-dir", dir, "--arch", "arm64"],
      { IMEMORY_PERSONAL_NODE_DOCKER: "0" },
      {
        stdout: (line) => {
          out += line;
        },
        fetchImpl: async (url, init) => {
          expect(String(url)).toBe(`http://127.0.0.1:8080/api/personal-nodes/${NODE}/heartbeat`);
          const headers = init?.headers as Record<string, string>;
          expect(headers.authorization).toBe(`PersonalNode ${TOKEN}`);
          body = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ node: { id: NODE } }), { status: 200 });
        },
      },
    );
    const expected = buildHeartbeat({
      dockerEnabled: false,
      socketReachable: false,
      arch: "arm64",
    });
    expect(code).toBe(0);
    expect(body).toEqual(expected);
    expect(out).toBe("runtime_status=unavailable tunnel_status=unavailable\n");
    expect(out).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("connected");
  });

  it("turns Docker on without a flag when a detected socket answers", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: TOKEN,
      completedCommandIds: [],
    });
    let out = "";
    const resolved: NodeJS.ProcessEnv[] = [];
    const code = await main(
      ["heartbeat", "--server", "http://127.0.0.1:8080", "--state-dir", dir, "--arch", "arm64"],
      {},
      {
        stdout: (line) => {
          out += line;
        },
        resolveSocket: async (env) => {
          resolved.push(env);
          return { socketPath: "/Users/someone/.docker/run/docker.sock", reachable: true };
        },
        fetchImpl: async () =>
          new Response(JSON.stringify({ node: { id: NODE } }), { status: 200 }),
      },
    );
    expect(code).toBe(0);
    expect(resolved).toHaveLength(1);
    expect(out).toBe("runtime_status=available tunnel_status=unavailable\n");
  });

  it("exits on revoke without applying", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: TOKEN,
      completedCommandIds: [],
    });
    let err = "";
    let listed = false;
    const code = await main(
      ["run", "--once", "--server", "http://127.0.0.1:8080", "--state-dir", dir],
      {},
      {
        stderr: (line) => {
          err += line;
        },
        fetchImpl: async (url) => {
          if (String(url).endsWith("/commands")) listed = true;
          return new Response(JSON.stringify({ error: "revoked" }), { status: 403 });
        },
      },
    );
    expect(code).toBe(3);
    expect(err).toContain("stopped revoked");
    expect(err).not.toContain(TOKEN);
    expect(listed).toBe(false);
  });

  it("runs after pair using the saved server, node id, and credential", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    const paired = await main(
      [
        "pair",
        "--server",
        "http://127.0.0.1:8080/",
        "--state-dir",
        dir,
        "--session-id",
        SESSION,
        "--code",
        CODE,
      ],
      {},
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ nodeId: NODE, deviceToken: TOKEN, tokenType: "PersonalNode" }),
            { status: 200 },
          ),
      },
    );
    expect(paired).toBe(0);
    const saved = await readState(dir);
    expect(saved).toMatchObject({
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: TOKEN,
      server: "http://127.0.0.1:8080",
    });

    const urls: string[] = [];
    let out = "";
    let heartbeatBody: Record<string, unknown> = {};
    const runArgs = ["run", "--once", "--state-dir", dir];
    expect(runArgs).not.toContain("--server");
    const ran = await main(
      runArgs,
      { IMEMORY_PERSONAL_NODE_DOCKER: "1" },
      {
        stdout: (line) => {
          out += line;
        },
        fetchImpl: async (url, init) => {
          urls.push(String(url));
          const headers = init?.headers as Record<string, string>;
          expect(headers.authorization).toBe(`PersonalNode ${TOKEN}`);
          if (String(url).endsWith("/tunnel")) {
            return new Response(
              JSON.stringify({ configured: false, reason: "tunnel_not_configured" }),
              { status: 200 },
            );
          }
          if (String(url).endsWith("/sync")) {
            heartbeatBody = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify({
                ok: true,
                parts: {
                  commands: { status: 200, body: { commands: [] } },
                  tunnel: { status: 200, body: { configured: false } },
                  quickShares: { status: 200, body: { shares: [] } },
                },
              }),
              { status: 200 },
            );
          }
          return new Response("unexpected", { status: 500 });
        },
      },
    );
    expect(ran).toBe(0);
    expect(out).toMatch(/^projectmind-agent@source lan_address=\S+\n/);
    expect(heartbeatBody.agentVersion).toBe("projectmind-agent@source");
    // The first cycle reads the tunnel before any sync has delivered it; the
    // heartbeat, command list and quick shares are then one request.
    expect(urls).toEqual([
      `http://127.0.0.1:8080/api/personal-nodes/${NODE}/tunnel`,
      `http://127.0.0.1:8080/api/personal-nodes/${NODE}/sync`,
    ]);
    expect(out).toContain("runtime_status=");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(out).not.toContain("CLOUDFLARE_TUNNEL_TOKEN");
  });

  it("run prefers an explicit server over the origin saved by pair", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: TOKEN,
      server: "http://127.0.0.1:8080",
      completedCommandIds: [],
    });
    const urls: string[] = [];
    const ran = await main(
      ["run", "--once", "--state-dir", dir, "--server", "http://127.0.0.1:9"],
      {},
      {
        fetchImpl: async (url) => {
          urls.push(String(url));
          if (String(url).endsWith("/tunnel")) {
            return new Response(
              JSON.stringify({ configured: false, reason: "tunnel_not_configured" }),
              { status: 200 },
            );
          }
          if (String(url).endsWith("/commands")) {
            return new Response(JSON.stringify({ commands: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    );
    expect(ran).toBe(0);
    expect(urls[0]).toBe(`http://127.0.0.1:9/api/personal-nodes/${NODE}/tunnel`);
    expect(urls).toContain(`http://127.0.0.1:9/api/personal-nodes/${NODE}/sync`);
  });

  it("run without a saved server origin explains that pair must store one", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-cli-"));
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: TOKEN,
      completedCommandIds: [],
    });
    let err = "";
    const ran = await main(
      ["run", "--once", "--state-dir", dir],
      {},
      {
        stderr: (line) => {
          err += line;
        },
      },
    );
    expect(ran).toBe(1);
    expect(err).toContain("Saved personal node state has no server origin");
    expect(err).not.toContain(TOKEN);
  });
});
