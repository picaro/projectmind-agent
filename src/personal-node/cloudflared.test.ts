import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUDFLARED_ARGV,
  CLOUDFLARED_RELEASE,
  assertCloudflaredInvocation,
  createTunnelSupervisor,
  findCloudflared,
  spawnCloudflaredProcess,
  type CloudflaredHandle,
  type CloudflaredSpawner,
} from "./cloudflared.js";
import type { CloudflaredRelease } from "./cloudflared-fetch.js";
import { buildHeartbeat } from "./heartbeat.js";
import { runAgentLoop } from "./loop.js";
import { writeState } from "./state.js";
import type { AgentCommand, HeartbeatReport } from "./types.js";
import { PayloadRejected } from "./validate.js";

const TOKEN = "connectorTOKENTHATGOESTOTHEAGENT01";
const DEPLOY_A = "00000000-0000-4000-8000-0000000000e1";
const DEPLOY_B = "00000000-0000-4000-8000-0000000000e2";

function route(input: {
  id: string;
  deploymentId?: string;
  token?: string | null;
  payload?: Record<string, unknown>;
}): AgentCommand {
  const deploymentId = input.deploymentId ?? DEPLOY_A;
  return {
    id: input.id,
    deploymentId,
    type: "apply_route",
    payload: input.payload ?? {
      commandId: input.id,
      deploymentId,
      revision: "rev-1",
      hostname: "owner-a-00000000.apps-hosting.test",
      containerPort: 3000,
      ingress: {
        mode: "outbound",
        provider: "cloudflare_tunnel",
        localAddress: "127.0.0.1",
        localPort: 3000,
        tunnelRef: "cloudflare-tunnel:tunnel1",
        connectorToken: input.token === undefined ? TOKEN : input.token,
      },
    },
  };
}

function stop(id: string, deploymentId: string): AgentCommand {
  return {
    id,
    deploymentId,
    type: "stop_route",
    payload: {
      commandId: id,
      deploymentId,
      revision: "rev-1",
      tunnelRef: "cloudflare-tunnel:tunnel1",
    },
  };
}

function installFake(mode: "stay" | "exit" = "stay") {
  const calls: Array<{ bin: string; args: string[]; token: string }> = [];
  const handles: Array<{ exit(code?: number | null): void }> = [];
  const spawn: CloudflaredSpawner = ({ bin, args, token }) => {
    calls.push({ bin, args: [...args], token });
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    let done = false;
    let running = mode !== "exit";
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      running = false;
      resolveExit(code);
    };
    if (mode === "exit") finish(1);
    const handle: CloudflaredHandle & { exit(code?: number | null): void } = {
      pid: calls.length,
      exited,
      isRunning: () => running,
      kill() {
        finish(null);
      },
      exit(code: number | null = 1) {
        finish(code);
      },
    };
    handles.push(handle);
    return handle;
  };
  return { calls, spawn, handles };
}

describe("cloudflared connector", () => {
  const supervisors: Array<{ stopAll: () => Promise<void> }> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("redacts the connector token when spawn fails", async () => {
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/tmp/cloudflared",
      spawn: () => {
        throw new Error(`cloudflared exploded ${TOKEN}`);
      },
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000c1" }));
    expect(result.outcome).toBe("failed");
    expect(result.publicUrl).toBeNull();
    expect(result.log).not.toContain(TOKEN);
    expect(result.log).toContain("[redacted]");
  });

  it("reports tunnel_not_configured when the connector token is missing", async () => {
    let spawned = false;
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/tmp/cloudflared",
      spawn: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(
      route({ id: "00000000-0000-4000-8000-0000000000c1", token: null }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("tunnel_not_configured");
    expect(result.publicUrl).toBeNull();
    expect(result.log).toMatch(/did not start cloudflared/);
    expect(spawned).toBe(false);
  });

  it("reports cloudflared_not_installed when the binary is missing and no agent folder is set", async () => {
    let spawned = false;
    let downloaded = false;
    const supervisor = createTunnelSupervisor({
      lookup: async () => null,
      download: async () => {
        downloaded = true;
      },
      spawn: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000c1" }));
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("cloudflared_not_installed");
    expect(result.log).toMatch(/not on PATH/);
    expect(result.log).toMatch(/no listener/i);
    expect(result.log).not.toContain(TOKEN);
    expect(spawned).toBe(false);
    expect(downloaded).toBe(false);
    expect(await findCloudflared({ PATH: "" })).toBeNull();
  });

  it("rejects host headers, shells, inbound binds, and extra cloudflared arguments", async () => {
    let spawned = false;
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/tmp/cloudflared",
      spawn: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });
    supervisors.push(supervisor);
    const base = route({ id: "00000000-0000-4000-8000-0000000000c1" });
    const payload = base.payload as Record<string, unknown>;
    const ingress = payload.ingress as Record<string, unknown>;
    const malicious = [
      { ...payload, hostHeader: "evil.example" },
      { ...payload, shell: "sh -c id" },
      { ...payload, args: ["--url", "http://evil.example"] },
      { ...payload, privileged: true },
      { ...payload, listen: "0.0.0.0:80" },
      { ...payload, bindAddress: "0.0.0.0" },
      { ...payload, ingress: { ...ingress, mode: "inbound" } },
      { ...payload, ingress: { ...ingress, url: "http://evil.example" } },
      {
        ...payload,
        ingress: { ...ingress, connectorToken: "--url http://evil.example" },
      },
    ];
    for (const body of malicious) {
      const result = await supervisor.apply({ ...base, payload: body });
      expect(result.outcome).toBe("failed");
      expect(result.publicUrl).toBeNull();
      expect(result.log).not.toContain(TOKEN);
    }
    expect(spawned).toBe(false);
    expect(() =>
      assertCloudflaredInvocation(["tunnel", "run", "--url", "http://127.0.0.1:3000"], TOKEN),
    ).toThrow(PayloadRejected);
    expect(() =>
      spawnCloudflaredProcess({
        bin: "/bin/bash",
        args: [...CLOUDFLARED_ARGV],
        token: TOKEN,
      }),
    ).toThrow(PayloadRejected);
  });

  it("starts one connector per tunnel, dedupes command ids, and stops when deployments are gone", async () => {
    const fake = installFake("stay");
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/tmp/cloudflared",
      spawn: fake.spawn,
      sleep: async () => undefined,
      maxRestarts: 2,
    });
    supervisors.push(supervisor);
    const first = await supervisor.apply(
      route({ id: "00000000-0000-4000-8000-0000000000a1", deploymentId: DEPLOY_A }),
    );
    const replay = await supervisor.apply(
      route({ id: "00000000-0000-4000-8000-0000000000a1", deploymentId: DEPLOY_A }),
    );
    const second = await supervisor.apply(
      route({ id: "00000000-0000-4000-8000-0000000000b1", deploymentId: DEPLOY_B }),
    );
    expect(first.outcome).toBe("applied");
    expect(replay.outcome).toBe("applied");
    expect(second.outcome).toBe("applied");
    expect(first.publicUrl).toBeNull();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual([...CLOUDFLARED_ARGV]);
    expect(fake.calls[0]?.args.join(" ")).not.toContain(TOKEN);
    expect(fake.calls[0]?.args.join(" ")).not.toContain("--url");
    expect(fake.calls[0]?.args.join(" ")).not.toContain("127.0.0.1");
    expect(fake.calls[0]?.token).toBe(TOKEN);
    expect(supervisor.stats().running).toBe(1);
    expect(first.log).not.toContain(TOKEN);

    const stoppedOne = await supervisor.apply(
      stop("00000000-0000-4000-8000-0000000000d1", DEPLOY_A),
    );
    expect(stoppedOne.outcome).toBe("applied");
    expect(supervisor.stats().running).toBe(1);
    expect(fake.calls).toHaveLength(1);

    const stoppedRest = await supervisor.apply(
      stop("00000000-0000-4000-8000-0000000000d2", DEPLOY_B),
    );
    expect(stoppedRest.outcome).toBe("applied");
    expect(stoppedRest.log).toMatch(/stopped/);
    expect(supervisor.stats().running).toBe(0);

    const again = await supervisor.apply(
      route({ id: "00000000-0000-4000-8000-0000000000a2", deploymentId: DEPLOY_A }),
    );
    expect(again.outcome).toBe("applied");
    expect(fake.calls).toHaveLength(2);
    expect(supervisor.stats().running).toBe(1);
  });

  it("restarts a dead connector with a bounded backoff and then stops", async () => {
    const fake = installFake("exit");
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/tmp/cloudflared",
      spawn: fake.spawn,
      sleep: async () => undefined,
      random: () => 0,
      maxRestarts: 2,
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000c9" }));
    expect(result.outcome).toBe("applied");
    await supervisor.whenIdle();
    expect(fake.calls.length).toBe(3);
    expect(supervisor.stats().running).toBe(0);
    expect(supervisor.stats().restarts).toBe(2);
    expect(fake.calls.every((call) => call.args.join(" ") === CLOUDFLARED_ARGV.join(" "))).toBe(
      true,
    );
    expect(supervisor.connectorRunning()).toBe(false);
  });

  it("reports the tunnel available only while the fake cloudflared child is running", async () => {
    const fake = installFake("stay");
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/usr/local/bin/cloudflared",
      spawn: fake.spawn,
      sleep: async () => undefined,
      maxRestarts: 0,
    });
    supervisors.push(supervisor);
    const dir = await mkdtemp(path.join(tmpdir(), "pna-heartbeat-"));
    dirs.push(dir);
    const nodeId = "550e8400-e29b-41d4-a716-446655440010";
    await writeState(dir, {
      sessionId: "550e8400-e29b-41d4-a716-446655440011",
      nodeId,
      deviceToken: "pnd_test_token_value",
      completedCommandIds: [],
    });
    const posted: HeartbeatReport[] = [];
    let listed = 0;
    const command = route({ id: "00000000-0000-4000-8000-0000000000c8" });
    const heartbeat = () => {
      const report = buildHeartbeat({
        dockerEnabled: false,
        socketReachable: false,
        arch: "arm64",
        tunnelUp: supervisor.connectorRunning(),
      });
      posted.push(report);
      return report;
    };
    const runOnce = () =>
      runAgentLoop({
        client: {
          async heartbeat(_id, body) {
            expect(JSON.stringify(body)).not.toContain(TOKEN);
            expect(body.tunnelStatus === "available" || body.tunnelStatus === "unavailable").toBe(
              true,
            );
          },
          async fetchTunnelConnector() {
            return { configured: false, token: null, reason: "tunnel_not_configured" };
          },
          async listCommands() {
            listed += 1;
            return listed === 1 ? [command] : [];
          },
          async redeemEnv() {
            return {};
          },
          async redeemGit() {
            return { username: "git", token: "unused-token-value" };
          },
          async ack() {},
        },
        executor: supervisor,
        stateDir: dir,
        nodeId,
        heartbeat,
        maxCycles: 1,
        sleep: async () => undefined,
      });

    await runOnce();
    expect(posted.map((report) => report.tunnelStatus)).toEqual(["unavailable"]);
    expect(supervisor.connectorRunning()).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(posted)).not.toContain("connected");

    await runOnce();
    expect(posted.map((report) => report.tunnelStatus)).toEqual(["unavailable", "available"]);

    fake.handles[0]?.exit(1);
    expect(supervisor.connectorRunning()).toBe(false);
    await runOnce();
    expect(posted.map((report) => report.tunnelStatus)).toEqual([
      "unavailable",
      "available",
      "unavailable",
    ]);
    expect(JSON.stringify(posted)).not.toContain(TOKEN);
  });

  it("spawns a fake cloudflared executable with the token only in the environment", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cloudflared-"));
    dirs.push(dir);
    const record = path.join(dir, "record.json");
    const bin = path.join(dir, "cloudflared");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const token = process.env.TUNNEL_TOKEN || "";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  tokenInArgv: process.argv.includes(token),
  hasTokenFlag: process.argv.includes("--token"),
  hasUrlFlag: process.argv.includes("--url"),
  hasTunnelToken: token.length > 0,
}));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(bin, 0o755);
    const supervisor = createTunnelSupervisor({
      lookup: async () => bin,
      maxRestarts: 0,
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000c4" }));
    expect(result.outcome).toBe("applied");
    expect(result.log).not.toContain(TOKEN);
    expect(result.publicUrl).toBeNull();
    type CloudflaredRecord = {
      argv: string[];
      tokenInArgv: boolean;
      hasTokenFlag: boolean;
      hasUrlFlag: boolean;
      hasTunnelToken: boolean;
    };
    let recorded: CloudflaredRecord | null = null;
    for (let attempt = 0; attempt < 50 && !recorded; attempt += 1) {
      try {
        recorded = JSON.parse(await readFile(record, "utf8")) as CloudflaredRecord;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(recorded?.argv).toEqual([...CLOUDFLARED_ARGV]);
    expect(recorded?.tokenInArgv).toBe(false);
    expect(recorded?.hasTokenFlag).toBe(false);
    expect(recorded?.hasUrlFlag).toBe(false);
    expect(recorded?.hasTunnelToken).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(TOKEN);
    const found = await findCloudflared({ PATH: dir });
    expect(found).toBe(bin);
  });

  it("uses a PATH binary and does not download", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-path-"));
    dirs.push(dir);
    const urls: string[] = [];
    const fake = installFake("stay");
    const supervisor = createTunnelSupervisor({
      lookup: async () => "/usr/local/bin/cloudflared",
      stateDir: dir,
      platform: "linux",
      processArch: "amd64",
      download: async ({ url }) => {
        urls.push(url);
      },
      spawn: fake.spawn,
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000c5" }));
    expect(result.outcome).toBe("applied");
    expect(urls).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.bin).toBe("/usr/local/bin/cloudflared");
    expect(fake.calls[0]?.args).toEqual([...CLOUDFLARED_ARGV]);
    expect(fake.calls[0]?.args.join(" ")).not.toContain(TOKEN);
    expect(fake.calls[0]?.token).toBe(TOKEN);
  });

  it("downloads a missing binary into the agent folder and still passes the token only in TUNNEL_TOKEN", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-fetch-"));
    dirs.push(dir);
    const record = path.join(dir, "record.json");
    const script = Buffer.from(`#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const token = process.env.TUNNEL_TOKEN || "";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  tokenInArgv: process.argv.includes(token),
  hasTokenFlag: process.argv.includes("--token"),
  hasUrlFlag: process.argv.includes("--url"),
  hasTunnelToken: token.length > 0,
}));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
    const release: CloudflaredRelease = {
      ...CLOUDFLARED_RELEASE,
      version: "test-1",
      assets: {
        ...CLOUDFLARED_RELEASE.assets,
        "linux/amd64": {
          filename: "cloudflared-linux-amd64",
          sha256: createHash("sha256").update(script).digest("hex"),
          format: "binary",
        },
      },
    };
    const urls: string[] = [];
    const supervisor = createTunnelSupervisor({
      lookup: async () => null,
      stateDir: dir,
      platform: "linux",
      processArch: "x64",
      release,
      maxRestarts: 0,
      download: async ({ url, destination }) => {
        urls.push(url);
        await writeFile(destination, script);
      },
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000c6" }));
    expect(result.outcome).toBe("applied");
    expect(result.publicUrl).toBeNull();
    expect(result.log).not.toContain(TOKEN);
    expect(urls).toEqual([
      "https://github.com/cloudflare/cloudflared/releases/download/test-1/cloudflared-linux-amd64",
    ]);
    const installed = path.join(dir, "bin", "cloudflared");
    expect(await readFile(installed)).toEqual(script);
    type CloudflaredRecord = {
      argv: string[];
      tokenInArgv: boolean;
      hasTokenFlag: boolean;
      hasUrlFlag: boolean;
      hasTunnelToken: boolean;
    };
    let recorded: CloudflaredRecord | null = null;
    for (let attempt = 0; attempt < 50 && !recorded; attempt += 1) {
      try {
        recorded = JSON.parse(await readFile(record, "utf8")) as CloudflaredRecord;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(recorded?.argv).toEqual([...CLOUDFLARED_ARGV]);
    expect(recorded?.argv.join(" ")).toBe("tunnel --no-autoupdate run");
    expect(recorded?.tokenInArgv).toBe(false);
    expect(recorded?.hasTokenFlag).toBe(false);
    expect(recorded?.hasUrlFlag).toBe(false);
    expect(recorded?.hasTunnelToken).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(TOKEN);
  });

  it("does not execute a download whose checksum does not match", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-sum-"));
    dirs.push(dir);
    let spawned = false;
    const supervisor = createTunnelSupervisor({
      lookup: async () => null,
      stateDir: dir,
      platform: "linux",
      processArch: "amd64",
      download: async ({ destination }) => {
        await writeFile(destination, Buffer.from("not-cloudflared"));
      },
      spawn: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000c7" }));
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("cloudflared_checksum_mismatch");
    expect(result.log).toMatch(/was not executed/);
    expect(result.log).not.toContain(TOKEN);
    expect(spawned).toBe(false);
    await expect(access(path.join(dir, "bin", "cloudflared"))).rejects.toThrow();
    await expect(access(path.join(dir, "bin", ".cloudflared.partial"))).rejects.toThrow();
  });

  it("does not download for an unknown arch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-cf-arch-"));
    dirs.push(dir);
    let downloaded = false;
    let spawned = false;
    const supervisor = createTunnelSupervisor({
      lookup: async () => null,
      stateDir: dir,
      platform: "linux",
      processArch: "arm64",
      download: async () => {
        downloaded = true;
      },
      spawn: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });
    supervisors.push(supervisor);
    const result = await supervisor.apply(route({ id: "00000000-0000-4000-8000-0000000000ca" }));
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("cloudflared_unsupported_arch");
    expect(result.log).toMatch(/darwin\/arm64, darwin\/amd64, and linux\/amd64/);
    expect(result.log).toMatch(/Nothing was downloaded/);
    expect(result.log).not.toContain(TOKEN);
    expect(downloaded).toBe(false);
    expect(spawned).toBe(false);
  });
});
