import os from "node:os";
import { applyPersonalNodeEnvFiles } from "./agent-env.ts";
import { createTunnelSupervisor, findCloudflared } from "./cloudflared.ts";
import { PersonalNodeClient, isControlPlaneClosed } from "./client.ts";
import { parseCli } from "./config.ts";
import {
  createProcessDockerClient,
  findDocker,
  inspectDeploymentContainers,
  selectExecutor,
} from "./docker.ts";
import {
  dockerExecutorEnabled,
  resolveDockerSocket,
  type DockerSocketResolution,
} from "./docker-socket.ts";
import { buildHeartbeat } from "./heartbeat.ts";
import { selectLanAddress } from "./lan-address.ts";
import { runAgentLoop } from "./loop.ts";
import { readListenPid } from "./quick-share.ts";
import { redactSecrets } from "./redact.ts";
import { acquireRunLock, NODE_EXIT_ALREADY_RUNNING, SUPERVISOR_PID_ENV } from "./run-lock.ts";
import { readState, writeState } from "./state.ts";
import { AGENT_VERSION, archFromProcess, type CommandExecutor } from "./types.ts";

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  resolveSocket?: (env: NodeJS.ProcessEnv) => Promise<DockerSocketResolution>;
};

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io?: Partial<CliIo>,
): Promise<number> {
  const stdout = io?.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = io?.stderr ?? ((line: string) => process.stderr.write(line));
  const runtimeEnv = io?.env ?? (env === process.env ? await applyPersonalNodeEnvFiles(env) : env);
  if (argv[0] === "version" || argv[0] === "--version") {
    stdout(`${AGENT_VERSION}\n`);
    return 0;
  }
  let secrets: string[] = [];
  let releaseLock: (() => void) | undefined;
  try {
    const config = parseCli(argv, runtimeEnv);
    secrets = [config.code, config.sessionId].filter((value): value is string => Boolean(value));
    if (config.command === "pair") {
      if (!config.sessionId || !UUID_TEXT.test(config.sessionId)) {
        throw new Error("session id must be a UUID.");
      }
      if (!config.code) throw new Error("pairing code is required.");
      const client = new PersonalNodeClient({
        server: config.server,
        fetchImpl: io?.fetchImpl,
        secrets,
      });
      const exchanged = await client.exchange({ sessionId: config.sessionId, code: config.code });
      secrets.push(exchanged.deviceToken);
      await writeState(config.stateDir, {
        sessionId: config.sessionId,
        nodeId: exchanged.nodeId,
        deviceToken: exchanged.deviceToken,
        server: config.server,
        completedCommandIds: [],
      });
      stdout(`paired ${exchanged.nodeId}\n`);
      return 0;
    }

    const state = await readState(config.stateDir);
    if (!state) throw new Error("Personal node state is missing. Run pair first.");
    const server = config.server || state.server;
    if (!server) {
      throw new Error(
        "Saved personal node state has no server origin. Pair again, or pass --server.",
      );
    }
    secrets.push(state.deviceToken);
    const client = new PersonalNodeClient({
      server,
      fetchImpl: io?.fetchImpl,
      token: state.deviceToken,
      secrets,
      // `run` reads commands, tunnel and quick shares every cycle, so it gets
      // them in the heartbeat response. The one-shot `heartbeat` reads none.
      sync: config.command === "run",
    });
    const dockerEnabled = dockerExecutorEnabled(runtimeEnv);
    const resolveSocket = io?.resolveSocket ?? ((e: NodeJS.ProcessEnv) => resolveDockerSocket(e));
    const initialSocket = dockerEnabled
      ? await resolveSocket(runtimeEnv)
      : { socketPath: "", reachable: false };
    let socketPath = initialSocket.socketPath;
    let socketReachable = initialSocket.reachable;
    const dockerBin = dockerEnabled ? await findDocker(runtimeEnv) : null;
    const arch = config.arch || archFromProcess();
    if (config.command === "heartbeat") {
      // This one-shot command does not own a cloudflared child.
      const heartbeat = buildHeartbeat({
        dockerEnabled,
        socketReachable,
        arch,
        tunnelUp: false,
      });
      await client.heartbeat(state.nodeId, heartbeat);
      stdout(`runtime_status=${heartbeat.runtimeStatus} tunnel_status=${heartbeat.tunnelStatus}\n`);
      return 0;
    }

    const lock = acquireRunLock(config.stateDir);
    if ("heldBy" in lock) {
      stderr(
        `another node run (pid ${lock.heldBy || "unknown"}) already uses ${config.stateDir}. Stop it first.\n`,
      );
      return NODE_EXIT_ALREADY_RUNNING;
    }
    releaseLock = lock.release;

    let docker: ReturnType<typeof createProcessDockerClient> | undefined;
    const tunnels = createTunnelSupervisor({
      arch: config.arch,
      platform: process.platform,
      processArch: config.arch,
      stateDir: config.stateDir,
      lookup: () => findCloudflared(runtimeEnv),
    });
    stdout(`${AGENT_VERSION} lan_address=${selectLanAddress(os.networkInterfaces()) ?? "none"}\n`);
    const knownDeploymentIds: string[] =
      (await readState(config.stateDir))?.knownDeploymentIds ?? [];
    let containers: Awaited<ReturnType<typeof inspectDeploymentContainers>> = [];
    const heartbeat = () => {
      const report = buildHeartbeat({
        dockerEnabled,
        socketReachable,
        arch,
        tunnelUp: tunnels.connectorRunning(),
        containers,
      });
      stdout(`runtime_status=${report.runtimeStatus} tunnel_status=${report.tunnelStatus}\n`);
      return report;
    };
    const buildExecutor = () => {
      docker =
        dockerBin && socketReachable
          ? createProcessDockerClient({ socketPath, bin: dockerBin })
          : undefined;
      return selectExecutor({
        dockerEnabled,
        socketReachable,
        arch: config.arch,
        docker,
        tunnels,
        lookup: dockerEnabled ? async () => dockerBin : undefined,
        redeemEnv: async (command) => {
          const payload =
            command.payload &&
            typeof command.payload === "object" &&
            !Array.isArray(command.payload)
              ? (command.payload as Record<string, unknown>)
              : {};
          const ref = payload.environmentSecretRef;
          if (typeof ref !== "string" || !ref) return {};
          return client.redeemEnv(state.nodeId, command.id, ref);
        },
        redeemGit: async (command) => {
          const payload =
            command.payload &&
            typeof command.payload === "object" &&
            !Array.isArray(command.payload)
              ? (command.payload as Record<string, unknown>)
              : {};
          const git =
            payload.gitBuild && typeof payload.gitBuild === "object"
              ? (payload.gitBuild as Record<string, unknown>)
              : {};
          const ref = git.gitSecretRef;
          if (typeof ref !== "string" || !ref) {
            throw new Error("Git credential reference is missing.");
          }
          const credential = await client.redeemGit(state.nodeId, command.id, ref);
          secrets.push(credential.token);
          return credential;
        },
      });
    };
    let executor = buildExecutor();
    // Docker Desktop may come up after this agent starts. Probing once would
    // leave the runtime reported as unavailable for the life of the process.
    const executorProxy: CommandExecutor = {
      apply: (command, hooks) => executor.apply(command, hooks),
    };
    const controller = new AbortController();
    const onStop = () => {
      controller.abort();
      void tunnels.stopAll();
    };
    process.once("SIGINT", onStop);
    process.once("SIGTERM", onStop);
    const stopParentWatch = watchSupervisor(runtimeEnv, onStop);
    try {
      const result = await runAgentLoop({
        client,
        executor: executorProxy,
        stateDir: config.stateDir,
        nodeId: state.nodeId,
        heartbeat,
        maxCycles: config.once ? 1 : Number.POSITIVE_INFINITY,
        signal: controller.signal,
        beforeHeartbeat: async () => {
          const next = dockerEnabled
            ? await resolveSocket(runtimeEnv)
            : { socketPath, reachable: false };
          if (next.reachable !== socketReachable || next.socketPath !== socketPath) {
            socketReachable = next.reachable;
            socketPath = next.socketPath;
            executor = buildExecutor();
          }
          if (docker && knownDeploymentIds.length > 0) {
            try {
              containers = await inspectDeploymentContainers(docker, knownDeploymentIds, {
                recovery: true,
              });
            } catch {
              containers = [];
            }
          }
          const tunnel = await client.fetchTunnelConnector(state.nodeId);
          if (!tunnel.token) return;
          secrets.push(tunnel.token);
          await tunnels.ensureConnector(tunnel.token);
        },
        onKnownDeployments: (ids) => {
          knownDeploymentIds.splice(0, knownDeploymentIds.length, ...ids);
        },
        readProcessKey: readListenPid,
      });
      if (result.stoppedReason === "revoked") {
        stderr("stopped revoked\n");
        return 3;
      }
      stdout(`cycle applied=${result.applied.length} skipped=${result.skipped.length}\n`);
      return 0;
    } finally {
      stopParentWatch();
      await tunnels.stopAll();
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
    }
  } catch (error) {
    if (isControlPlaneClosed(error)) {
      stderr("stopped revoked\n");
      return 3;
    }
    const message = error instanceof Error ? error.message : "personal-node-agent failed";
    stderr(`${redactSecrets(message, secrets)}\n`);
    return 1;
  } finally {
    releaseLock?.();
  }
}

/**
 * Under `projectmind-agent`, stop when that parent goes away (SIGKILL, crash) instead of
 * running on with a tunnel nobody supervises, and do not crash on a closed stdout pipe.
 */
function watchSupervisor(env: NodeJS.ProcessEnv, onStop: () => void): () => void {
  const parent = Number.parseInt(env[SUPERVISOR_PID_ENV] ?? "", 10);
  if (!Number.isInteger(parent) || parent <= 1) return () => {};
  const onPipeError = () => onStop();
  process.stdout.on("error", onPipeError);
  process.stderr.on("error", onPipeError);
  const timer = setInterval(() => {
    if (process.ppid !== parent) onStop();
  }, 5_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    process.stdout.off("error", onPipeError);
    process.stderr.off("error", onPipeError);
  };
}