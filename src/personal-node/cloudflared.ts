import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";

import {
  CLOUDFLARED_CHECKSUM_MISMATCH,
  CLOUDFLARED_DOWNLOAD_FAILED,
  CLOUDFLARED_DOWNLOAD_REJECTED,
  CLOUDFLARED_UNSUPPORTED_ARCH,
  ensureCloudflaredBinary,
  type CloudflaredDownloader,
  type CloudflaredRelease,
} from "./cloudflared-fetch.ts";
import { failureResult } from "./executor.ts";
import { backoffDelayMs } from "./loop.ts";
import { redactSecrets } from "./redact.ts";
import type { AgentCommand, ApplyResult, CommandExecutor } from "./types.ts";
import { archFromProcess } from "./types.ts";
import { PayloadRejected, validateCommand } from "./validate.ts";

/**
 * Remotely managed Cloudflare Tunnel.
 *
 * `cloudflared tunnel run` with a connector token pulls ingress from
 * Cloudflare. Public hostnames stay on the server-managed config. This
 * process does not pass `--url`, a config file, or an origin flag: those
 * switch the connector to a local ingress rule and can retarget a hostname.
 *
 * cloudflared reads the token from `--token` or the `TUNNEL_TOKEN`
 * environment variable (the flag's EnvVars). It does not read the token from
 * stdin. The environment variable keeps the secret out of process argv.
 * The agent never spawns a shell.
 *
 * When `cloudflared` is not on PATH, `run` downloads the pinned official
 * release into `<stateDir>/bin/cloudflared` and uses that path. It does not
 * change PATH, does not use sudo, and does not install a system package.
 *
 * `run` also starts this connector before any deployment. The paired computer
 * reads `CLOUDFLARE_TUNNEL_TOKEN` from its own node endpoint and calls
 * `ensureConnector`. A missing token leaves the tunnel unavailable with
 * `tunnel_not_configured` and does not open a listener.
 */

export const CLOUDFLARED_ARGV = ["tunnel", "--no-autoupdate", "run"] as const;

export const CLOUDFLARED_NOT_INSTALLED =
  "cloudflared_not_installed: cloudflared is not on PATH and is not in the agent folder. No connector was started and no listener was opened.";

export {
  CLOUDFLARED_CHECKSUM_MISMATCH,
  CLOUDFLARED_DOWNLOAD_FAILED,
  CLOUDFLARED_DOWNLOAD_REJECTED,
  CLOUDFLARED_RELEASE,
  CLOUDFLARED_UNSUPPORTED_ARCH,
  cloudflaredAssetUrl,
  cloudflaredTarget,
  ensureCloudflaredBinary,
} from "./cloudflared-fetch.ts";

export const TUNNEL_NOT_CONFIGURED =
  "tunnel_not_configured: No Cloudflare tunnel connector token was included in this command. The agent did not start cloudflared and did not open a listener.";

const CONNECTOR_RUNNING =
  "Outbound cloudflared connector is running for this tunnel. No inbound port was opened. No public URL was published. Public hostname routes stay on the server-managed tunnel.";

const CONNECTOR_STOPPED =
  "Outbound cloudflared connector stopped. No inbound port was opened. No public URL was published.";

const DEFAULT_MAX_RESTARTS = 5;

export type CloudflaredHandle = {
  readonly pid: number | null;
  readonly exited: Promise<number | null>;
  /** True only until the process exits, errors, or is killed. */
  isRunning(): boolean;
  kill(signal?: NodeJS.Signals): void;
};

export type CloudflaredSpawnInput = {
  bin: string;
  args: readonly string[];
  token: string;
};

export type CloudflaredSpawner = (input: CloudflaredSpawnInput) => CloudflaredHandle;

export function assertCloudflaredInvocation(args: readonly string[], token: string): void {
  const fixed =
    args.length === CLOUDFLARED_ARGV.length &&
    CLOUDFLARED_ARGV.every((arg, index) => args[index] === arg);
  const leaked =
    args.some(
      (arg) =>
        arg === "--token" ||
        arg === "--url" ||
        arg.startsWith("--url=") ||
        arg === "--config" ||
        arg.startsWith("--config=") ||
        arg.includes(token),
    ) || args.join(" ").includes("127.0.0.1");
  if (!fixed || leaked) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "cloudflared accepts only the fixed outbound connector arguments. --url, a shell, and the token on argv are rejected.",
    );
  }
}

function assertConnectorBin(bin: string): void {
  if (
    !path.isAbsolute(bin) ||
    bin.includes("\0") ||
    bin.includes("..") ||
    path.basename(bin) !== "cloudflared"
  ) {
    throw new PayloadRejected(
      "cloudflared_not_installed",
      "The connector binary must be an absolute path to a file named cloudflared.",
    );
  }
}

/** PATH lookup for an executable named cloudflared. Does not download one. */
export async function findCloudflared(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    if (!path.isAbsolute(dir) || dir.includes("..")) continue;
    const candidate = path.join(dir, "cloudflared");
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Spawns cloudflared with shell: false and a fixed argv.
 * The connector token is placed only in TUNNEL_TOKEN.
 * Stdio is ignored so a banner cannot be copied into a log.
 */
export function spawnCloudflaredProcess(input: CloudflaredSpawnInput): CloudflaredHandle {
  assertConnectorBin(input.bin);
  assertCloudflaredInvocation(input.args, input.token);
  const child = spawn(input.bin, [...CLOUDFLARED_ARGV], {
    shell: false,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C",
      TUNNEL_TOKEN: input.token,
    },
  });
  let settled = false;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
  });
  let running = true;
  const markExited = (code: number | null) => {
    running = false;
    resolveExit(code);
  };
  child.on("error", () => markExited(null));
  child.on("close", (code) => markExited(code));
  return {
    pid: child.pid ?? null,
    exited,
    isRunning() {
      return running && child.exitCode === null && !child.killed;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      running = false;
      if (child.exitCode !== null || child.killed) return;
      child.kill(signal);
    },
  };
}

type Connector = {
  key: string;
  token: string;
  tunnelRef: string | null;
  commandIds: Set<string>;
  deploymentIds: Set<string>;
  child: CloudflaredHandle | null;
  stopped: boolean;
  /**
   * Started from the run loop so the computer can be selected before a deploy.
   * `stop_route` drops deployment ids but leaves this child running.
   */
  standing: boolean;
  restarts: number;
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function ingressOf(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const ingress = (payload as { ingress?: unknown }).ingress;
  if (!ingress || typeof ingress !== "object" || Array.isArray(ingress)) return {};
  return ingress as Record<string, unknown>;
}

function connectorTokenFrom(command: AgentCommand): string | null {
  const token = ingressOf(command.payload).connectorToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function tunnelRefFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as { tunnelRef?: unknown; ingress?: unknown };
  if (typeof record.tunnelRef === "string") return record.tunnelRef;
  const nested = ingressOf(payload).tunnelRef;
  return typeof nested === "string" ? nested : null;
}

function logged(text: string, secrets: readonly string[]): string {
  return redactSecrets(text, secrets);
}

export type ConnectorEnsureResult = {
  outcome: "running" | "unavailable";
  code?: string;
  log: string;
};

export type TunnelSupervisor = CommandExecutor & {
  stopAll(): Promise<void>;
  whenIdle(): Promise<void>;
  /** True only while a cloudflared child for some tunnel is still running. */
  connectorRunning(): boolean;
  /**
   * Start the one outbound connector for this process.
   * No deployment and no `--url`. The token is only placed in `TUNNEL_TOKEN`.
   */
  ensureConnector(token: string): Promise<ConnectorEnsureResult>;
  stats(): { spawns: number; running: number; restarts: number };
};

export function createTunnelSupervisor(input?: {
  lookup?: () => Promise<string | null>;
  spawn?: CloudflaredSpawner;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRestarts?: number;
  arch?: "arm64" | "amd64" | "unknown";
  /** Node `process.platform`. Used only to choose the pinned cloudflared asset. */
  platform?: string;
  /** Node `process.arch` (`arm64` or `x64`) or the agent's arm64/amd64/unknown value. */
  processArch?: string;
  /** Agent state directory. The binary is stored at `<stateDir>/bin/cloudflared`. */
  stateDir?: string;
  download?: CloudflaredDownloader;
  release?: CloudflaredRelease;
}): TunnelSupervisor {
  const lookup = input?.lookup ?? (() => findCloudflared());
  const spawnConnector = input?.spawn ?? spawnCloudflaredProcess;
  const sleep = input?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = input?.random ?? (() => 0);
  const maxRestarts = input?.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const arch = input?.arch ?? "amd64";
  const platform = input?.platform ?? process.platform;
  const processArch = input?.processArch ?? archFromProcess();
  const stateDir = input?.stateDir;
  const connectors = new Map<string, Connector>();
  let spawns = 0;
  let inflight = 0;
  const idleWaiters: Array<() => void> = [];

  function begin(): void {
    inflight += 1;
  }

  function end(): void {
    inflight -= 1;
    if (inflight === 0) {
      for (const wake of idleWaiters.splice(0)) wake();
    }
  }

  function connectorKey(tunnelRef: string | null, token: string): string {
    return tunnelRef ? `ref:${tunnelRef}` : `token:${tokenHash(token)}`;
  }

  function running(connector: Connector): boolean {
    return !connector.stopped && connector.child?.isRunning() === true;
  }

  function findRunningByToken(token: string): Connector | undefined {
    for (const connector of connectors.values()) {
      if (connector.token === token && running(connector)) return connector;
    }
    return undefined;
  }

  function stopOtherConnectors(keep: Connector | null): void {
    for (const connector of [...connectors.values()]) {
      if (keep && connector === keep) continue;
      if (!connector.stopped) stopConnector(connector);
    }
  }

  async function resolveBin(): Promise<string> {
    const found = await lookup();
    if (found) {
      assertConnectorBin(found);
      return found;
    }
    if (!stateDir) {
      throw new PayloadRejected("cloudflared_not_installed", CLOUDFLARED_NOT_INSTALLED);
    }
    const downloaded = await ensureCloudflaredBinary({
      stateDir,
      platform,
      arch: processArch,
      download: input?.download,
      release: input?.release,
    });
    assertConnectorBin(downloaded);
    return downloaded;
  }

  function pinnedFailure(error: unknown, secrets: readonly string[]): ApplyResult {
    const result = failureResult(error, secrets);
    const pinnedLogs: Record<string, string> = {
      cloudflared_not_installed: CLOUDFLARED_NOT_INSTALLED,
      tunnel_not_configured: TUNNEL_NOT_CONFIGURED,
      cloudflared_checksum_mismatch: CLOUDFLARED_CHECKSUM_MISMATCH,
      cloudflared_unsupported_arch: CLOUDFLARED_UNSUPPORTED_ARCH,
      cloudflared_download_failed: CLOUDFLARED_DOWNLOAD_FAILED,
      cloudflared_download_rejected: CLOUDFLARED_DOWNLOAD_REJECTED,
    };
    if (error instanceof PayloadRejected && pinnedLogs[error.code]) {
      result.code = error.code;
      result.log = logged(pinnedLogs[error.code] ?? error.message, secrets);
    }
    return result;
  }

  function connectorRunning(): boolean {
    for (const connector of connectors.values()) {
      if (running(connector)) return true;
    }
    return false;
  }

  function spawnFor(connector: Connector, bin: string): CloudflaredHandle {
    const args = [...CLOUDFLARED_ARGV];
    assertCloudflaredInvocation(args, connector.token);
    const handle = spawnConnector({ bin, args, token: connector.token });
    spawns += 1;
    return handle;
  }

  async function watch(connector: Connector, bin: string): Promise<void> {
    begin();
    try {
      while (!connector.stopped && connector.child) {
        await connector.child.exited;
        if (connector.stopped) return;
        if (connector.restarts >= maxRestarts) {
          connector.child = null;
          return;
        }
        connector.restarts += 1;
        await sleep(backoffDelayMs(connector.restarts, random));
        if (connector.stopped) return;
        try {
          connector.child = spawnFor(connector, bin);
        } catch {
          connector.child = null;
          return;
        }
      }
    } finally {
      end();
    }
  }

  function stopConnector(connector: Connector): void {
    connector.stopped = true;
    connector.child?.kill("SIGTERM");
    connectors.delete(connector.key);
  }

  async function stopAll(): Promise<void> {
    for (const connector of [...connectors.values()]) stopConnector(connector);
    await whenIdle();
  }

  function whenIdle(): Promise<void> {
    if (inflight === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function findByCommand(commandId: string): Connector | undefined {
    for (const connector of connectors.values()) {
      if (connector.commandIds.has(commandId) && !connector.stopped) return connector;
    }
    return undefined;
  }

  async function apply(command: AgentCommand): Promise<ApplyResult> {
    const token = connectorTokenFrom(command);
    const secrets = token ? [token] : [];
    try {
      validateCommand(command, arch);
      if (command.type === "stop_route") {
        let stopped = false;
        let keptStanding = false;
        for (const connector of [...connectors.values()]) {
          if (!connector.deploymentIds.has(command.deploymentId)) continue;
          connector.deploymentIds.delete(command.deploymentId);
          connector.commandIds.add(command.id);
          if (connector.deploymentIds.size === 0) {
            if (connector.standing && running(connector)) keptStanding = true;
            else stopConnector(connector);
          }
          stopped = true;
        }
        return {
          outcome: "applied",
          publicUrl: null,
          log: logged(
            stopped
              ? keptStanding
                ? CONNECTOR_RUNNING
                : CONNECTOR_STOPPED
              : `${CONNECTOR_STOPPED} Nothing was running.`,
            secrets,
          ),
        };
      }
      if (command.type !== "apply_route") {
        throw new PayloadRejected(
          "invalid_input",
          `Command type "${command.type}" is not a tunnel command.`,
        );
      }
      if (!token) {
        throw new PayloadRejected("tunnel_not_configured", TUNNEL_NOT_CONFIGURED);
      }
      const tunnelRef = tunnelRefFrom(command.payload);
      const key = connectorKey(tunnelRef, token);
      const existingId = findByCommand(command.id);
      if (existingId && running(existingId)) {
        return { outcome: "applied", publicUrl: null, log: logged(CONNECTOR_RUNNING, secrets) };
      }
      const live = findRunningByToken(token);
      if (live) {
        live.commandIds.add(command.id);
        live.deploymentIds.add(command.deploymentId);
        stopOtherConnectors(live);
        return { outcome: "applied", publicUrl: null, log: logged(CONNECTOR_RUNNING, secrets) };
      }
      const existing = connectors.get(key);
      if (existing) stopConnector(existing);
      const bin = await resolveBin();
      stopOtherConnectors(null);
      const connector: Connector = {
        key,
        token,
        tunnelRef,
        commandIds: new Set([command.id]),
        deploymentIds: new Set([command.deploymentId]),
        child: null,
        stopped: false,
        standing: false,
        restarts: 0,
      };
      connector.child = spawnFor(connector, bin);
      connectors.set(key, connector);
      void watch(connector, bin);
      return { outcome: "applied", publicUrl: null, log: logged(CONNECTOR_RUNNING, secrets) };
    } catch (error) {
      return pinnedFailure(error, secrets);
    }
  }

  async function ensureConnector(token: string): Promise<ConnectorEnsureResult> {
    const trimmed = token.trim();
    const secrets = trimmed ? [trimmed] : [];
    if (!trimmed) {
      return {
        outcome: "unavailable",
        code: "tunnel_not_configured",
        log: logged(TUNNEL_NOT_CONFIGURED, secrets),
      };
    }
    const live = findRunningByToken(trimmed);
    if (live) {
      live.standing = true;
      stopOtherConnectors(live);
      return { outcome: "running", log: logged(CONNECTOR_RUNNING, secrets) };
    }
    try {
      const bin = await resolveBin();
      stopOtherConnectors(null);
      const key = connectorKey(null, trimmed);
      const connector: Connector = {
        key,
        token: trimmed,
        tunnelRef: null,
        commandIds: new Set(),
        deploymentIds: new Set(),
        child: null,
        stopped: false,
        standing: true,
        restarts: 0,
      };
      connector.child = spawnFor(connector, bin);
      connectors.set(key, connector);
      void watch(connector, bin);
      return { outcome: "running", log: logged(CONNECTOR_RUNNING, secrets) };
    } catch (error) {
      const result = pinnedFailure(error, secrets);
      return {
        outcome: "unavailable",
        code: result.code ?? "tunnel_not_configured",
        log: result.log,
      };
    }
  }

  return {
    apply,
    stopAll,
    whenIdle,
    connectorRunning,
    ensureConnector,
    stats() {
      let restarts = 0;
      let runningCount = 0;
      for (const connector of connectors.values()) {
        restarts += connector.restarts;
        if (running(connector)) runningCount += 1;
      }
      return { spawns, running: runningCount, restarts };
    },
  };
}
