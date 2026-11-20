import type { AgentCommand, NodeArch } from "./types.ts";
import { assertApplyStack } from "./stack.ts";
import { isPinnedManifestReference } from "./image-reference.ts";

export const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const VOLUME_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SECRET_REF = /^hosting-env:[0-9a-f-]{36}:runtime$/i;

const FORBIDDEN_KEYS = new Set([
  "privileged",
  "privilegedmode",
  "hostnetwork",
  "hostpid",
  "pidmode",
  "networkmode",
  "capadd",
  "securityopt",
  "devices",
  "extrahosts",
  "binds",
  "hostpath",
  "volumesfrom",
  "command",
  "cmd",
  "shell",
  "entrypoint",
  "args",
  "dockersock",
  "docker",
  "hostconfig",
  "cgroupns",
  "pid",
  "ipc",
  "uts",
  "env",
  "environment",
  "envfile",
  "envfilepath",
  "cloudflareapitoken",
  "cloudflaretunneltoken",
  "secrets",
  "secretvalues",
  "dotenv",
  "host",
  "hostheader",
  "xforwardedhost",
  "forwardedhost",
  "originrequest",
  "httphostheader",
  "servername",
  "targethost",
  "upstreamhost",
  "proxyhost",
  "bindaddress",
  "listenaddress",
  "publicport",
  "ingressport",
  "inbound",
  "listen",
  "dockerargs",
  "extraargs",
  "publish",
  "publishall",
  "portbindings",
]);

const ALLOWED_TYPES = new Set([
  "deploy",
  "apply_stack",
  "start",
  "stop",
  "restart",
  "remove",
  "fetch_logs",
  "apply_route",
  "stop_route",
  "export_volume",
  "export_database",
  "import_volume",
  "import_database",
]);

/** Cloudflare tunnel connector token. Not the API token. No shell metacharacters. */
export const CLOUDFLARE_CONNECTOR_TOKEN = /^[A-Za-z0-9+/=_-]{20,4096}$/;

export class PayloadRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PayloadRejected";
    this.code = code;
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function rejectString(value: string): void {
  const lower = value.toLowerCase();
  if (
    lower.includes("docker.sock") ||
    lower.includes("..") ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    /host\s*:/i.test(value)
  ) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "Command payloads cannot include docker.sock, path traversal, a host mount, or a host-header injection.",
    );
  }
}

/** Reject privileged, host namespace, shell, and host-mount fields anywhere in the body. */
export function assertDeclarativePayload(value: unknown): void {
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      rejectString(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      const normalized = normalizeKey(key);
      if (FORBIDDEN_KEYS.has(normalized)) {
        throw new PayloadRejected(
          "forbidden_command_field",
          `Command field "${key}" is not allowed. Personal nodes accept a declarative payload only.`,
        );
      }
      if (
        (normalized === "network" || normalized === "networkmode" || normalized === "pidmode") &&
        typeof child === "string" &&
        child.toLowerCase() === "host"
      ) {
        throw new PayloadRejected(
          "forbidden_command_field",
          "Host network and host PID are not allowed on a personal node.",
        );
      }
      visit(child);
    }
  };
  visit(value);
}

export function expectedPlatform(arch: NodeArch): "linux/arm64" | "linux/amd64" | null {
  if (arch === "arm64") return "linux/arm64";
  if (arch === "amd64") return "linux/amd64";
  return null;
}

function assertDigest(value: unknown): string {
  if (
    typeof value !== "string" ||
    (!IMAGE_DIGEST.test(value.trim()) && !isPinnedManifestReference(value.trim()))
  ) {
    throw new PayloadRejected(
      "image_digest_required",
      "Image reference must be a sha256 digest or a complete registry/repository@sha256 manifest address. Mutable tags, credentials and IP literals are rejected.",
    );
  }
  return value.trim();
}

function assertPlatform(declared: unknown, arch: NodeArch): "linux/arm64" | "linux/amd64" {
  const expected = expectedPlatform(arch);
  if (!expected) {
    throw new PayloadRejected(
      "arch_unknown",
      `This computer reports architecture "${arch}". Set it to arm64 or amd64 before deploying.`,
    );
  }
  if (typeof declared !== "string" || declared !== expected) {
    throw new PayloadRejected(
      "arch_mismatch",
      `This image declares ${typeof declared === "string" && declared ? declared : "(empty)"}, but the computer is ${arch} and needs ${expected}.`,
    );
  }
  return expected;
}

export function assertVolumes(value: unknown): Array<{ name: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PayloadRejected("invalid_input", "volumeSpecs must be a list of named volumes.");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PayloadRejected("invalid_input", "Each volume must be a named volume.");
    }
    const keys = Object.keys(entry as object);
    const record = entry as Record<string, unknown>;
    if (keys.length !== 1 || keys[0] !== "name" || typeof record.name !== "string") {
      throw new PayloadRejected(
        "forbidden_command_field",
        "Volumes must be named volumes ({ name } only). Host paths and binds are rejected.",
      );
    }
    if (!VOLUME_NAME.test(record.name)) {
      throw new PayloadRejected(
        "invalid_input",
        "Volume names must be lowercase letters, numbers, '_' or '-', and must not be a path.",
      );
    }
    return { name: record.name };
  });
}

const HEALTH_PATH = /^\/[A-Za-z0-9._~/-]{0,128}$/;

function assertHealth(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PayloadRejected("invalid_input", "healthCheck must be { path }.");
  }
  const keys = Object.keys(value as object);
  const path = (value as { path?: unknown }).path;
  if (keys.length !== 1 || keys[0] !== "path") {
    throw new PayloadRejected(
      "forbidden_command_field",
      "healthCheck accepts a URL path only. A shell command is rejected.",
    );
  }
  if (typeof path !== "string" || !HEALTH_PATH.test(path) || path.includes("..")) {
    throw new PayloadRejected(
      "invalid_input",
      "Health check path must be a URL path such as /health, not a filesystem path or a shell command.",
    );
  }
}

const GIT_BUILD_KEYS = new Set([
  "repositoryUrl",
  "ref",
  "buildPack",
  "baseDirectory",
  "gitSecretRef",
]);
const GIT_PACKS = new Set(["nixpacks", "dockerfile", "static", "railpack"]);
const GIT_REF = /^[A-Za-z0-9._/-]{1,128}$/;
const GIT_URL = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~+-]+)+$/;
const GIT_SECRET_REF = /^hosting-git:[0-9a-f-]{36}:clone$/i;

function assertGitBuild(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PayloadRejected("invalid_input", "gitBuild must be an object.");
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!GIT_BUILD_KEYS.has(key)) {
      throw new PayloadRejected(
        "forbidden_command_field",
        `gitBuild field "${key}" is not allowed.`,
      );
    }
  }
  if (
    typeof body.repositoryUrl !== "string" ||
    !GIT_URL.test(body.repositoryUrl) ||
    body.repositoryUrl.includes("@")
  ) {
    throw new PayloadRejected(
      "invalid_input",
      "gitBuild.repositoryUrl must be an https clone URL without credentials.",
    );
  }
  if (typeof body.ref !== "string" || !GIT_REF.test(body.ref) || body.ref.includes("..")) {
    throw new PayloadRejected("invalid_input", "gitBuild.ref must be a commit or branch.");
  }
  if (typeof body.buildPack !== "string" || !GIT_PACKS.has(body.buildPack)) {
    throw new PayloadRejected(
      "invalid_input",
      "gitBuild.buildPack must be nixpacks, dockerfile, static, or railpack.",
    );
  }
  if (
    typeof body.baseDirectory !== "string" ||
    body.baseDirectory.includes("..") ||
    !/^(?:\.|[A-Za-z0-9._/-]{1,128})$/.test(body.baseDirectory)
  ) {
    throw new PayloadRejected(
      "invalid_input",
      "gitBuild.baseDirectory must be a relative directory.",
    );
  }
  if (body.gitSecretRef !== undefined && body.gitSecretRef !== null && body.gitSecretRef !== "") {
    if (typeof body.gitSecretRef !== "string" || !GIT_SECRET_REF.test(body.gitSecretRef)) {
      throw new PayloadRejected(
        "invalid_secret_ref",
        "gitSecretRef must be a server-issued hosting-git reference. Raw git credentials are rejected.",
      );
    }
  }
}

function assertDeploy(payload: Record<string, unknown>, arch: NodeArch): void {
  const hasGit = payload.gitBuild !== undefined && payload.gitBuild !== null;
  if (hasGit) {
    const stated = typeof payload.imageDigest === "string" ? payload.imageDigest.trim() : "";
    // A tag or registry name is not a pullable image. Ignore it and build.
    // A real sha256 digest must not ride along: the build records its own.
    if (stated && (IMAGE_DIGEST.test(stated) || isPinnedManifestReference(stated))) {
      throw new PayloadRejected(
        "invalid_input",
        "A git build does not include an image digest. The computer records the digest docker build produces.",
      );
    }
    assertGitBuild(payload.gitBuild);
  } else {
    assertDigest(payload.imageDigest);
  }
  assertPlatform(payload.declaredPlatform, arch);
  if (
    typeof payload.containerPort !== "number" ||
    !Number.isInteger(payload.containerPort) ||
    payload.containerPort < 1 ||
    payload.containerPort > 65535
  ) {
    throw new PayloadRejected("invalid_input", "containerPort must be an integer from 1 to 65535.");
  }
  if (payload.hostPort !== undefined && payload.hostPort !== null) {
    if (
      typeof payload.hostPort !== "number" ||
      !Number.isInteger(payload.hostPort) ||
      payload.hostPort < 1 ||
      payload.hostPort > 65535
    ) {
      throw new PayloadRejected("invalid_input", "hostPort must be an integer from 1 to 65535.");
    }
  }
  if (
    payload.environmentSecretRef !== undefined &&
    payload.environmentSecretRef !== null &&
    payload.environmentSecretRef !== ""
  ) {
    if (
      typeof payload.environmentSecretRef !== "string" ||
      !SECRET_REF.test(payload.environmentSecretRef)
    ) {
      throw new PayloadRejected(
        "invalid_secret_ref",
        "environmentSecretRef must be a server-issued hosting-env reference. Raw environment values are rejected.",
      );
    }
  }
  assertVolumes(payload.volumeSpecs);
  assertHealth(payload.healthCheck);
  const limits = payload.resourceLimits;
  if (limits !== undefined) {
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
      throw new PayloadRejected("invalid_input", "resourceLimits must be an object.");
    }
    const record = limits as Record<string, unknown>;
    if (record.cpuMillis !== undefined) {
      if (
        typeof record.cpuMillis !== "number" ||
        !Number.isInteger(record.cpuMillis) ||
        record.cpuMillis < 1 ||
        record.cpuMillis > 8_000
      ) {
        throw new PayloadRejected("invalid_input", "cpuMillis must be an integer from 1 to 8000.");
      }
    }
    if (record.memoryBytes !== undefined) {
      const max = 16 * 1024 * 1024 * 1024;
      if (
        typeof record.memoryBytes !== "number" ||
        !Number.isInteger(record.memoryBytes) ||
        record.memoryBytes < 1 ||
        record.memoryBytes > max
      ) {
        throw new PayloadRejected(
          "invalid_input",
          "memoryBytes must be an integer from 1 to 16 GiB.",
        );
      }
    }
    if (record.cpu !== undefined) {
      if (
        typeof record.cpu !== "number" ||
        !Number.isFinite(record.cpu) ||
        record.cpu < 0.1 ||
        record.cpu > 8
      ) {
        throw new PayloadRejected("invalid_input", "cpu must be a number from 0.1 to 8.");
      }
    }
    if (record.memoryMb !== undefined) {
      if (
        typeof record.memoryMb !== "number" ||
        !Number.isInteger(record.memoryMb) ||
        record.memoryMb < 1 ||
        record.memoryMb > 16 * 1024
      ) {
        throw new PayloadRejected("invalid_input", "memoryMb must be an integer from 1 to 16384.");
      }
    }
  }
}

/**
 * True only when the server explicitly asked to delete named volumes.
 * A missing flag, or preserveVolumes still true, keeps volumes.
 */
export function shouldDeleteVolumes(payload: Record<string, unknown>): boolean {
  if (payload.preserveVolumes !== false) return false;
  return payload.deleteVolumes === true;
}

export function volumeNamesFromPayload(payload: Record<string, unknown>): string[] {
  if (Array.isArray(payload.volumeSpecs)) {
    return assertVolumes(payload.volumeSpecs).map((entry) => entry.name);
  }
  if (payload.volumeNames === undefined) return [];
  if (!Array.isArray(payload.volumeNames)) {
    throw new PayloadRejected("invalid_input", "volumeNames must be a list of volume names.");
  }
  return payload.volumeNames.map((name) => {
    if (typeof name !== "string" || !VOLUME_NAME.test(name)) {
      throw new PayloadRejected(
        "invalid_input",
        "Volume names must be lowercase letters, numbers, '_' or '-', and must not be a path.",
      );
    }
    return name;
  });
}

const ROUTE_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TUNNEL_REF = /^cloudflare-tunnel:[A-Za-z0-9_-]{1,64}$/;

function assertApplyRoute(payload: Record<string, unknown>): void {
  const allowed = new Set([
    "commandId",
    "deploymentId",
    "revision",
    "hostname",
    "containerPort",
    "hostPort",
    "ingress",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new PayloadRejected(
        "forbidden_command_field",
        `Route command field "${key}" is not allowed.`,
      );
    }
  }
  if (typeof payload.hostname !== "string" || !ROUTE_HOSTNAME.test(payload.hostname)) {
    throw new PayloadRejected(
      "invalid_input",
      "Route hostname must be a DNS name without a scheme, port, or host header.",
    );
  }
  if (
    typeof payload.containerPort !== "number" ||
    !Number.isInteger(payload.containerPort) ||
    payload.containerPort < 1 ||
    payload.containerPort > 65535
  ) {
    throw new PayloadRejected(
      "invalid_target_port",
      "containerPort must be an integer from 1 to 65535.",
    );
  }
  if (!payload.ingress || typeof payload.ingress !== "object" || Array.isArray(payload.ingress)) {
    throw new PayloadRejected("invalid_input", "Route ingress must be an object.");
  }
  const ingress = payload.ingress as Record<string, unknown>;
  const allowedIngress = new Set([
    "mode",
    "provider",
    "localAddress",
    "localPort",
    "tunnelRef",
    "connectorToken",
  ]);
  for (const key of Object.keys(ingress)) {
    if (!allowedIngress.has(key)) {
      throw new PayloadRejected(
        "forbidden_command_field",
        `Route ingress field "${key}" is not allowed.`,
      );
    }
  }
  if (ingress.mode !== "outbound") {
    throw new PayloadRejected(
      "inbound_tunnel_rejected",
      "Personal-node ingress is outbound only. Inbound listeners are rejected.",
    );
  }
  if (ingress.localAddress !== "127.0.0.1") {
    throw new PayloadRejected("invalid_target_port", "The tunnel may target 127.0.0.1 only.");
  }
  const hostPort = payload.hostPort;
  const tunnelPort = hostPort === undefined || hostPort === null ? payload.containerPort : hostPort;
  if (ingress.localPort !== tunnelPort) {
    throw new PayloadRejected(
      "invalid_target_port",
      hostPort === undefined || hostPort === null
        ? "localPort must equal containerPort."
        : "localPort must equal hostPort.",
    );
  }
  if (ingress.provider !== "local_dev" && ingress.provider !== "cloudflare_tunnel") {
    throw new PayloadRejected(
      "invalid_input",
      "Route provider must be local_dev or cloudflare_tunnel.",
    );
  }
  if (ingress.tunnelRef !== undefined && ingress.tunnelRef !== null) {
    if (typeof ingress.tunnelRef !== "string" || !TUNNEL_REF.test(ingress.tunnelRef)) {
      throw new PayloadRejected(
        "forbidden_command_field",
        "tunnelRef must be a cloudflare-tunnel id reference. Tokens and host headers are rejected.",
      );
    }
  }
  if (ingress.connectorToken !== undefined && ingress.connectorToken !== null) {
    if (
      typeof ingress.connectorToken !== "string" ||
      !CLOUDFLARE_CONNECTOR_TOKEN.test(ingress.connectorToken)
    ) {
      throw new PayloadRejected(
        "invalid_input",
        "connectorToken must be a Cloudflare tunnel connector token. Shell text, host headers, and extra arguments are rejected.",
      );
    }
    if (ingress.provider !== "cloudflare_tunnel") {
      throw new PayloadRejected(
        "forbidden_command_field",
        "A connector token is only valid for a cloudflare_tunnel route.",
      );
    }
  }
}

const STOP_ROUTE_KEYS = new Set(["commandId", "deploymentId", "revision", "tunnelRef"]);

function assertStopRoute(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!STOP_ROUTE_KEYS.has(key)) {
      throw new PayloadRejected(
        "forbidden_command_field",
        `Stop route field "${key}" is not allowed.`,
      );
    }
  }
  if (payload.tunnelRef !== undefined && payload.tunnelRef !== null) {
    if (typeof payload.tunnelRef !== "string" || !TUNNEL_REF.test(payload.tunnelRef)) {
      throw new PayloadRejected(
        "forbidden_command_field",
        "tunnelRef must be a cloudflare-tunnel id reference. Tokens and host headers are rejected.",
      );
    }
  }
}

const EXPORT_KEYS = new Set([
  "commandId",
  "installationId",
  "volumeName",
  "engine",
  "uploadUrl",
  "sha256Hex",
]);

function assertExportPayload(payload: Record<string, unknown>, kind: "volume" | "database"): void {
  for (const key of Object.keys(payload)) {
    if (!EXPORT_KEYS.has(key)) {
      throw new PayloadRejected("forbidden_command_field", `Export field "${key}" is not allowed.`);
    }
  }
  const installationId =
    typeof payload.installationId === "string" ? payload.installationId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(installationId)) {
    throw new PayloadRejected("invalid_input", "installationId must be a UUID.");
  }
  const uploadUrl = typeof payload.uploadUrl === "string" ? payload.uploadUrl.trim() : "";
  if (!uploadUrl.startsWith("https://")) {
    throw new PayloadRejected("invalid_input", "uploadUrl must be https.");
  }
  if (kind === "volume") {
    const volumeName = typeof payload.volumeName === "string" ? payload.volumeName.trim() : "";
    if (!VOLUME_NAME.test(volumeName)) {
      throw new PayloadRejected("invalid_input", "volumeName must be a named volume.");
    }
  } else {
    const engine = typeof payload.engine === "string" ? payload.engine : "";
    if (!["postgresql", "redis", "mongodb"].includes(engine)) {
      throw new PayloadRejected("invalid_input", "engine must be postgresql, redis, or mongodb.");
    }
  }
}

export function validateCommand(
  command: Pick<AgentCommand, "type" | "payload">,
  arch: NodeArch,
): void {
  if (!ALLOWED_TYPES.has(command.type)) {
    throw new PayloadRejected(
      "invalid_input",
      `Command type "${command.type}" is not allowlisted.`,
    );
  }
  assertDeclarativePayload(command.payload);
  if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) {
    throw new PayloadRejected("invalid_input", "Command payload must be an object.");
  }
  const payload = command.payload as Record<string, unknown>;
  if (command.type === "deploy") assertDeploy(payload, arch);
  if (command.type === "apply_stack") assertApplyStack(payload);
  if (command.type === "export_volume") assertExportPayload(payload, "volume");
  if (command.type === "export_database") assertExportPayload(payload, "database");
  if (command.type === "import_volume") assertExportPayload(payload, "volume");
  if (command.type === "import_database") assertExportPayload(payload, "database");
  if (command.type === "apply_route") assertApplyRoute(payload);
  if (command.type === "stop_route") assertStopRoute(payload);
  if (command.type === "remove") {
    if (
      payload.deleteVolumes !== undefined &&
      payload.deleteVolumes !== true &&
      payload.deleteVolumes !== false
    ) {
      throw new PayloadRejected("invalid_input", "deleteVolumes must be a boolean when present.");
    }
    volumeNamesFromPayload(payload);
  }
}
