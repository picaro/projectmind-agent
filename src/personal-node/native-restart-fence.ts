import { isPinnedManifestReference } from "./image-reference.ts";
import { PayloadRejected } from "./validate.ts";
import { parseRecoveryContainerObservation } from "./runtime-observation.ts";
import type { AgentCommand } from "./types.ts";
export type NativeRestartFence = {
  protocol: "native-restart-v1";
  containerId: string;
  receiptCommandId: string;
  imageConfigDigest: string;
  restartCount: number;
  failure: "crashed" | "unhealthy";
};
const keys = new Set([
  "protocol",
  "containerId",
  "receiptCommandId",
  "imageConfigDigest",
  "restartCount",
  "failure",
]);
function deny(): never {
  throw new PayloadRejected(
    "native_restart_precondition_failed",
    "Automatic restart preconditions changed or are unavailable. Nothing was replaced.",
  );
}
/** Optional only for legacy/manual deploys. A present invalid fence never downgrades. */
export function parseNativeRestartFence(command: AgentCommand): NativeRestartFence | null {
  const payload = command.payload as Record<string, unknown> | null;
  if (!payload || !Object.hasOwn(payload, "nativeRestartFence")) return null;
  const value = payload.nativeRestartFence;
  if (!value || typeof value !== "object" || Array.isArray(value)) deny();
  const row = value as Record<string, unknown>;
  if (
    command.type !== "deploy" ||
    !isPinnedManifestReference(payload.imageDigest) ||
    payload.gitBuild != null ||
    payload.commandAdmission !== "v2" ||
    payload.commandExecutionSession !== "v1" ||
    Object.keys(row).some((key) => !keys.has(key)) ||
    row.protocol !== "native-restart-v1" ||
    typeof row.containerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.containerId) ||
    typeof row.receiptCommandId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.receiptCommandId) ||
    row.receiptCommandId === command.id ||
    typeof row.imageConfigDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row.imageConfigDigest) ||
    typeof row.restartCount !== "number" ||
    !Number.isInteger(row.restartCount) ||
    row.restartCount < 0 ||
    row.restartCount > 1000000 ||
    typeof row.failure !== "string" ||
    !["crashed", "unhealthy"].includes(row.failure)
  )
    deny();
  return row as NativeRestartFence;
}
/** Called after final server admission and native instance capture, before rm.
 * This is an additional runtime guard, never approval or outcome verification. */
export function assertNativeRestartSnapshot(
  command: AgentCommand,
  fence: NativeRestartFence,
  instance: string | null,
  output: string,
) {
  const report = parseRecoveryContainerObservation(command.deploymentId, output),
    native = report?.recovery;
  if (
    !native ||
    !instance ||
    native.containerId !== instance ||
    instance !== fence.containerId ||
    native.receiptCommandId !== fence.receiptCommandId ||
    report?.imageReference !== (command.payload as Record<string, unknown>).imageDigest ||
    report?.imageConfigDigest !== fence.imageConfigDigest ||
    native.restartPolicy !== "no" ||
    native.maximumRetryCount !== 0 ||
    native.restartCount !== fence.restartCount ||
    (fence.failure === "crashed"
      ? report.status !== "exited"
      : report.status !== "running" || report.healthStatus !== "unhealthy")
  )
    deny();
}
