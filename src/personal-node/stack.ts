/**
 * Allowlisted multi-container Marketplace stack apply on a personal computer.
 */
import {
  IMAGE_DIGEST,
  PayloadRejected,
  assertDeclarativePayload,
  assertVolumes,
  volumeNamesFromPayload,
} from "./validate.ts";
import {
  WIREGUARD_ADMIN_PORT,
  WIREGUARD_CONFIG_MOUNT,
  WIREGUARD_ENDPOINT_PROFILE,
  isWireguardEasyDigest,
  parseVpnEndpoint,
  parseWireguardPasswordHash,
} from "./wireguard-profile.ts";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STACK_NETWORK = /^pn-net-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const PLATFORM = /^(linux\/arm64|linux\/amd64)$/;

export type StackVolumeSpec = { name: string; mountPath?: string };

export type StackContainerSpec = {
  role: string;
  imageDigest: string;
  containerPort: number;
  publishLoopback: boolean;
  volumeSpecs?: StackVolumeSpec[];
  runtimeProfile?: typeof WIREGUARD_ENDPOINT_PROFILE;
};

export function stackNetworkName(installationId: string): string {
  const trimmed = installationId.trim().toLowerCase();
  if (!UUID_TEXT.test(trimmed)) {
    throw new PayloadRejected("invalid_input", "installationId must be a UUID for stack network.");
  }
  return `pn-net-${trimmed}`;
}

export function stackContainerName(installationId: string, role: string): string {
  if (!ROLE.test(role)) {
    throw new PayloadRejected("invalid_input", "Stack role must be kebab-case.");
  }
  const trimmed = installationId.trim().toLowerCase();
  if (!UUID_TEXT.test(trimmed)) {
    throw new PayloadRejected("invalid_input", "installationId must be a UUID.");
  }
  return `pn-${trimmed.slice(0, 8)}-${role}`;
}

export function parseStackContainers(value: unknown): StackContainerSpec[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) {
    throw new PayloadRejected("invalid_input", "containers must be a list of 1–6 stack services.");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PayloadRejected("invalid_input", `containers[${index}] must be an object.`);
    }
    const row = entry as Record<string, unknown>;
    const role = typeof row.role === "string" ? row.role.trim() : "";
    if (!ROLE.test(role)) {
      throw new PayloadRejected("invalid_input", `containers[${index}].role is invalid.`);
    }
    const imageDigest = typeof row.imageDigest === "string" ? row.imageDigest.trim() : "";
    if (!IMAGE_DIGEST.test(imageDigest)) {
      throw new PayloadRejected(
        "invalid_input",
        `containers[${index}].imageDigest must be sha256:…`,
      );
    }
    const containerPort = Number(row.containerPort);
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw new PayloadRejected("invalid_input", `containers[${index}].containerPort is invalid.`);
    }
    const publishLoopback = row.publishLoopback === true;
    const runtimeProfile = row.runtimeProfile;
    if (runtimeProfile !== undefined && runtimeProfile !== WIREGUARD_ENDPOINT_PROFILE) {
      throw new PayloadRejected(
        "forbidden_command_field",
        "runtimeProfile must be wireguard-endpoint.",
      );
    }
    const volumeSpecs = parseStackVolumes(row.volumeSpecs, runtimeProfile);
    if (runtimeProfile === WIREGUARD_ENDPOINT_PROFILE) {
      if (role !== "primary") {
        throw new PayloadRejected(
          "forbidden_command_field",
          "wireguard-endpoint can only be the primary container.",
        );
      }
      if (!isWireguardEasyDigest(imageDigest)) {
        throw new PayloadRejected(
          "image_digest_required",
          "wireguard-endpoint requires the pinned WireGuard Easy digest.",
        );
      }
      if (containerPort !== WIREGUARD_ADMIN_PORT || publishLoopback !== true) {
        throw new PayloadRejected(
          "forbidden_command_field",
          "wireguard-endpoint publishes its admin UI on loopback port 51821 only.",
        );
      }
      if (volumeSpecs.length !== 1 || volumeSpecs[0]?.mountPath !== WIREGUARD_CONFIG_MOUNT) {
        throw new PayloadRejected(
          "forbidden_command_field",
          "wireguard-endpoint stores config in one named volume at /etc/wireguard.",
        );
      }
    }
    return {
      role,
      imageDigest,
      containerPort,
      publishLoopback,
      volumeSpecs,
      ...(runtimeProfile === WIREGUARD_ENDPOINT_PROFILE
        ? { runtimeProfile: WIREGUARD_ENDPOINT_PROFILE }
        : {}),
    };
  });
}

function parseStackVolumes(value: unknown, runtimeProfile: unknown): StackVolumeSpec[] {
  if (value === undefined) return [];
  if (runtimeProfile !== WIREGUARD_ENDPOINT_PROFILE) {
    return assertVolumes(value);
  }
  if (!Array.isArray(value)) {
    throw new PayloadRejected("invalid_input", "volumeSpecs must be a list of named volumes.");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PayloadRejected("invalid_input", "Each volume must be a named volume.");
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "mountPath,name") {
      throw new PayloadRejected(
        "forbidden_command_field",
        "A WireGuard volume is { name, mountPath } only. Host paths are rejected.",
      );
    }
    if (typeof record.name !== "string" || typeof record.mountPath !== "string") {
      throw new PayloadRejected(
        "invalid_input",
        "WireGuard volume name and mountPath are required.",
      );
    }
    if (record.mountPath !== WIREGUARD_CONFIG_MOUNT) {
      throw new PayloadRejected(
        "forbidden_command_field",
        "WireGuard config mounts only at /etc/wireguard.",
      );
    }
    const named = assertVolumes([{ name: record.name }]);
    return { name: named[0]!.name, mountPath: WIREGUARD_CONFIG_MOUNT };
  });
}

export function assertApplyStack(payload: Record<string, unknown>): void {
  assertDeclarativePayload(payload);
  const installationId =
    typeof payload.installationId === "string" ? payload.installationId.trim() : "";
  if (!UUID_TEXT.test(installationId)) {
    throw new PayloadRejected("invalid_input", "installationId must be a UUID.");
  }
  const networkName = typeof payload.networkName === "string" ? payload.networkName.trim() : "";
  if (!STACK_NETWORK.test(networkName) || networkName !== stackNetworkName(installationId)) {
    throw new PayloadRejected("invalid_input", "networkName must match pn-net-<installationId>.");
  }
  const platform = typeof payload.declaredPlatform === "string" ? payload.declaredPlatform : "";
  if (!PLATFORM.test(platform)) {
    throw new PayloadRejected(
      "arch_mismatch",
      "declaredPlatform must be linux/arm64 or linux/amd64.",
    );
  }
  if (typeof payload.environmentSecretRef !== "string" || !payload.environmentSecretRef.trim()) {
    throw new PayloadRejected("invalid_input", "environmentSecretRef is required for apply_stack.");
  }
  const containers = parseStackContainers(payload.containers);
  const profiles = containers.filter((entry) => entry.runtimeProfile);
  if (profiles.length > 1) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "A stack can include one wireguard-endpoint container.",
    );
  }
  if (profiles.length === 1) {
    if (!parseVpnEndpoint(payload.vpnEndpoint)) {
      throw new PayloadRejected(
        "invalid_input",
        "vpnEndpoint must be the address peers use to reach this computer.",
      );
    }
    if (!parseWireguardPasswordHash(payload.passwordHash)) {
      throw new PayloadRejected(
        "invalid_input",
        "passwordHash must be a bcrypt hash for the WireGuard admin dashboard.",
      );
    }
  } else if (payload.vpnEndpoint !== undefined || payload.passwordHash !== undefined) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "vpnEndpoint and passwordHash are only valid for wireguard-endpoint.",
    );
  }
  volumeNamesFromPayload(payload);
}
