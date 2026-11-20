import { buildReportFromSpec } from "./build-report.ts";
import { parseNativeRestartFence, assertNativeRestartSnapshot } from "./native-restart-fence.ts";
import { spawn } from "node:child_process";
import { isPinnedManifestReference } from "./image-reference.ts";
import {
  CONTAINER_OBSERVATION_FORMAT,
  RECOVERY_CONTAINER_OBSERVATION_FORMAT,
  parseContainerObservation,
  parseRecoveryContainerObservation,
} from "./runtime-observation.ts";
import {
  DEPLOY_RECEIPT_FORMAT,
  deployReceiptLabels,
  readDeployReceipt,
  validDeployReceiptLabels,
} from "./deploy-replay.ts";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";

export const CONTAINER_INSTANCE_FORMAT = "{{.Id}}";

import {
  digestFromImageInspect,
  dockerFailureText,
  formatBuildProvenance,
  parseGitBuildSpec,
  pathUnderTemp,
  prepareAppBuild,
  prepareFetchWorkspace,
  removeBuildWorkspace,
  type GitCredential,
  type PersonalBuildSpec,
} from "./git-build.ts";

import {
  assertEnvFilePath,
  defaultEnvFileRoot,
  removeRuntimeEnvFile,
  runtimeEnvFilePath,
  writeRuntimeEnvFile,
} from "./env-file.ts";
import { parseStackContainers, stackContainerName, type StackContainerSpec } from "./stack.ts";
import { createValidatingExecutor, failureResult } from "./executor.ts";
import { connectPortRelay } from "./port-relay.ts";
import { redactSecrets } from "./redact.ts";
import type {
  AgentCommand,
  ApplyHooks,
  ApplyResult,
  CommandExecutor,
  HeartbeatReport,
  NodeArch,
} from "./types.ts";
import {
  IMAGE_DIGEST,
  PayloadRejected,
  shouldDeleteVolumes,
  validateCommand,
  volumeNamesFromPayload,
} from "./validate.ts";
import {
  WIREGUARD_CAP,
  WIREGUARD_CONFIG_MOUNT,
  WIREGUARD_DEVICE,
  WIREGUARD_ENDPOINT_PROFILE,
  WIREGUARD_SYSCTLS,
  WIREGUARD_UDP_PUBLISH,
  isWireguardEasyDigest,
  isWireguardImageReference,
  parseVpnEndpoint,
  parseWireguardPasswordHash,
  wireguardImageReference,
  wireguardRuntimeEnv,
} from "./wireguard-profile.ts";

/**
 * Docker-compatible CLI for one digest-pinned container on 127.0.0.1.
 * Tests pass a fake client or a fake executable. This process does not
 * download Docker, and does not mark a route live. The only non-loopback
 * publish is UDP 51820 for the wireguard-endpoint profile.
 * Arguments are never passed through a shell.
 *
 * `environmentSecretRef` is redeemed by the caller into a mode-0600 env file.
 * The file is passed as `--env-file` and deleted afterward. `-e` / `--env`
 * stay forbidden. Secret values are not placed on argv.
 */

export const CONTAINER_RUNTIME_NOT_INSTALLED =
  "container_runtime_not_installed: docker is not on PATH. Install a Docker-compatible runtime yourself. This agent does not download Docker, does not request root, and did not start a container.";

const SOCKET_NOT_REACHABLE =
  "container_runtime_not_installed: docker is on PATH but no Docker-compatible socket is reachable. This agent does not install or start a runtime and did not pull an image.";

export type DockerRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface DockerClient {
  run(
    args: string[],
    options?: { runtimeProfile?: typeof WIREGUARD_ENDPOINT_PROFILE },
  ): Promise<DockerRunResult>;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISH_ON_LOOPBACK = /^127\.0\.0\.1:(\d{1,5}):(\d{1,5})$/;
const PLATFORM = /^(linux\/arm64|linux\/amd64)$/;

export function containerNameFor(deploymentId: string): string {
  const trimmed = deploymentId.trim().toLowerCase();
  if (!UUID_TEXT.test(trimmed)) {
    throw new PayloadRejected(
      "invalid_input",
      "deploymentId must be an id before a container name is chosen.",
    );
  }
  return `pn-${trimmed}`;
}

function inlineFlagValue(arg: string, flag: string): string | undefined {
  const prefix = `${flag}=`;
  if (arg.length < prefix.length || arg.slice(0, prefix.length).toLowerCase() !== prefix) {
    return undefined;
  }
  return arg.slice(prefix.length);
}

function optionValue(args: readonly string[], index: number, flag: string): string | undefined {
  const arg = args[index] ?? "";
  const inline = inlineFlagValue(arg, flag);
  if (inline !== undefined) return inline;
  if (arg.toLowerCase() === flag) return args[index + 1];
  return undefined;
}

/** Separate `--flag value` and inline `--flag=value`. A flag with no following argument is omitted. */
function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const inline = inlineFlagValue(arg, flag);
    if (inline !== undefined) {
      values.push(inline);
      continue;
    }
    if (arg.toLowerCase() !== flag) continue;
    const value = args[index + 1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function mountDestinations(value: string): string[] {
  const destinations: string[] = [];
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).toLowerCase();
    if (key === "destination" || key === "dst" || key === "target") {
      destinations.push(part.slice(eq + 1));
    }
  }
  return destinations;
}

function loopbackPublish(value: string): boolean {
  const match = PUBLISH_ON_LOOPBACK.exec(value);
  if (!match?.[1] || !match[2]) return false;
  const hostPort = Number(match[1]);
  const containerPort = Number(match[2]);
  return (
    String(hostPort) === match[1] &&
    String(containerPort) === match[2] &&
    hostPort >= 1 &&
    hostPort <= 65535 &&
    containerPort >= 1 &&
    containerPort <= 65535
  );
}

function envFileIsAllowed(file: string, root: string | undefined): boolean {
  const roots = [root, defaultEnvFileRoot()].filter((value): value is string => Boolean(value));
  for (const candidate of new Set(roots)) {
    try {
      assertEnvFilePath(file, candidate);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function allowedImageReference(value: string): boolean {
  return (
    IMAGE_DIGEST.test(value) || isPinnedManifestReference(value) || isWireguardImageReference(value)
  );
}

export function assertSafeDockerArgs(
  args: readonly string[],
  options?: { envFileRoot?: string; runtimeProfile?: typeof WIREGUARD_ENDPOINT_PROFILE },
): void {
  const wireguard = options?.runtimeProfile === WIREGUARD_ENDPOINT_PROFILE;
  const issues: string[] = [];
  for (const arg of args) {
    if (arg.includes("\0") || arg.includes("\n") || arg.includes("\r")) {
      issues.push("control character");
    }
    if (arg.includes("[::]")) issues.push("published port");
    if (arg.includes("0.0.0.0") && arg !== WIREGUARD_UDP_PUBLISH) issues.push("published port");
    if (arg === WIREGUARD_UDP_PUBLISH && !wireguard) issues.push("published port");
  }
  const joined = args.join(" ").toLowerCase();
  if (joined.includes("docker.sock") || joined.includes("..")) {
    issues.push("docker.sock or path traversal");
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const lower = arg.toLowerCase();
    if (lower === "--privileged" || lower.startsWith("--privileged=")) issues.push("privileged");
    if (
      lower === "-v" ||
      lower.startsWith("-v/") ||
      lower.startsWith("-v=") ||
      lower === "--volume" ||
      lower.startsWith("--volume=")
    ) {
      issues.push("host mount");
    }
    if (lower === "--cap-add" || lower.startsWith("--cap-add=")) {
      const cap = optionValue(args, index, "--cap-add");
      if (!wireguard || cap !== WIREGUARD_CAP) issues.push("added capability");
    }
    if (lower === "--device" || lower.startsWith("--device=")) {
      const device = optionValue(args, index, "--device");
      if (!wireguard || device !== WIREGUARD_DEVICE) issues.push("host device");
    }
    if (lower === "--sysctl" || lower.startsWith("--sysctl=")) {
      const sysctl = lower.startsWith("--sysctl=")
        ? arg.slice("--sysctl=".length)
        : (args[index + 1] ?? "");
      if (!wireguard || !WIREGUARD_SYSCTLS.includes(sysctl as (typeof WIREGUARD_SYSCTLS)[number])) {
        issues.push("sysctl");
      }
    }
    if (lower === "-e" || lower === "--env" || lower.startsWith("--env=")) {
      issues.push("environment value");
    }
    if (lower === "--env-file" || lower.startsWith("--env-file=")) {
      const file = lower.startsWith("--env-file=")
        ? arg.slice("--env-file=".length)
        : (args[index + 1] ?? "");
      if (!envFileIsAllowed(file, options?.envFileRoot)) issues.push("env file path");
    }
    if (lower === "sh" || lower === "bash" || lower === "/bin/sh" || lower === "/bin/bash") {
      issues.push("shell");
    }
    if (
      lower === "--network" ||
      lower === "--net" ||
      lower === "--pid" ||
      lower === "--ipc" ||
      lower === "--uts"
    ) {
      const value = (args[index + 1] ?? "").toLowerCase();
      if (value === "host") issues.push("host namespace");
    }
    if (
      (lower.startsWith("--network=") ||
        lower.startsWith("--net=") ||
        lower.startsWith("--pid=")) &&
      lower.endsWith("=host")
    ) {
      issues.push("host namespace");
    }
    if (
      lower === "-p" ||
      lower === "-P" ||
      lower === "--publish-all" ||
      lower.startsWith("--publish=")
    ) {
      issues.push("published port");
    }
    if (lower === "--publish") {
      const published = args[index + 1] ?? "";
      const wireguardUdp = wireguard && published === WIREGUARD_UDP_PUBLISH;
      if (!wireguardUdp && !loopbackPublish(published)) issues.push("published port");
    }
    if (lower === "--mount" || lower.startsWith("--mount=")) {
      const value = lower.startsWith("--mount=")
        ? arg.slice("--mount=".length)
        : (args[index + 1] ?? "");
      if (!value.startsWith("type=volume,")) issues.push("mount must be a named volume");
      if (value.includes("source=/") || value.toLowerCase().includes("docker.sock")) {
        issues.push("host mount");
      }
      for (const destination of mountDestinations(value)) {
        if (
          destination.startsWith("/") &&
          !destination.startsWith("/volumes/") &&
          !(wireguard && destination === WIREGUARD_CONFIG_MOUNT)
        ) {
          issues.push("host mount");
        }
      }
    }
  }
  if (args[0] === "run") {
    const image = args[args.length - 1] ?? "";
    if (!IMAGE_DIGEST.test(image) && !isPinnedManifestReference(image))
      issues.push("image must be a sha256 digest");
    const publishAt = args.filter((arg) => arg === "--publish").length;
    if (publishAt !== (wireguard ? 2 : 1)) issues.push("published port");
    if (wireguard) {
      const image = args[args.length - 1] ?? "";
      if (!isWireguardEasyDigest(image)) issues.push("image must be a sha256 digest");
      const caps = flagValues(args, "--cap-add");
      const devices = flagValues(args, "--device");
      const sysctls = flagValues(args, "--sysctl");
      if (caps.length !== 1 || caps[0] !== WIREGUARD_CAP) issues.push("added capability");
      if (devices.length !== 1 || devices[0] !== WIREGUARD_DEVICE) issues.push("host device");
      if (sysctls.join("\n") !== WIREGUARD_SYSCTLS.join("\n")) issues.push("sysctl");
      if (!args.includes(WIREGUARD_UDP_PUBLISH)) issues.push("published port");
    }
    const pullAt = args.indexOf("--pull");
    if (pullAt < 0 || args[pullAt + 1] !== "never") issues.push("registry pull");
  }
  if (args[0] === "pull") {
    const reference = args[1] ?? "";
    if (args.length !== 2 || !allowedImageReference(reference)) {
      issues.push("image must be a sha256 digest");
    }
  }
  if (args[0] === "manifest") {
    const reference = args[3] ?? "";
    if (
      args.length !== 4 ||
      args[1] !== "inspect" ||
      args[2] !== "--verbose" ||
      !allowedImageReference(reference)
    ) {
      issues.push("image must be a sha256 digest");
    }
  }
  if (
    args[0] === "inspect" &&
    (args.length !== 4 ||
      args[1] !== "--format" ||
      ![
        "{{.State.Status}}",
        CONTAINER_OBSERVATION_FORMAT,
        RECOVERY_CONTAINER_OBSERVATION_FORMAT,
        DEPLOY_RECEIPT_FORMAT,
        CONTAINER_INSTANCE_FORMAT,
      ].includes(args[2] ?? "") ||
      !/^pn-[a-z0-9-]{1,100}$/.test(args[3] ?? ""))
  )
    issues.push("container inspection projection");
  const labels = flagValues(args, "--label");
  if (labels.length && !validDeployReceiptLabels(labels)) issues.push("deploy receipt labels");
  if (args[0] === "rm" && (args.includes("-v") || args.includes("--volumes"))) {
    issues.push("volume delete flag");
  }
  issues.push(...builderIssues(args));
  if (issues.length > 0) {
    throw new PayloadRejected(
      "forbidden_command_field",
      `Docker arguments rejected: ${[...new Set(issues)].join(", ")}.`,
    );
  }
}

function builderIssues(args: readonly string[]): string[] {
  if (args[0] === "build") return buildArgIssues(args);
  if (args[0] === "create") {
    const tag = args[2] ?? "";
    if (args.length !== 4 || args[1] !== "--name" || args[3] !== tag || !/^pn-fetch-/.test(tag)) {
      return ["builder container"];
    }
    return [];
  }
  if (args[0] === "cp") {
    const source = args[1] ?? "";
    const dest = args[2] ?? "";
    const match = /^(pn-fetch-[0-9a-f-]{36}):\/src\/\.$/i.exec(source);
    if (args.length !== 3 || !match || !pathUnderTemp(dest)) return ["builder copy"];
    return [];
  }
  if (args[0] === "image" && args[1] === "rm") {
    const tag = args[2] ?? "";
    if (args.length !== 3 || !/^pn-fetch-/.test(tag)) return ["builder image"];
    return [];
  }
  if (args[0] === "image" && args[1] === "inspect") {
    const target = args[2] ?? "";
    const digest = IMAGE_DIGEST.test(target);
    const tag = /^pn-(fetch|app)-[0-9a-f-]{36}$/i.test(target);
    if (args.length !== 3 || (!digest && !tag)) return ["image must be a sha256 digest"];
    return [];
  }
  return [];
}

function allowedBuildArg(value: string): boolean {
  const eq = value.indexOf("=");
  if (eq <= 0) return false;
  const key = value.slice(0, eq);
  const body = value.slice(eq + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) return false;
  if (body.length > 16_000 || /[\r\n\0]/.test(body) || body.includes("..")) return false;
  if (key === "REPO_URL") {
    return /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~+-]+)+$/.test(body) && !body.includes("@");
  }
  if (key === "GIT_REF") return /^[A-Za-z0-9._/-]{1,128}$/.test(body);
  return true;
}

function buildArgIssues(args: readonly string[]): string[] {
  let tag = "";
  let file = "";
  const positional: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-t" || arg === "--tag") {
      tag = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "-f" || arg === "--file") {
      file = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--build-arg") {
      const value = args[index + 1] ?? "";
      index += 1;
      if (!allowedBuildArg(value)) return ["build arg"];
      continue;
    }
    if (arg === "--secret") {
      const value = args[index + 1] ?? "";
      index += 1;
      const secret = /^id=([A-Za-z_][A-Za-z0-9_]{0,127}),src=(.+)$/.exec(value);
      if (!secret?.[2] || !pathUnderTemp(secret[2])) return ["build secret file"];
      continue;
    }
    if (arg.startsWith("-")) return ["builder flag"];
    positional.push(arg);
  }
  if (!/^pn-(fetch|app)-[0-9a-f-]{36}$/i.test(tag)) return ["builder tag"];
  if (!pathUnderTemp(file) || positional.length !== 1 || !pathUnderTemp(positional[0] ?? "")) {
    return ["builder context"];
  }
  return [];
}

type PlatformHit = { os?: string; architecture?: string };

function collectPlatforms(value: unknown, out: PlatformHit[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPlatforms(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  const architecture =
    typeof record.architecture === "string"
      ? record.architecture
      : typeof record.Architecture === "string"
        ? record.Architecture
        : undefined;
  const osName =
    typeof record.os === "string"
      ? record.os
      : typeof record.Os === "string"
        ? record.Os
        : undefined;
  if (architecture || osName) {
    out.push({ os: osName, architecture });
  }
  for (const child of Object.values(record)) collectPlatforms(child, out);
}

/**
 * True when `docker manifest inspect --verbose` reports a linux platform for
 * this computer. Callers inject the inspect stdout in tests. A missing or
 * unreadable platform does not match, so the image is not pulled.
 */
export function manifestMatchesArch(stdout: string, arch: NodeArch): boolean {
  if (arch !== "arm64" && arch !== "amd64") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  const platforms: PlatformHit[] = [];
  collectPlatforms(parsed, platforms);
  return platforms.some((platform) => platform.os === "linux" && platform.architecture === arch);
}

export function planRemove(input: {
  containerName: string;
  deleteVolumes: boolean;
  volumeNames: readonly string[];
}): string[][] {
  const remove = ["rm", "-f", input.containerName];
  assertSafeDockerArgs(remove);
  if (!input.deleteVolumes) return [remove];
  const volumeRemovals = input.volumeNames.map((name) => {
    const args = ["volume", "rm", name];
    assertSafeDockerArgs(args);
    return args;
  });
  return [remove, ...volumeRemovals];
}

function limitsFor(payload: Record<string, unknown>): { cpus: string; memory: string } {
  const limits =
    payload.resourceLimits && typeof payload.resourceLimits === "object"
      ? (payload.resourceLimits as Record<string, unknown>)
      : {};
  const cpu =
    typeof limits.cpu === "number"
      ? limits.cpu
      : typeof limits.cpuMillis === "number"
        ? limits.cpuMillis / 1000
        : 1;
  const memory =
    typeof limits.memoryMb === "number"
      ? `${limits.memoryMb}m`
      : typeof limits.memoryBytes === "number"
        ? String(limits.memoryBytes)
        : "512m";
  return { cpus: cpu.toFixed(3), memory };
}

function containerPortFor(payload: Record<string, unknown>): number {
  const port = payload.containerPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PayloadRejected(
      "invalid_input",
      "containerPort must be an integer from 1 to 65535 before a container is published.",
    );
  }
  return port;
}

/** Loopback port. Omit hostPort to publish the app port on the same number. */
function hostPortFor(payload: Record<string, unknown>): number {
  const raw = payload.hostPort;
  if (raw === undefined || raw === null) return containerPortFor(payload);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new PayloadRejected(
      "invalid_input",
      "hostPort must be an integer from 1 to 65535 before a container is published.",
    );
  }
  return raw;
}

export function planRun(input: {
  containerName: string;
  payload: Record<string, unknown>;
  envFile?: string;
  envFileRoot?: string;
}): string[] {
  const digest =
    typeof input.payload.imageDigest === "string" ? input.payload.imageDigest.trim() : "";
  const platform =
    typeof input.payload.declaredPlatform === "string" ? input.payload.declaredPlatform : "";
  if (!PLATFORM.test(platform)) {
    throw new PayloadRejected(
      "arch_mismatch",
      "declaredPlatform must be linux/arm64 or linux/amd64 before docker runs.",
    );
  }
  const containerPort = containerPortFor(input.payload);
  const hostPort = hostPortFor(input.payload);
  const { cpus, memory } = limitsFor(input.payload);
  const args = [
    "run",
    "-d",
    "--name",
    input.containerName,
    "--pull",
    "never",
    "--network",
    "bridge",
    "--publish",
    `127.0.0.1:${hostPort}:${containerPort}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--platform",
    platform,
    "--cpus",
    cpus,
    "--memory",
    memory,
    "--memory-swap",
    memory,
  ];
  if (isPinnedManifestReference(digest)) {
    for (const label of deployReceiptLabels(input.payload)) args.push("--label", label);
  }
  for (const name of volumeNamesFromPayload(input.payload)) {
    args.push("--mount", `type=volume,source=${name},destination=/volumes/${name}`);
  }
  if (input.envFile) args.push("--env-file", input.envFile);
  args.push(digest);
  assertSafeDockerArgs(args, { envFileRoot: input.envFileRoot ?? defaultEnvFileRoot() });
  return args;
}

function planStackContainerRun(input: {
  installationId: string;
  spec: StackContainerSpec;
  networkName: string;
  platform: string;
  envFile?: string;
  envFileRoot?: string;
}): string[] {
  const name = stackContainerName(input.installationId, input.spec.role);
  const cpus = "0.5";
  const memory = "512m";
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    input.networkName,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--platform",
    input.platform,
    "--cpus",
    cpus,
    "--memory",
    memory,
    "--memory-swap",
    memory,
  ];
  for (const vol of input.spec.volumeSpecs ?? []) {
    const destination = vol.mountPath ?? vol.name;
    args.push("--mount", `type=volume,source=${vol.name},destination=${destination}`);
  }
  if (input.spec.publishLoopback) {
    args.push("--publish", `127.0.0.1:${input.spec.containerPort}:${input.spec.containerPort}`);
  }
  if (input.spec.runtimeProfile === WIREGUARD_ENDPOINT_PROFILE) {
    args.push("--cap-add", WIREGUARD_CAP, "--device", WIREGUARD_DEVICE);
    for (const sysctl of WIREGUARD_SYSCTLS) args.push("--sysctl", sysctl);
    args.push("--publish", WIREGUARD_UDP_PUBLISH);
  }
  if (input.envFile && input.spec.publishLoopback) args.push("--env-file", input.envFile);
  args.push(input.spec.imageDigest);
  assertSafeDockerArgs(args, {
    envFileRoot: input.envFileRoot ?? defaultEnvFileRoot(),
    runtimeProfile: input.spec.runtimeProfile,
  });
  return args;
}

export function planApplyStack(input: {
  installationId: string;
  payload: Record<string, unknown>;
  envFile?: string;
  envFileRoot?: string;
}): string[][] {
  const networkName =
    typeof input.payload.networkName === "string" ? input.payload.networkName.trim() : "";
  const platform =
    typeof input.payload.declaredPlatform === "string" ? input.payload.declaredPlatform : "";
  const containers = parseStackContainers(input.payload.containers);
  const steps: string[][] = [["network", "create", networkName]];
  const volumes = new Set<string>();
  for (const spec of containers) {
    for (const vol of spec.volumeSpecs ?? []) volumes.add(vol.name);
  }
  for (const vol of volumes) steps.push(["volume", "create", vol]);
  for (const spec of containers) {
    const name = stackContainerName(input.installationId, spec.role);
    if (spec.runtimeProfile === WIREGUARD_ENDPOINT_PROFILE) {
      const reference = wireguardImageReference(spec.imageDigest);
      steps.push(["manifest", "inspect", "--verbose", reference]);
      steps.push(["pull", reference]);
    }
    steps.push(["rm", "-f", name]);
    steps.push(
      planStackContainerRun({
        installationId: input.installationId,
        spec,
        networkName,
        platform,
        envFile: input.envFile,
        envFileRoot: input.envFileRoot,
      }),
    );
  }
  return steps;
}

/** Fixed argv for one deploy. Named volumes are created and never removed here. */
export function planDeploy(input: {
  containerName: string;
  payload: Record<string, unknown>;
  envFile?: string;
  envFileRoot?: string;
  /** Image was just built on this computer. Do not pull it from a registry. */
  local?: boolean;
}): string[][] {
  const digest =
    typeof input.payload.imageDigest === "string" ? input.payload.imageDigest.trim() : "";
  const steps: string[][] = [
    input.local ? ["image", "inspect", digest] : ["manifest", "inspect", "--verbose", digest],
  ];
  for (const name of volumeNamesFromPayload(input.payload)) {
    steps.push(["volume", "create", name]);
  }
  if (!input.local) steps.push(["pull", digest]);
  steps.push(["rm", "-f", input.containerName]);
  steps.push(planRun(input));
  if (!input.local && isPinnedManifestReference(digest)) {
    steps.push(["inspect", "--format", "{{.State.Status}}", input.containerName]);
  }
  for (const step of steps) {
    assertSafeDockerArgs(step, { envFileRoot: input.envFileRoot ?? defaultEnvFileRoot() });
  }
  return steps;
}

/** docker inspect of known deployments. A failed inspect that is not "no such object" is omitted. */
export async function inspectDeploymentContainers(
  client: DockerClient,
  deploymentIds: readonly string[],
  options: { recovery?: boolean } = {},
): Promise<NonNullable<HeartbeatReport["containers"]>> {
  const out: NonNullable<HeartbeatReport["containers"]> = [];
  for (const rawId of deploymentIds.slice(0, 32)) {
    let name: string;
    try {
      name = containerNameFor(rawId);
    } catch {
      continue;
    }
    const args = [
      "inspect",
      "--format",
      options.recovery ? RECOVERY_CONTAINER_OBSERVATION_FORMAT : CONTAINER_OBSERVATION_FORMAT,
      name,
    ];
    try {
      assertSafeDockerArgs(args);
    } catch {
      continue;
    }
    const result = await client.run(args);
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    const deploymentId = rawId.trim().toLowerCase();
    if (result.exitCode !== 0) {
      if (missingContainer(result) || text.includes("no such object")) {
        out.push({ deploymentId, status: "missing" });
      }
      continue;
    }
    const observation = options.recovery
      ? parseRecoveryContainerObservation(deploymentId, result.stdout)
      : parseContainerObservation(deploymentId, result.stdout);
    if (observation) out.push(observation);
  }
  return out;
}

function invocationsFor(
  command: AgentCommand,
  envFile?: string,
  envFileRoot?: string,
  localImage?: boolean,
): string[][] {
  const payload =
    command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
      ? (command.payload as Record<string, unknown>)
      : {};
  const name = containerNameFor(command.deploymentId);
  if (command.type === "apply_stack") {
    const installationId =
      typeof payload.installationId === "string"
        ? payload.installationId.trim()
        : command.deploymentId;
    return planApplyStack({ installationId, payload, envFile, envFileRoot });
  }
  if (command.type === "deploy") {
    return planDeploy({ containerName: name, payload, envFile, envFileRoot, local: localImage });
  }
  if (command.type === "start") return [["start", name]];
  if (command.type === "stop") return [["stop", name]];
  if (command.type === "restart") return [["restart", name]];
  if (command.type === "remove") {
    const deleteVolumes = shouldDeleteVolumes(payload);
    return planRemove({
      containerName: name,
      deleteVolumes,
      volumeNames: deleteVolumes ? volumeNamesFromPayload(payload) : [],
    });
  }
  if (command.type === "fetch_logs") return [["logs", "--tail", "200", name]];
  if (
    command.type === "export_volume" ||
    command.type === "export_database" ||
    command.type === "import_volume" ||
    command.type === "import_database"
  ) {
    return [["version"]];
  }
  if (command.type === "apply_route" || command.type === "stop_route") {
    throw new PayloadRejected(
      "tunnel_not_configured",
      "This container executor does not start cloudflared. No listener was opened.",
    );
  }
  throw new PayloadRejected("invalid_input", `Command type "${command.type}" is not allowlisted.`);
}

function missingContainer(result: DockerRunResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return text.includes("no such container") || text.includes("no container with");
}

function volumeAlreadyExists(result: DockerRunResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return text.includes("already exists");
}

function appliedLog(command: AgentCommand, injected: boolean): string {
  if (command.type === "apply_stack") {
    const payload =
      command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
        ? (command.payload as Record<string, unknown>)
        : {};
    const wireguard = parseStackContainers(payload.containers).some(
      (entry) => entry.runtimeProfile,
    );
    if (wireguard) {
      return "WireGuard is listening on UDP 51820 of this computer. The admin dashboard is on 127.0.0.1:51821. No public URL was published.";
    }
  }
  if (command.type !== "deploy") {
    return "Allowlisted container command finished locally. Named volumes were kept. No public URL was published.";
  }
  const payload =
    command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
      ? (command.payload as Record<string, unknown>)
      : {};
  const port = hostPortFor(payload);
  const envNote = injected
    ? "Runtime environment was loaded from a one-time reference. The env file was removed after start."
    : "No environment file was attached.";
  return `Digest-pinned container is running on 127.0.0.1:${port}. Named volumes were kept. No public URL was published. ${envNote} cloudflared, edge attachment, and the HTTPS probe are still required.`;
}

async function buildFromGit(input: {
  command: AgentCommand;
  client: DockerClient;
  arch: NodeArch;
  redeemGit?: (command: AgentCommand) => Promise<GitCredential>;
  secrets: string[];
  env?: Record<string, string>;
  onPhase?: ApplyHooks["onPhase"];
}): Promise<
  | { outcome: "ok"; digest: string; buildSpec: PersonalBuildSpec }
  | { outcome: "failed"; result: ApplyResult }
> {
  const payload =
    input.command.payload && typeof input.command.payload === "object"
      ? (input.command.payload as Record<string, unknown>)
      : {};
  const spec = parseGitBuildSpec(payload.gitBuild);
  if (!spec) {
    return {
      outcome: "failed",
      result: failureResult(
        new PayloadRejected("invalid_input", "gitBuild is not a connected repository."),
        input.secrets,
      ),
    };
  }
  let credential: GitCredential | null = null;
  if (spec.gitSecretRef) {
    if (!input.redeemGit) {
      return {
        outcome: "failed",
        result: failureResult(
          new PayloadRejected(
            "invalid_secret_ref",
            "This private repository needs a one-time clone credential. None was redeemed.",
          ),
          input.secrets,
        ),
      };
    }
    try {
      credential = await input.redeemGit(input.command);
    } catch (error) {
      return { outcome: "failed", result: failureResult(error, input.secrets) };
    }
    if (credential.token.length >= 4) input.secrets.push(credential.token);
    if (credential.username.length >= 4) input.secrets.push(credential.username);
  }
  const workspace = await prepareFetchWorkspace({
    commandId: input.command.id,
    spec,
    credential,
  });
  const failed = (message: string) => ({
    outcome: "failed" as const,
    result: failureResult(new PayloadRejected("apply_failed", message), input.secrets),
  });
  try {
    await input.onPhase?.("cloning");
    for (const args of [
      workspace.buildArgs,
      workspace.createArgs,
      workspace.copyArgs,
      workspace.removeContainerArgs,
      workspace.removeImageArgs,
    ]) {
      assertSafeDockerArgs(args);
      const result = await input.client.run(args);
      if (result.exitCode !== 0 && args[0] !== "image" && args[0] !== "rm") {
        return failed(dockerFailureText(result.exitCode, result.stderr || result.stdout));
      }
    }
    const app = await prepareAppBuild({
      commandId: input.command.id,
      spec,
      checkoutDir: workspace.checkoutDir,
      target: {
        platform: payload.declaredPlatform as PersonalBuildSpec["target"]["platform"],
        runtimePort: payload.containerPort as number,
      },
      env: input.env,
    });
    await input.onPhase?.("building");
    for (const args of [app.buildArgs, app.inspectArgs]) {
      assertSafeDockerArgs(args);
      const result = await input.client.run(args);
      if (result.exitCode !== 0) {
        return failed(dockerFailureText(result.exitCode, result.stderr || result.stdout));
      }
      if (args[0] === "image" && args[1] === "inspect") {
        if (!manifestMatchesArch(result.stdout, input.arch)) {
          return {
            outcome: "failed",
            result: {
              outcome: "failed",
              publicUrl: null,
              code: "image_arch_mismatch",
              log: redactSecrets(
                `The built image has no linux/${input.arch} platform. No container was started.`,
                input.secrets,
              ),
            },
          };
        }
        const digest = digestFromImageInspect(result.stdout);
        if (!digest) return failed("docker build did not report an image digest.");
        return {
          outcome: "ok",
          digest,
          buildSpec: {
            ...app.buildSpec,
            artifact: { localImageConfigDigest: digest, ociManifestReference: null },
          },
        };
      }
    }
    return failed("docker build did not report an image digest.");
  } catch (error) {
    return { outcome: "failed", result: failureResult(error, input.secrets) };
  } finally {
    await removeBuildWorkspace(workspace.root);
  }
}

function keepPortRelay(payload: Record<string, unknown>): void {
  const host = typeof payload.relayHost === "string" ? payload.relayHost : "";
  const controlPort = typeof payload.relayControlPort === "number" ? payload.relayControlPort : 0;
  const token = typeof payload.relayToken === "string" ? payload.relayToken : "";
  if (!host || controlPort < 1 || !token) return;
  void (async () => {
    for (;;) {
      try {
        const relay = await connectPortRelay({ host, controlPort, token, localPort: 51820 });
        await relay.closed;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  })();
}

export function createDockerExecutor(input: {
  client?: DockerClient;
  arch: NodeArch;
  /** When set, null means the docker binary is absent. This agent does not install it. */
  lookup?: () => Promise<string | null>;
  /** Redeems environmentSecretRef. Omitted keeps the previous no-file behavior. */
  redeemEnv?: (command: AgentCommand) => Promise<Record<string, string>>;
  /** Redeems gitSecretRef into a one-time clone credential. Omitted rejects private git builds. */
  redeemGit?: (command: AgentCommand) => Promise<GitCredential>;
  envFileRoot?: string;
}): CommandExecutor {
  const runs = new Map<string, Promise<ApplyResult>>();

  async function execute(command: AgentCommand, hooks?: ApplyHooks): Promise<ApplyResult> {
    const secrets: string[] = [];
    const root = input.envFileRoot ?? defaultEnvFileRoot();
    let envPath: string | undefined;
    try {
      validateCommand(command, input.arch);
      const restartFence = parseNativeRestartFence(command);
      if (input.lookup) {
        const bin = await input.lookup();
        if (!bin) {
          return failureResult(
            new PayloadRejected("container_runtime_not_installed", CONTAINER_RUNTIME_NOT_INSTALLED),
            secrets,
          );
        }
      }
      if (!input.client) {
        return failureResult(
          new PayloadRejected("container_runtime_not_installed", SOCKET_NOT_REACHABLE),
          secrets,
        );
      }
      let active = command;
      let payload =
        command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
          ? { ...(command.payload as Record<string, unknown>) }
          : {};
      let localImage = false;
      let buildSpec: PersonalBuildSpec | null = null;
      const pinnedImage = typeof payload.imageDigest === "string" ? payload.imageDigest.trim() : "";
      const pinnedDeploy = command.type === "deploy" && isPinnedManifestReference(pinnedImage);
      if (pinnedDeploy) {
        payload.imageDigest = pinnedImage;
        active = { ...command, payload };
        if (
          !UUID_TEXT.test(command.id) ||
          payload.commandId !== command.id ||
          payload.deploymentId !== command.deploymentId
        ) {
          throw new PayloadRejected(
            "invalid_input",
            "Pinned deploy command and payload identities must match.",
          );
        }
        const args = [
          "inspect",
          "--format",
          DEPLOY_RECEIPT_FORMAT,
          containerNameFor(command.deploymentId),
        ];
        assertSafeDockerArgs(args);
        const existing = await input.client.run(args);
        if (existing.exitCode !== 0) {
          if (
            !missingContainer(existing) &&
            !existing.stderr.toLowerCase().includes("no such object")
          ) {
            throw new PayloadRejected(
              "runtime_inspect_failed",
              "The existing container could not be inspected. Nothing was replaced.",
            );
          }
        } else {
          const receipt = readDeployReceipt(payload, existing.stdout);
          if (receipt === "applied")
            return {
              outcome: "applied",
              publicUrl: null,
              log: "This command's running container was already created. No runtime change was repeated. Readiness and HTTPS were not verified.",
            };
          if (receipt !== "new")
            throw new PayloadRejected(
              `deploy_replay_${receipt}`,
              "The previous command's container cannot be safely replayed. Nothing was restarted or replaced; inspect the runtime before issuing a new command.",
            );
        }
      }
      let envMap: Record<string, string> | null = null;
      const envRef = payload.environmentSecretRef;
      if (command.type === "apply_stack") {
        const containers = parseStackContainers(payload.containers);
        const wireguard = containers.find((entry) => entry.runtimeProfile);
        const endpoint = parseVpnEndpoint(payload.vpnEndpoint);
        const passwordHash = parseWireguardPasswordHash(payload.passwordHash);
        if (wireguard && endpoint && passwordHash) {
          envMap = wireguardRuntimeEnv(endpoint, passwordHash);
          for (const value of Object.values(envMap)) {
            if (value.length >= 4) secrets.push(value);
          }
        }
      }
      if (command.type === "deploy" && typeof envRef === "string" && envRef.length > 0) {
        if (pinnedDeploy) {
          envPath = runtimeEnvFilePath(root, command.id);
        } else if (input.redeemEnv) {
          envMap = await input.redeemEnv(command);
          for (const value of Object.values(envMap)) {
            if (value.length >= 4) secrets.push(value);
          }
          if (Object.keys(envMap).length > 0) envPath = runtimeEnvFilePath(root, command.id);
        }
      }
      if (envMap && Object.keys(envMap).length > 0 && !envPath) {
        envPath = runtimeEnvFilePath(root, command.id);
      }
      if (command.type === "deploy" && payload.gitBuild) {
        const stated = typeof payload.imageDigest === "string" ? payload.imageDigest.trim() : "";
        if (stated && !IMAGE_DIGEST.test(stated)) delete payload.imageDigest;
        const built = await buildFromGit({
          command,
          client: input.client,
          arch: input.arch,
          redeemGit: input.redeemGit,
          secrets,
          env: envMap ?? {},
          onPhase: hooks?.onPhase,
        });
        if (built.outcome === "failed") return built.result;
        payload = { ...payload, imageDigest: built.digest };
        delete payload.gitBuild;
        active = { ...command, payload };
        localImage = true;
        buildSpec = built.buildSpec;
      }
      const invocations = invocationsFor(active, envPath, root, localImage);
      let log = appliedLog(command, Boolean(envPath));
      if (localImage && typeof payload.imageDigest === "string") {
        log = `${log} Built image ${payload.imageDigest}.`;
        if (buildSpec) log = `${log} ${formatBuildProvenance(buildSpec)}`;
      }
      try {
        const wireguardProfile =
          command.type === "apply_stack" &&
          parseStackContainers(payload.containers).some((entry) => entry.runtimeProfile)
            ? WIREGUARD_ENDPOINT_PROFILE
            : undefined;
        for (let args of invocations) {
          assertSafeDockerArgs(args, { envFileRoot: root, runtimeProfile: wireguardProfile });
          if (args[0] === "pull") await hooks?.onPhase?.("pulling");
          if (args[0] === "rm" && pinnedDeploy && envPath) {
            if (!input.redeemEnv)
              throw new PayloadRejected(
                "environment_loader_unavailable",
                "Runtime variables could not be loaded. The previous container was kept.",
              );
            envMap = await input.redeemEnv(command);
            for (const value of Object.values(envMap)) {
              if (value.length >= 4) secrets.push(value);
            }
            await writeRuntimeEnvFile({ root, commandId: command.id, env: envMap });
          }
          let instance: string | null = null;
          if (args[0] === "rm" && pinnedDeploy) {
            const inspect = [
              "inspect",
              "--format",
              CONTAINER_INSTANCE_FORMAT,
              containerNameFor(command.deploymentId),
            ];
            assertSafeDockerArgs(inspect);
            const found = await input.client.run(inspect);
            if (found.exitCode === 0) {
              const id = found.stdout.trim();
              if (!/^[a-f0-9]{64}$/.test(id))
                throw new PayloadRejected(
                  "runtime_instance_invalid",
                  "The existing container instance could not be identified. Nothing was replaced.",
                );
              instance = id;
            } else if (
              !missingContainer(found) &&
              !found.stderr.toLowerCase().includes("no such object")
            ) {
              throw new PayloadRejected(
                "runtime_inspect_failed",
                "The existing container could not be inspected. Nothing was replaced.",
              );
            }
          }
          if ((args[0] === "rm" && pinnedDeploy) || (args[0] === "run" && !pinnedDeploy)) {
            await hooks?.onPhase?.("starting");
          }
          if (args[0] === "rm" && pinnedDeploy) {
            if (restartFence) {
              const inspect = [
                "inspect",
                "--format",
                RECOVERY_CONTAINER_OBSERVATION_FORMAT,
                containerNameFor(command.deploymentId),
              ];
              assertSafeDockerArgs(inspect);
              const snapshot = await input.client.run(inspect);
              assertNativeRestartSnapshot(
                command,
                restartFence,
                instance,
                snapshot.exitCode === 0 ? snapshot.stdout : "",
              );
            }
            if (!instance) continue;
            // Capture before the final admission hook; a delayed remove cannot hit
            // a newer container which subsequently reuses the deployment name.
            args = ["rm", "-f", instance];
            assertSafeDockerArgs(args);
          }
          if (args[0] === "run" && envPath && envMap && !pinnedDeploy) {
            await writeRuntimeEnvFile({ root, commandId: command.id, env: envMap });
          }
          const result = await input.client.run(args, { runtimeProfile: wireguardProfile });
          if (result.exitCode !== 0) {
            if (args[0] === "rm" && !args.includes("-v") && missingContainer(result)) continue;
            if (
              (args[0] === "volume" && args[1] === "create") ||
              (args[0] === "network" && args[1] === "create")
            ) {
              if (volumeAlreadyExists(result)) continue;
            }
            return failureResult(
              new PayloadRejected(
                "apply_failed",
                `Container command failed (${result.exitCode}). ${result.stderr || result.stdout}`,
              ),
              secrets,
            );
          }
          if (
            (args[0] === "manifest" || (args[0] === "image" && args[1] === "inspect")) &&
            !manifestMatchesArch(result.stdout, input.arch)
          ) {
            return {
              outcome: "failed",
              publicUrl: null,
              code: "image_arch_mismatch",
              log: redactSecrets(
                `The image manifest has no linux/${input.arch} platform. The image was not pulled and no container was started.`,
                secrets,
              ),
            };
          }
          if (command.type === "fetch_logs" && (result.stdout || result.stderr)) {
            // `docker logs` replays the app's stdout on stdout and its stderr on stderr, and a
            // crash trace is on stderr. Keep both, and keep the end: that is where a crash is.
            const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
            log = redactSecrets(output.slice(-4000), secrets);
          }
          if (
            args[0] === "inspect" &&
            args[2] === "{{.State.Status}}" &&
            result.stdout.trim() !== "running"
          ) {
            return failureResult(
              new PayloadRejected(
                "container_not_running",
                "The pinned-image container did not remain running after start. Readiness and public HTTPS were not verified.",
              ),
              secrets,
            );
          }
        }
      } finally {
        if (envPath) await removeRuntimeEnvFile(envPath, root);
      }
      if (command.type === "apply_stack") keepPortRelay(payload);
      const report = buildSpec ? buildReportFromSpec(buildSpec) : null;
      return {
        outcome: "applied",
        publicUrl: null,
        log: redactSecrets(log, secrets),
        ...(report ? { buildReport: report } : {}),
      };
    } catch (error) {
      if (envPath) await removeRuntimeEnvFile(envPath, root);
      return failureResult(error, secrets);
    }
  }

  return {
    async apply(command: AgentCommand, hooks?: ApplyHooks): Promise<ApplyResult> {
      const existing = runs.get(command.id);
      if (existing) return existing;
      const pending = execute(command, hooks);
      runs.set(command.id, pending);
      return pending;
    },
  };
}

/** Docker runs only when the env flag is on. A missing binary is not installed. */
export function selectExecutor(input: {
  dockerEnabled: boolean;
  socketReachable: boolean;
  arch: NodeArch;
  docker?: DockerClient;
  tunnels?: CommandExecutor;
  lookup?: () => Promise<string | null>;
  redeemEnv?: (command: AgentCommand) => Promise<Record<string, string>>;
  redeemGit?: (command: AgentCommand) => Promise<GitCredential>;
  envFileRoot?: string;
}): CommandExecutor {
  const inner = input.dockerEnabled
    ? createDockerExecutor({
        client: input.docker,
        arch: input.arch,
        lookup:
          input.lookup ?? (input.docker && input.socketReachable ? undefined : async () => null),
        redeemEnv: input.redeemEnv,
        redeemGit: input.redeemGit,
        envFileRoot: input.envFileRoot,
      })
    : createValidatingExecutor(input.arch);
  const tunnels = input.tunnels;
  if (!tunnels) return inner;
  return {
    async apply(command, hooks) {
      if (command.type === "apply_route" || command.type === "stop_route") {
        return tunnels.apply(command, hooks);
      }
      return inner.apply(command, hooks);
    },
  };
}

export async function probeDockerSocket(socketPath: string): Promise<boolean> {
  if (!path.isAbsolute(socketPath) || socketPath.includes("..")) return false;
  try {
    const info = await stat(socketPath);
    return info.isSocket();
  } catch {
    return false;
  }
}

/** PATH lookup for an executable named docker. Does not download one. */
export async function findDocker(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    if (!path.isAbsolute(dir) || dir.includes("..")) continue;
    const candidate = path.join(dir, "docker");
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
 * Spawns `docker` with `shell: false`. Not used to reach a daemon in unit tests.
 * A missing binary rejects with container_runtime_not_installed.
 */
export function createProcessDockerClient(input: {
  socketPath: string;
  bin?: string;
  envFileRoot?: string;
}): DockerClient {
  const bin = input.bin ?? "docker";
  return {
    run(args: string[], options?: { runtimeProfile?: typeof WIREGUARD_ENDPOINT_PROFILE }) {
      try {
        assertSafeDockerArgs(args, {
          envFileRoot: input.envFileRoot ?? defaultEnvFileRoot(),
          runtimeProfile: options?.runtimeProfile,
        });
      } catch (error) {
        return Promise.reject(error);
      }
      if (!path.isAbsolute(input.socketPath) || input.socketPath.includes("..")) {
        return Promise.reject(
          new PayloadRejected("invalid_input", "Docker socket path is not absolute."),
        );
      }
      const env = { ...process.env };
      delete env.DOCKER_TLS_VERIFY;
      delete env.DOCKER_CERT_PATH;
      delete env.IMEMORY_PERSONAL_NODE_CODE;
      delete env.IMEMORY_PERSONAL_NODE_SESSION_ID;
      delete env.CLOUDFLARE_TUNNEL_TOKEN;
      delete env.CLOUDFLARE_API_TOKEN;
      delete env.TUNNEL_TOKEN;
      env.DOCKER_BUILDKIT = "1";
      env.DOCKER_HOST = `unix://${input.socketPath}`;
      return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
        let settled = false;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdout.reduce((sum, part) => sum + part.length, 0) < 64_000) stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.reduce((sum, part) => sum + part.length, 0) < 64_000) stderr.push(chunk);
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          if (error.code === "ENOENT") {
            reject(
              new PayloadRejected(
                "container_runtime_not_installed",
                CONTAINER_RUNTIME_NOT_INSTALLED,
              ),
            );
            return;
          }
          reject(error);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
    },
  };
}
