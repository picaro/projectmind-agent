import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUDFLARED_ARGV,
  createTunnelSupervisor,
  type CloudflaredSpawner,
} from "./cloudflared.js";
import { main } from "./cli.js";
import { writeState } from "./state.js";

const NODE = "550e8400-e29b-41d4-a716-446655440010";
const OTHER = "550e8400-e29b-41d4-a716-446655440012";
const SESSION = "550e8400-e29b-41d4-a716-446655440011";
const DEVICE = "pnd_testtokenvalue";
const CONNECTOR = "connectorTOKENTHATGOESTOTHEAGENT01";

describe("run starts the tunnel without a deploy", () => {
  const dirs: string[] = [];
  const supervisors: Array<{ stopAll: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fakeCloudflared(): Promise<{ binDir: string; record: string }> {
    const binDir = await mkdtemp(path.join(tmpdir(), "pna-cf-bin-"));
    dirs.push(binDir);
    const record = path.join(binDir, "record.json");
    const bin = path.join(binDir, "cloudflared");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const token = process.env.TUNNEL_TOKEN || "";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  tokenInArgv: process.argv.includes(token) || process.argv.join(" ").includes(token),
  hasTokenFlag: process.argv.includes("--token"),
  hasUrlFlag: process.argv.includes("--url") || process.argv.some((arg) => arg.startsWith("--url=")),
  hasTunnelToken: token.length > 0,
}));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(bin, 0o755);
    return { binDir, record };
  }

  function tunnelFetch(input: {
    configured: boolean;
    token?: string | null;
    reason?: string;
  }): typeof fetch {
    return async (url, init) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`PersonalNode ${DEVICE}`);
      expect(target).not.toContain(OTHER);
      if (target.endsWith("/tunnel")) {
        expect(init?.method).toBe("GET");
        return new Response(
          JSON.stringify({
            configured: input.configured,
            reason: input.reason ?? null,
            connectorToken: input.configured ? input.token : null,
          }),
          { status: 200 },
        );
      }
      if (target.endsWith("/heartbeat") || target.endsWith("/sync")) {
        const body = JSON.parse(String(init?.body)) as { tunnelStatus: string };
        return new Response(JSON.stringify({ ok: true, tunnelStatus: body.tunnelStatus }), {
          status: 200,
        });
      }
      if (target.endsWith("/commands")) {
        return new Response(JSON.stringify({ commands: [] }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };
  }

  it("starts one cloudflared from the token endpoint and keeps the token out of argv and logs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-run-tunnel-"));
    dirs.push(dir);
    const { binDir, record } = await fakeCloudflared();
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: DEVICE,
      server: "http://127.0.0.1:8080",
      completedCommandIds: [],
    });
    let out = "";
    let err = "";
    const heartbeats: string[] = [];
    const urls: string[] = [];
    let sawRecord = false;
    const code = await main(
      ["run", "--once", "--state-dir", dir, "--server", "http://127.0.0.1:8080"],
      { PATH: binDir },
      {
        env: { PATH: binDir, IMEMORY_PERSONAL_NODE_DOCKER: "0" },
        stdout: (line) => {
          out += line;
        },
        stderr: (line) => {
          err += line;
        },
        fetchImpl: async (url, init) => {
          urls.push(String(url));
          if (String(url).endsWith("/heartbeat") || String(url).endsWith("/sync")) {
            const body = JSON.parse(String(init?.body)) as { tunnelStatus: string };
            heartbeats.push(body.tunnelStatus);
            for (let attempt = 0; attempt < 50 && !sawRecord; attempt += 1) {
              try {
                await readFile(record, "utf8");
                sawRecord = true;
              } catch {
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            }
          }
          return tunnelFetch({ configured: true, token: CONNECTOR })(url, init);
        },
      },
    );
    expect(code).toBe(0);
    expect(urls.some((url) => url.endsWith("/commands"))).toBe(true);
    expect(urls.some((url) => url.includes("/ack"))).toBe(false);
    expect(heartbeats).toEqual(["available"]);
    expect(out).toContain("runtime_status=unavailable tunnel_status=available");
    expect(out).not.toContain(CONNECTOR);
    expect(err).not.toContain(CONNECTOR);
    expect(out).not.toContain("CLOUDFLARE_TUNNEL_TOKEN");
    expect(sawRecord).toBe(true);
    const recorded = JSON.parse(await readFile(record, "utf8")) as {
      argv: string[];
      tokenInArgv: boolean;
      hasTokenFlag: boolean;
      hasUrlFlag: boolean;
      hasTunnelToken: boolean;
    };
    expect(recorded.argv).toEqual([...CLOUDFLARED_ARGV]);
    expect(recorded.tokenInArgv).toBe(false);
    expect(recorded.hasTokenFlag).toBe(false);
    expect(recorded.hasUrlFlag).toBe(false);
    expect(recorded.hasTunnelToken).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(CONNECTOR);
  });

  it("does not spawn cloudflared when the server token is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-run-notunnel-"));
    dirs.push(dir);
    const { binDir, record } = await fakeCloudflared();
    await writeState(dir, {
      sessionId: SESSION,
      nodeId: NODE,
      deviceToken: DEVICE,
      server: "http://127.0.0.1:8080",
      completedCommandIds: [],
    });
    let out = "";
    let err = "";
    const code = await main(
      ["run", "--once", "--state-dir", dir, "--server", "http://127.0.0.1:8080"],
      { PATH: binDir },
      {
        env: { PATH: binDir, IMEMORY_PERSONAL_NODE_DOCKER: "0" },
        stdout: (line) => {
          out += line;
        },
        stderr: (line) => {
          err += line;
        },
        fetchImpl: tunnelFetch({ configured: false, reason: "tunnel_not_configured" }),
      },
    );
    expect(code).toBe(0);
    expect(out).toContain("runtime_status=unavailable tunnel_status=unavailable");
    expect(out).not.toContain(CONNECTOR);
    expect(err).not.toContain(CONNECTOR);
    expect(err).not.toContain("tunnel_not_configured");
    await expect(readFile(record, "utf8")).rejects.toThrow();
  });

  it("starts one connector without a command and does not spawn when the token is blank", async () => {
    const calls: Array<{ args: string[]; token: string }> = [];
    const spawn: CloudflaredSpawner = ({ args, token }) => {
      calls.push({ args: [...args], token });
      let resolveExit: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });
      let running = true;
      return {
        pid: calls.length,
        exited,
        isRunning: () => running,
        kill() {
          running = false;
          resolveExit(null);
        },
      };
    };
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/tmp/cloudflared",
      spawn,
      maxRestarts: 1,
    });
    supervisors.push(supervisor);
    const first = await supervisor.ensureConnector(CONNECTOR);
    const second = await supervisor.ensureConnector(CONNECTOR);
    expect(first.outcome).toBe("running");
    expect(first.log).not.toContain(CONNECTOR);
    expect(second.outcome).toBe("running");
    expect(supervisor.connectorRunning()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([...CLOUDFLARED_ARGV]);
    expect(calls[0]?.args.join(" ")).not.toContain(CONNECTOR);
    expect(calls[0]?.args.join(" ")).not.toContain("--url");
    expect(calls[0]?.token).toBe(CONNECTOR);
    const missing = await supervisor.ensureConnector("  ");
    expect(missing).toMatchObject({ outcome: "unavailable", code: "tunnel_not_configured" });
    expect(missing.log).not.toContain(CONNECTOR);
    expect(calls).toHaveLength(1);
  });

  it("restarts a dead standing connector with the existing bounded backoff", async () => {
    const calls: string[][] = [];
    const spawn: CloudflaredSpawner = ({ args }) => {
      calls.push([...args]);
      return {
        pid: calls.length,
        exited: Promise.resolve(1),
        isRunning: () => false,
        kill() {},
      };
    };
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/tmp/cloudflared",
      spawn,
      sleep: async () => undefined,
      random: () => 0,
      maxRestarts: 2,
    });
    supervisors.push(supervisor);
    const started = await supervisor.ensureConnector(CONNECTOR);
    expect(started.outcome).toBe("running");
    expect(started.log).not.toContain(CONNECTOR);
    await supervisor.whenIdle();
    expect(calls).toEqual([[...CLOUDFLARED_ARGV], [...CLOUDFLARED_ARGV], [...CLOUDFLARED_ARGV]]);
    expect(supervisor.stats().restarts).toBe(2);
    expect(calls.every((args) => args.join(" ") === "tunnel --no-autoupdate run")).toBe(true);
  });
});
