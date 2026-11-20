import { createHash } from "node:crypto";
import { PayloadRejected } from "./validate.ts";

const COMMAND_LABEL = "io.projectmind.deploy-command";
const SPEC_LABEL = "io.projectmind.deploy-spec";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const DEPLOY_RECEIPT_FORMAT = `{{ index .Config.Labels "${COMMAND_LABEL}" }}|{{ index .Config.Labels "${SPEC_LABEL}" }}|{{.Config.Image}}|{{.State.Status}}`;
const SPEC_KEYS = [
  "commandId",
  "deploymentId",
  "revision",
  "imageDigest",
  "declaredPlatform",
  "containerPort",
  "hostPort",
  "resourceLimits",
  "volumeSpecs",
  "healthCheck",
  "environmentSecretRef",
];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]);
  return value ?? null;
}
function fingerprint(payload: Record<string, unknown>): string {
  const keys = Object.hasOwn(payload, "nativeRestartFence")
    ? [...SPEC_KEYS, "nativeRestartFence"]
    : SPEC_KEYS;
  return createHash("sha256")
    .update(JSON.stringify(keys.map((key) => [key, canonical(payload[key])])))
    .digest("hex");
}
export function deployReceiptLabels(payload: Record<string, unknown>): string[] {
  if (typeof payload.commandId !== "string" || !UUID.test(payload.commandId)) {
    throw new PayloadRejected("invalid_input", "Pinned deploys require a valid command identity.");
  }
  return [`${COMMAND_LABEL}=${payload.commandId}`, `${SPEC_LABEL}=${fingerprint(payload)}`];
}
export function validDeployReceiptLabels(labels: string[]): boolean {
  const command = labels.find((label) => label.startsWith(`${COMMAND_LABEL}=`));
  const spec = labels.find((label) => label.startsWith(`${SPEC_LABEL}=`));
  return (
    labels.length === 2 &&
    Boolean(
      command &&
      spec &&
      UUID.test(command.slice(COMMAND_LABEL.length + 1)) &&
      /^[a-f0-9]{64}$/.test(spec.slice(SPEC_LABEL.length + 1)),
    )
  );
}
export function readDeployReceipt(
  payload: Record<string, unknown>,
  output: string,
): "new" | "applied" | "stopped" | "conflict" | "invalid" {
  if (output.length > 1024 || /[\r\n]/.test(output.trim())) return "invalid";
  const fields = output.trim().split("|");
  const [commandId, spec, image, state] = fields;
  if (
    fields.length !== 4 ||
    !["running", "exited", "created", "paused", "restarting", "removing", "dead"].includes(
      state ?? "",
    )
  )
    return "invalid";
  if (commandId !== payload.commandId) return "new";
  if (spec !== fingerprint(payload) || image !== payload.imageDigest) return "conflict";
  return state === "running" ? "applied" : "stopped";
}
