import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { approvalUrl, devicePair, PAIR_POLL_INTERVAL_MS, pairingPlatform } from "./device-pair.ts";
import { readState } from "./state.ts";

const SESSION = "550e8400-e29b-41d4-a716-446655440011";
const NODE = "550e8400-e29b-41d4-a716-446655440022";
const CODE = "ABCD-EFGH";
const TOKEN = "pnd_secret_token";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function clock() {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
    waits,
  };
}

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("approvalUrl", () => {
  it("opens the Computers approval form without the code in the URL", () => {
    expect(approvalUrl("https://projectm.dev")).toBe(
      "https://projectm.dev/hosting?tab=computers&approveComputer=1",
    );
  });
});

describe("pairingPlatform", () => {
  it("maps to the platforms the server accepts", () => {
    expect(pairingPlatform("darwin")).toBe("darwin");
    expect(pairingPlatform("linux")).toBe("linux");
    expect(pairingPlatform("win32")).toBe("other");
  });
});

describe("devicePair", () => {
  it("creates a session, waits for approval, and saves the device credential", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pn-pair-"));
    const time = clock();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let exchanges = 0;
    let out = "";
    const opened: string[] = [];
    const result = await devicePair(
      { server: "http://127.0.0.1:8080/", stateDir: dir, name: "Studio" },
      {
        ...time,
        stdout: (line) => {
          out += line;
        },
        openUrl: (url) => opened.push(url),
        fetchImpl: (async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          if (String(url).endsWith("/pairing-sessions")) {
            return json({ sessionId: SESSION, code: CODE, expiresInSeconds: 600 }, 201);
          }
          exchanges += 1;
          if (exchanges === 1) return json({ error: "not_approved", message: "x" }, 409);
          if (exchanges === 2) return json({ error: "rate_limited" }, 429, { "retry-after": "45" });
          if (exchanges === 3) return new Response("<html>Bad gateway</html>", { status: 502 });
          return json({ nodeId: NODE, deviceToken: TOKEN, tokenType: "PersonalNode" });
        }) as typeof fetch,
      },
    );
    expect(result).toEqual({ nodeId: NODE });
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:8080/api/personal-nodes/pairing-sessions",
      body: { name: "Studio" },
    });
    expect(calls[0]?.body.agentVersion).toMatch(/^projectmind-agent@/);
    expect(calls[1]).toEqual({
      url: "http://127.0.0.1:8080/api/personal-nodes/pairing-sessions/exchange",
      body: { code: CODE, sessionId: SESSION },
    });
    expect(time.waits).toEqual([
      PAIR_POLL_INTERVAL_MS / 2,
      PAIR_POLL_INTERVAL_MS,
      45_000,
      PAIR_POLL_INTERVAL_MS,
    ]);
    expect(opened).toEqual(["http://127.0.0.1:8080/hosting?tab=computers&approveComputer=1"]);
    expect(opened[0]).not.toContain(CODE);
    expect(out).toContain("Pairing code: ABCD-EFGH");
    expect(out).not.toContain(TOKEN);
    expect(await readState(dir)).toMatchObject({
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: TOKEN,
      server: "http://127.0.0.1:8080",
    });
  });

  it("stops when the code expires before approval", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pn-pair-"));
    const time = clock();
    await expect(
      devicePair(
        { server: "http://127.0.0.1:8080", stateDir: dir },
        {
          ...time,
          stdout: () => {},
          fetchImpl: (async (url: string) =>
            String(url).endsWith("/pairing-sessions")
              ? json({ sessionId: SESSION, code: CODE, expiresInSeconds: 60 }, 201)
              : json({ error: "not_approved" }, 409)) as typeof fetch,
        },
      ),
    ).rejects.toThrow("expired before it was approved");
    expect(await readState(dir)).toBeNull();
  });

  it("fails on a terminal exchange error without echoing the code", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pn-pair-"));
    const time = clock();
    const error = await devicePair(
      { server: "http://127.0.0.1:8080", stateDir: dir },
      {
        ...time,
        stdout: () => {},
        fetchImpl: (async (url: string) =>
          String(url).endsWith("/pairing-sessions")
            ? json({ sessionId: SESSION, code: CODE }, 201)
            : json({ error: "expired", message: `Code ${CODE} expired.` }, 410)) as typeof fetch,
      },
    ).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Pairing failed (410)");
    expect((error as Error).message).not.toContain(CODE);
  });

  it("explains a server that refuses to start pairing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pn-pair-"));
    await expect(
      devicePair(
        { server: "http://127.0.0.1:8080", stateDir: dir },
        {
          ...clock(),
          stdout: () => {},
          fetchImpl: (async () =>
            json({ error: "disabled", message: "Personal hosting is off." }, 404)) as typeof fetch,
        },
      ),
    ).rejects.toThrow("Could not start pairing (404). Personal hosting is off.");
  });
});
