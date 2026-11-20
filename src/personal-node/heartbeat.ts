import os from "node:os";

import { selectLanAddress, type LanNic } from "./lan-address.ts";
import { sanitizeRuntimeObservation } from "./runtime-observation.ts";
import { AGENT_VERSION, type HeartbeatReport, type NodeArch } from "./types.ts";

/**
 * Report runtime and the connector process honestly.
 * `tunnelUp` is true only while a cloudflared child is still running.
 * A connector token, by itself, is not a running tunnel.
 * `available` is the stored component status. It is not the string `connected`
 * and it is not LIVE. The HTTPS probe still has to succeed.
 */
export function buildHeartbeat(input: {
  dockerEnabled: boolean;
  socketReachable: boolean;
  arch: NodeArch;
  agentVersion?: string;
  tunnelUp?: boolean;
  containers?: HeartbeatReport["containers"];
  /** Injected in tests. Omitted reads this computer's interfaces. */
  interfaces?: Record<string, readonly LanNic[] | undefined> | null;
}): HeartbeatReport {
  const runtimeAvailable = input.dockerEnabled && input.socketReachable;
  const containers = runtimeAvailable
    ? input.containers?.slice(0, 32).flatMap((entry) => {
        const observation = sanitizeRuntimeObservation(entry);
        return observation ? [observation] : [];
      })
    : [];
  const lanAddress = selectLanAddress(
    input.interfaces === undefined ? os.networkInterfaces() : input.interfaces,
  );
  return {
    agentVersion: input.agentVersion ?? AGENT_VERSION,
    runtimeStatus: runtimeAvailable ? "available" : "unavailable",
    tunnelStatus: input.tunnelUp === true ? "available" : "unavailable",
    capabilities: {
      containerRuntime: runtimeAvailable ? "docker" : "none",
      engineeringCli: true,
      signedMacApp: false,
      pinnedImageReferences: true,
      runtimeImageObservations: true,
      idempotentPinnedDeploys: true,
      pinnedDeployPreparation: true,
      commandAdmissionV1: true,
      commandAdmissionV2: true,
      pinnedContainerInstanceFencing: true,
      nativeRecoveryObservations: true,
      nativeRestartFenceV1: true,
      ...(lanAddress ? { lanAddress } : {}),
    },
    ...(containers && containers.length > 0 ? { containers } : {}),
  };
}
