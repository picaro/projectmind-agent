import type { PersonalBuildReport } from "./build-report.ts";
/**
 * Shapes shared by the engineering personal-node CLI.
 * This process is not a cloud worker and not the signed macOS app.
 */

/**
 * `<package version>+<source hash>`, replaced by scripts/build-personal-node.mjs.
 * Undefined in a checkout.
 */
declare const __PERSONAL_NODE_AGENT_BUILD__: string | undefined;

/**
 * `+<hash>` tells two builds apart, so a computer still running an old copy is visible.
 * Stays within the 40 characters the server stores.
 */
export const AGENT_VERSION = `projectmind-agent@${
  typeof __PERSONAL_NODE_AGENT_BUILD__ === "string" ? __PERSONAL_NODE_AGENT_BUILD__ : "source"
}`;

export const COMMAND_ADMISSION_HEADER = "x-projectmind-command-admission";
export const COMMAND_ADMISSION_PROTOCOL = "v1";
export const COMMAND_SESSION_PROTOCOL = "v2";
export const COMMAND_EXECUTION_SESSION_HEADER = "x-projectmind-command-execution-session";
export const COMMAND_EXECUTION_OWNED_ELSEWHERE_CODE = "command_execution_owned_elsewhere";
export function isExecutionSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
export const COMMAND_ADMISSION_DENIED_CODE = "command_admission_denied";

export const NODE_ARCHES = ["arm64", "amd64", "unknown"] as const;
export type NodeArch = (typeof NODE_ARCHES)[number];

export const COMMAND_TYPES = [
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
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** Phases a deploy reports while the computer is still working. */
export const DEPLOY_PHASES = ["cloning", "building", "pulling", "starting"] as const;
export type DeployPhase = (typeof DEPLOY_PHASES)[number];

export type ApplyHooks = {
  onPhase?: (phase: DeployPhase) => Promise<void> | void;
};

export type ComponentStatus = "unknown" | "available" | "unavailable";

export type DockerRecoveryObservation = {
  protocol: "docker-recovery-v1";
  containerId: string;
  receiptCommandId: string;
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  maximumRetryCount: number;
  restartCount: number;
  inspectedAt: string;
};

export type HeartbeatReport = {
  agentVersion: string;
  runtimeStatus: ComponentStatus;
  /**
   * `available` only while this process has a live cloudflared child.
   * `connected` is derived node health on the server, not a tunnel status,
   * and the column cannot store it.
   */
  tunnelStatus: ComponentStatus;
  capabilities: {
    containerRuntime: "docker" | "none";
    engineeringCli: true;
    signedMacApp: false;
    /** Protocol support only; runtime availability and readiness remain separate. */
    pinnedImageReferences?: true;
    /** Fixed Docker projections; independent of deploy outcomes and public readiness. */
    runtimeImageObservations?: true;
    idempotentPinnedDeploys?: true;
    pinnedDeployPreparation?: true;
    commandAdmissionV1?: true;
    commandAdmissionV2?: true;
    pinnedContainerInstanceFencing?: true;
    nativeRecoveryObservations?: true;
    nativeRestartFenceV1?: true;
    /** Wi-Fi or Ethernet IPv4 peers on the same network can dial. Omitted when none is visible. */
    lanAddress?: string;
  };
  /**
   * docker inspect of deployments this computer has seen.
   * Omitted when there is nothing to report. This is not a public URL.
   */
  containers?: Array<{
    deploymentId: string;
    status: "running" | "exited" | "missing";
    imageReference?: string;
    imageConfigDigest?: string;
    healthStatus?: "healthy" | "unhealthy" | "starting" | "not_configured" | "unknown";
    recovery?: DockerRecoveryObservation;
  }>;
};

export type AgentCommand = {
  id: string;
  deploymentId: string;
  type: string;
  payload: unknown;
};

export type ApplyResult = {
  outcome: "applied" | "failed";
  log: string;
  /** Always null. A non-null value is discarded and never sent to the control plane. */
  publicUrl: string | null;
  code?: string;
  buildReport?: PersonalBuildReport;
};

export interface CommandExecutor {
  apply(command: AgentCommand, hooks?: ApplyHooks): Promise<ApplyResult>;
}

export type AgentState = {
  sessionId: string;
  nodeId: string;
  deviceToken: string;
  /**
   * Control-plane origin saved by `pair`.
   * `run` uses this when `--server` and `IMEMORY_PERSONAL_NODE_SERVER` are omitted.
   */
  server?: string;
  completedCommandIds: string[];
  /** Terminal outcomes awaiting server acknowledgement. No logs, command payloads or credentials; optional bounded build diagnostics only. */
  pendingCommandCompletions?: Array<{
    commandId: string;
    outcome: "applied" | "failed";
    admissionProtocol?: "v2";
    executionSessionId?: string;
    buildReport?: PersonalBuildReport;
  }>;
  /** Deployments this computer has been asked to run, so the next heartbeat can inspect them. */
  knownDeploymentIds?: string[];
};

export function archFromProcess(arch: string = process.arch): NodeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64" || arch === "amd64") return "amd64";
  return "unknown";
}
