import { parseBuildReport } from "./build-report.ts";
import {
  CommandAdmissionDeniedError,
  CommandOwnedElsewhereError,
  ControlPlaneRequestError,
  isControlPlaneClosed,
  type PersonalNodeApi,
} from "./client.ts";
import { syncQuickShares, type LocalHttpCheck } from "./quick-share.ts";
import { redactSecrets } from "./redact.ts";
import {
  acknowledgeCompletedCommand,
  readState,
  rememberCompletedCommand,
  rememberKnownDeployments,
} from "./state.ts";
import {
  COMMAND_TYPES,
  COMMAND_ADMISSION_PROTOCOL,
  COMMAND_SESSION_PROTOCOL,
  isExecutionSessionId,
  type ApplyResult,
  type CommandExecutor,
  type HeartbeatReport,
} from "./types.ts";

const UNKNOWN_COMMAND_REASON =
  "This computer does not understand this command. On that Mac, update projectmind-agent (npm i -g projectmind-agent@latest) and restart it, or run the command from Hosting → Computers.";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const SUCCESS_INTERVAL_MS = 30_000;
const JITTER_MS = 250;

/** Exponential reconnect delay, capped, plus up to 249ms of jitter. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const shift = Math.min(safeAttempt - 1, 5);
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** shift);
  const jitter = Math.min(
    JITTER_MS - 1,
    Math.floor(Math.max(0, Math.min(1, random())) * JITTER_MS),
  );
  return Math.min(BACKOFF_CAP_MS, exponential + jitter);
}

export type RunLoopResult = {
  stoppedReason: "revoked" | "completed_cycles";
  cycles: number;
  applied: string[];
  skipped: string[];
};

export async function runAgentLoop(input: {
  client: PersonalNodeApi;
  executor: CommandExecutor;
  stateDir: string;
  nodeId: string;
  heartbeat: HeartbeatReport | (() => HeartbeatReport);
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxCycles: number;
  signal?: AbortSignal;
  /** Runs before each heartbeat. `run` uses this to start cloudflared. */
  beforeHeartbeat?: () => Promise<void>;
  quickShareCheck?: (port: number) => Promise<LocalHttpCheck>;
  readProcessKey?: (port: number) => Promise<string | null>;
  /** Deployment ids this computer should inspect on the next heartbeat. */
  onKnownDeployments?: (deploymentIds: readonly string[]) => void;
}): Promise<RunLoopResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = input.random ?? Math.random;
  const applied: string[] = [];
  const skipped: string[] = [];
  let cycles = 0;
  let attempt = 0;

  while (!input.signal?.aborted && cycles < input.maxCycles) {
    cycles += 1;
    try {
      await runOneCycle({
        client: input.client,
        executor: input.executor,
        stateDir: input.stateDir,
        nodeId: input.nodeId,
        heartbeat: input.heartbeat,
        applied,
        skipped,
        beforeHeartbeat: input.beforeHeartbeat,
        quickShareCheck: input.quickShareCheck,
        readProcessKey: input.readProcessKey,
        onKnownDeployments: input.onKnownDeployments,
      });
      attempt = 0;
    } catch (error) {
      if (isControlPlaneClosed(error)) {
        return { stoppedReason: "revoked", cycles, applied, skipped };
      }
      attempt += 1;
      if (cycles >= input.maxCycles) throw error;
      await sleep(backoffDelayMs(attempt, random));
      continue;
    }
    if (cycles >= input.maxCycles || input.signal?.aborted) break;
    const jitter = Math.min(JITTER_MS - 1, Math.floor(random() * JITTER_MS));
    await sleep(SUCCESS_INTERVAL_MS + jitter);
  }

  return { stoppedReason: "completed_cycles", cycles, applied, skipped };
}

async function runOneCycle(input: {
  client: PersonalNodeApi;
  executor: CommandExecutor;
  stateDir: string;
  nodeId: string;
  heartbeat: HeartbeatReport | (() => HeartbeatReport);
  applied: string[];
  skipped: string[];
  beforeHeartbeat?: () => Promise<void>;
  quickShareCheck?: (port: number) => Promise<LocalHttpCheck>;
  readProcessKey?: (port: number) => Promise<string | null>;
  onKnownDeployments?: (deploymentIds: readonly string[]) => void;
}): Promise<void> {
  if (input.beforeHeartbeat) await input.beforeHeartbeat();
  const heartbeat = typeof input.heartbeat === "function" ? input.heartbeat() : input.heartbeat;
  await input.client.heartbeat(input.nodeId, heartbeat);
  const state = await readState(input.stateDir);
  if (!state) {
    throw new Error("Personal node state is missing. Run pair before applying commands.");
  }
  // Drain before fetching new work. Revocation or transient failure keeps receipts
  // intact and prevents additional side effects. A pruned command cannot accept ACKs.
  for (const receipt of state.pendingCommandCompletions ?? []) {
    try {
      await input.client.ack(input.nodeId, receipt.commandId, {
        outcome: receipt.outcome,
        ...(receipt.buildReport ? { buildReport: receipt.buildReport } : {}),
        admissionProtocol: receipt.admissionProtocol,
        executionSessionId: receipt.executionSessionId,
        log: "Replayed a durably recorded command outcome after interruption. Runtime readiness and public HTTPS were not reverified.",
      });
    } catch (error) {
      if (!(error instanceof ControlPlaneRequestError && error.status === 404)) throw error;
    }
    await acknowledgeCompletedCommand(input.stateDir, receipt.commandId);
  }
  const commands = await input.client.listCommands(input.nodeId);
  const known = await rememberKnownDeployments(
    input.stateDir,
    commands.map((command) => command.deploymentId),
  );
  input.onKnownDeployments?.(known);
  const completed = new Set(state.completedCommandIds);
  for (const command of commands) {
    if (completed.has(command.id)) {
      input.skipped.push(command.id);
      continue;
    }
    if (!(COMMAND_TYPES as readonly string[]).includes(command.type)) {
      await rememberCompletedCommand(input.stateDir, command.id, "failed");
      await input.client.ack(input.nodeId, command.id, {
        outcome: "failed",
        log: UNKNOWN_COMMAND_REASON,
      });
      await acknowledgeCompletedCommand(input.stateDir, command.id);
      completed.add(command.id);
      input.applied.push(command.id);
      continue;
    }
    const marker =
      command.payload && typeof command.payload === "object"
        ? (command.payload as Record<string, unknown>).commandAdmission
        : undefined;
    const admissionRequired = marker !== undefined;
    const sessionRequired = marker === COMMAND_SESSION_PROTOCOL;
    const session = sessionRequired ? input.client.executionSessionId : undefined;
    if (sessionRequired && !isExecutionSessionId(session)) throw new CommandAdmissionDeniedError();
    const ownership = sessionRequired
      ? ({ admissionProtocol: COMMAND_SESSION_PROTOCOL, executionSessionId: session } as const)
      : {};
    let denied: CommandAdmissionDeniedError | null = null;
    try {
      if (
        admissionRequired &&
        marker !== COMMAND_ADMISSION_PROTOCOL &&
        marker !== COMMAND_SESSION_PROTOCOL
      )
        throw new CommandAdmissionDeniedError();
      const receipt = await input.client.ack(input.nodeId, command.id, {
        outcome: "ack",
        requireAdmission: admissionRequired,
        ...ownership,
      });
      if (
        admissionRequired &&
        (!receipt ||
          receipt.admitted !== true ||
          (sessionRequired && receipt.executionSessionId !== session))
      )
        throw new CommandAdmissionDeniedError();
    } catch (error) {
      if (error instanceof CommandOwnedElsewhereError) {
        input.skipped.push(command.id);
        continue;
      }
      if (!(error instanceof CommandAdmissionDeniedError)) throw error;
      denied = error;
    }
    let result: ApplyResult;
    if (denied) {
      result = { outcome: "failed", publicUrl: null, log: denied.message };
    } else {
      try {
        result = await input.executor.apply(command, {
          onPhase: async (phase) => {
            try {
              const receipt = await input.client.ack(input.nodeId, command.id, {
                outcome: "progress",
                phase,
                requireAdmission: admissionRequired,
                ...ownership,
              });
              if (
                admissionRequired &&
                (!receipt ||
                  receipt.admitted !== true ||
                  (sessionRequired && receipt.executionSessionId !== session))
              )
                throw new CommandAdmissionDeniedError();
            } catch (error) {
              if (
                admissionRequired ||
                isControlPlaneClosed(error) ||
                error instanceof CommandAdmissionDeniedError
              )
                throw error;
            }
          },
        });
      } catch (error) {
        if (error instanceof CommandOwnedElsewhereError) {
          input.skipped.push(command.id);
          continue;
        }
        const message = error instanceof Error ? error.message : "The deploy failed.";
        result = { outcome: "failed", publicUrl: null, log: message };
      }
    }
    const parsed =
      result.outcome === "applied" && result.publicUrl === null
        ? parseBuildReport(result.buildReport)
        : null;
    const report = parsed?.logs.commandId === command.id ? parsed : undefined;
    await rememberCompletedCommand(input.stateDir, command.id, result.outcome, session, report);
    completed.add(command.id);
    await input.client.ack(input.nodeId, command.id, {
      outcome: result.outcome,
      ...(report ? { buildReport: report } : {}),
      ...ownership,
      log: safeLog(result),
    });
    await acknowledgeCompletedCommand(input.stateDir, command.id);
    input.applied.push(command.id);
  }
  if (input.client.listQuickShareDesired && input.client.reportQuickShare) {
    try {
      await syncQuickShares({
        list: () => input.client.listQuickShareDesired!(input.nodeId),
        report: (body) => input.client.reportQuickShare!(input.nodeId, body),
        check: input.quickShareCheck,
        readProcessKey: input.readProcessKey ?? (async () => null),
      });
    } catch (error) {
      if (isControlPlaneClosed(error)) throw error;
    }
  }
}

function safeLog(result: ApplyResult): string {
  if (result.publicUrl !== null) return "Command finished. No public URL was published.";
  return redactSecrets(result.log);
}
