import { describe, expect, it, vi } from "vitest";
import { ControlPlaneClosedError, ControlPlaneRequestError, PersonalNodeClient } from "./client.ts";
import type { HeartbeatReport } from "./types.ts";

const heartbeat = { agentVersion: "test" } as unknown as HeartbeatReport;

function respond(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return handler(url, init);
  });
  const client = new PersonalNodeClient({
    server: "https://projectm.dev",
    token: "pnd_secret_token",
    fetchImpl: fetchImpl as never,
    sync: true,
  });
  return { client, calls };
}

const syncBody = {
  ok: true,
  parts: {
    commands: { status: 200, body: { commands: [{ id: "c1", deploymentId: "d1", type: "x" }] } },
    tunnel: { status: 200, body: { configured: true, connectorToken: "tunnel-token-123" } },
    quickShares: {
      status: 200,
      body: { shares: [{ shareId: "s1", targetPort: 3000, revision: 2 }] },
    },
  },
};

describe("PersonalNodeClient sync", () => {
  it("makes one request per cycle and serves the three reads from it", async () => {
    const { client, calls } = clientWith((url) =>
      url.endsWith("/sync") ? respond(200, syncBody) : respond(500, { error: "unexpected" }),
    );

    await client.heartbeat("n1", heartbeat);
    expect(await client.listCommands("n1")).toEqual([
      { id: "c1", deploymentId: "d1", type: "x", payload: {} },
    ]);
    expect(await client.listQuickShareDesired("n1")).toEqual([
      { shareId: "s1", targetPort: 3000, revision: 2, approvalGeneration: 1 },
    ]);
    expect(await client.fetchTunnelConnector("n1")).toEqual({
      configured: true,
      token: "tunnel-token-123",
      reason: null,
    });
    expect(calls).toEqual(["POST /api/personal-nodes/n1/sync"]);
  });

  it("uses each synced part once, then falls back to the route", async () => {
    const { client, calls } = clientWith((url) => {
      if (url.endsWith("/sync")) return respond(200, syncBody);
      if (url.endsWith("/commands")) return respond(200, { commands: [] });
      return respond(500, {});
    });
    await client.heartbeat("n1", heartbeat);
    await client.listCommands("n1");
    expect(await client.listCommands("n1")).toEqual([]);
    expect(calls).toEqual([
      "POST /api/personal-nodes/n1/sync",
      "GET /api/personal-nodes/n1/commands",
    ]);
  });

  it("drops parts from an earlier cycle when the next heartbeat fails", async () => {
    let fail = false;
    const { client, calls } = clientWith((url) => {
      if (url.endsWith("/sync")) return fail ? respond(503, {}) : respond(200, syncBody);
      if (url.endsWith("/commands")) return respond(200, { commands: [] });
      return respond(500, {});
    });
    await client.heartbeat("n1", heartbeat);
    fail = true;
    await expect(client.heartbeat("n1", heartbeat)).rejects.toBeInstanceOf(
      ControlPlaneRequestError,
    );
    expect(await client.listCommands("n1")).toEqual([]);
    expect(calls.at(-1)).toBe("GET /api/personal-nodes/n1/commands");
  });

  it("throws the standalone error for a failed part", async () => {
    const { client } = clientWith(() =>
      respond(200, {
        ok: true,
        parts: {
          commands: { status: 401, body: { error: "revoked" } },
          quickShares: { status: 429, body: { error: "rate_limited" } },
        },
      }),
    );
    await client.heartbeat("n1", heartbeat);
    await expect(client.listCommands("n1")).rejects.toBeInstanceOf(ControlPlaneClosedError);
    await expect(client.listQuickShareDesired("n1")).rejects.toMatchObject({ status: 429 });
  });

  it("falls back to /heartbeat for good when the server has no /sync", async () => {
    const { client, calls } = clientWith((url) => {
      if (url.endsWith("/sync")) return respond(404, { error: "not_found" });
      if (url.endsWith("/heartbeat")) return respond(200, { ok: true });
      if (url.endsWith("/commands")) return respond(200, { commands: [] });
      return respond(500, {});
    });
    await client.heartbeat("n1", heartbeat);
    await client.listCommands("n1");
    await client.heartbeat("n1", heartbeat);
    expect(calls).toEqual([
      "POST /api/personal-nodes/n1/sync",
      "POST /api/personal-nodes/n1/heartbeat",
      "GET /api/personal-nodes/n1/commands",
      "POST /api/personal-nodes/n1/heartbeat",
    ]);
  });

  it("keeps the plain heartbeat unless sync is enabled", async () => {
    const calls: string[] = [];
    const client = new PersonalNodeClient({
      server: "https://projectm.dev",
      token: "pnd_secret_token",
      fetchImpl: (async (url: string) => {
        calls.push(new URL(url).pathname);
        return respond(200, { ok: true });
      }) as never,
    });
    await client.heartbeat("n1", heartbeat);
    expect(calls).toEqual(["/api/personal-nodes/n1/heartbeat"]);
  });

  it("treats a revoked sync as a closed control plane", async () => {
    const { client } = clientWith(() => respond(401, { error: "revoked" }));
    await expect(client.heartbeat("n1", heartbeat)).rejects.toBeInstanceOf(ControlPlaneClosedError);
  });
});
