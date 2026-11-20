import { isPinnedManifestReference } from "./image-reference.ts";
import type { DockerRecoveryObservation, HeartbeatReport } from "./types.ts";

type Observation = NonNullable<HeartbeatReport["containers"]>[number];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CONFIG_DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEALTH = new Set(["healthy", "unhealthy", "starting", "not_configured", "unknown"]);

const RECOVERY_KEYS = new Set([
  "protocol",
  "containerId",
  "receiptCommandId",
  "restartPolicy",
  "maximumRetryCount",
  "restartCount",
  "inspectedAt",
]);
const RESTART_POLICIES = new Set(["no", "always", "unless-stopped", "on-failure"]);
const boundedInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
/** Fixed metadata only; absent or malformed provider policy never defaults to no policy. */
export function sanitizeRecoveryObservation(value: unknown): DockerRecoveryObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !RECOVERY_KEYS.has(key)) ||
    row.protocol !== "docker-recovery-v1" ||
    typeof row.containerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.containerId) ||
    typeof row.receiptCommandId !== "string" ||
    !UUID.test(row.receiptCommandId.toLowerCase()) ||
    typeof row.restartPolicy !== "string" ||
    !RESTART_POLICIES.has(row.restartPolicy) ||
    !boundedInteger(row.maximumRetryCount) ||
    !boundedInteger(row.restartCount) ||
    (row.restartPolicy !== "on-failure" && row.maximumRetryCount !== 0) ||
    typeof row.inspectedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.inspectedAt) ||
    !Number.isFinite(Date.parse(row.inspectedAt)) ||
    new Date(row.inspectedAt).toISOString() !== row.inspectedAt
  )
    return null;
  return {
    protocol: "docker-recovery-v1",
    containerId: row.containerId,
    receiptCommandId: row.receiptCommandId.toLowerCase(),
    restartPolicy: row.restartPolicy as DockerRecoveryObservation["restartPolicy"],
    maximumRetryCount: row.maximumRetryCount,
    restartCount: row.restartCount,
    inspectedAt: row.inspectedAt,
  };
}

/** Never forward raw Docker data, arbitrary fields, mutable tags or malformed IDs. */
export function sanitizeRuntimeObservation(input: unknown): Observation | null {
  if (!input || typeof input !== "object") return null;
  const entry = input as Record<string, unknown>;
  if (
    typeof entry.deploymentId !== "string" ||
    !UUID.test(entry.deploymentId) ||
    typeof entry.status !== "string" ||
    !["running", "exited", "missing"].includes(entry.status)
  )
    return null;
  const observation: Observation = {
    deploymentId: entry.deploymentId,
    status: entry.status as Observation["status"],
  };
  if (entry.status !== "missing") {
    observation.healthStatus =
      typeof entry.healthStatus === "string" && HEALTH.has(entry.healthStatus)
        ? (entry.healthStatus as Observation["healthStatus"])
        : "unknown";
    if (entry.status !== "running" && observation.healthStatus === "healthy") {
      observation.healthStatus = "unknown";
    }
    if (
      isPinnedManifestReference(entry.imageReference) &&
      typeof entry.imageConfigDigest === "string" &&
      CONFIG_DIGEST.test(entry.imageConfigDigest)
    ) {
      observation.imageReference = entry.imageReference;
      observation.imageConfigDigest = entry.imageConfigDigest;
      const recovery = sanitizeRecoveryObservation(entry.recovery);
      if (recovery) observation.recovery = recovery;
    }
  }
  return observation;
}

/** The fixed projection excludes env vars, labels, mounts and other containers. */
export const CONTAINER_OBSERVATION_FORMAT =
  "{{.State.Status}}|{{.Image}}|{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}not_configured{{end}}";

export function parseContainerObservation(
  deploymentId: string,
  output: string,
): Observation | null {
  if (output.length > 1024 || /[\r\n]/.test(output.trim())) return null;
  const fields = output.trim().split("|");
  if (fields.length !== 4) return null;
  const [runtime, imageConfigDigest, imageReference, healthStatus] = fields;
  if (
    !runtime ||
    !["running", "exited", "created", "paused", "restarting", "removing", "dead"].includes(runtime)
  )
    return null;
  return sanitizeRuntimeObservation({
    deploymentId,
    status: runtime === "running" ? "running" : "exited",
    imageConfigDigest,
    imageReference,
    healthStatus,
  });
}

/** Only this specific receipt label is read; full labels/env/mounts are never projected. */
export const RECOVERY_CONTAINER_OBSERVATION_FORMAT = `{"status":{{json .State.Status}},"imageConfigDigest":{{json .Image}},"imageReference":{{json .Config.Image}},"healthStatus":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"not_configured"{{end}},"recovery":{"protocol":"docker-recovery-v1","containerId":{{json .ID}},"receiptCommandId":{{json (index .Config.Labels "io.projectmind.deploy-command")}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"maximumRetryCount":{{.HostConfig.RestartPolicy.MaximumRetryCount}},"restartCount":{{.RestartCount}}}}`;
export function parseRecoveryContainerObservation(
  deploymentId: string,
  output: string,
  now = new Date(),
): Observation | null {
  if (!output.trim().startsWith("{")) return parseContainerObservation(deploymentId, output);
  if (output.length > 2048) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>,
    runtime = row.status;
  if (
    typeof runtime !== "string" ||
    !["running", "exited", "created", "paused", "restarting", "removing", "dead"].includes(runtime)
  )
    return null;
  const recovery =
    (runtime === "running" || runtime === "exited") &&
    Number.isFinite(now.getTime()) &&
    row.recovery &&
    typeof row.recovery === "object" &&
    !Array.isArray(row.recovery)
      ? { ...row.recovery, inspectedAt: now.toISOString() }
      : undefined;
  return sanitizeRuntimeObservation({
    ...row,
    deploymentId,
    status: runtime === "running" ? "running" : "exited",
    recovery,
  });
}
