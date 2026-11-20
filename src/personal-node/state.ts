import { parseBuildReport, type PersonalBuildReport } from "./build-report.ts";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { redactSecrets } from "./redact.ts";
import { isExecutionSessionId, type AgentState } from "./types.ts";

const STATE_FILE = "agent-state.json";
const MAX_PENDING_COMPLETIONS = 64;

function pendingCompletions(value: unknown): NonNullable<AgentState["pendingCommandCompletions"]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PENDING_COMPLETIONS) {
    throw new Error("Personal node completion outbox is invalid. No commands were applied.");
  }
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const entry = item as Record<string, unknown> | null;
    if (
      !entry ||
      typeof entry.commandId !== "string" ||
      !entry.commandId ||
      entry.commandId.length > 200 ||
      seen.has(entry.commandId) ||
      (entry.outcome !== "applied" && entry.outcome !== "failed") ||
      ((entry.admissionProtocol !== undefined || entry.executionSessionId !== undefined) &&
        (entry.admissionProtocol !== "v2" || !isExecutionSessionId(entry.executionSessionId)))
    ) {
      throw new Error("Personal node completion outbox is invalid. No commands were applied.");
    }
    seen.add(entry.commandId);
    const report = entry.outcome === "applied" ? parseBuildReport(entry.buildReport) : null;
    return {
      commandId: entry.commandId,
      outcome: entry.outcome,
      ...(report?.logs.commandId === entry.commandId ? { buildReport: report } : {}),
      ...(entry.admissionProtocol === "v2"
        ? {
            admissionProtocol: "v2" as const,
            executionSessionId: entry.executionSessionId as string,
          }
        : {}),
    };
  });
}

export function stateFilePath(stateDir: string): string {
  return path.join(stateDir, STATE_FILE);
}

/** http(s) origin saved by pair. Anything else is treated as unset. */
function asServerOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 200) continue;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

export async function readState(stateDir: string): Promise<AgentState | null> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Personal node state file could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Personal node state file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Personal node state file is not a record.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    typeof record.nodeId !== "string" ||
    typeof record.deviceToken !== "string" ||
    !record.deviceToken.startsWith("pnd_")
  ) {
    throw new Error("Personal node state file is missing pairing fields.");
  }
  return {
    sessionId: record.sessionId,
    nodeId: record.nodeId,
    deviceToken: record.deviceToken,
    server: asServerOrigin(record.server),
    completedCommandIds: asStringArray(record.completedCommandIds),
    pendingCommandCompletions: pendingCompletions(record.pendingCommandCompletions),
    knownDeploymentIds: asStringArray(record.knownDeploymentIds).slice(0, 32),
  };
}

/**
 * Engineering stand-in for Keychain. The file mode is 0600.
 * Production packaging is planned to store the device token in Keychain instead.
 */
export async function writeState(stateDir: string, state: AgentState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const file = stateFilePath(stateDir);
  const tmp = path.join(stateDir, `.agent-state.${process.pid}.tmp`);
  const server = asServerOrigin(state.server);
  const body = JSON.stringify(
    {
      sessionId: state.sessionId,
      nodeId: state.nodeId,
      deviceToken: state.deviceToken,
      ...(server ? { server } : {}),
      completedCommandIds: asStringArray(state.completedCommandIds),
      pendingCommandCompletions: pendingCompletions(state.pendingCommandCompletions),
      ...(asStringArray(state.knownDeploymentIds).length > 0
        ? { knownDeploymentIds: asStringArray(state.knownDeploymentIds).slice(0, 32) }
        : {}),
    },
    null,
    2,
  );
  try {
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : "write failed";
    throw new Error(
      redactSecrets(`Personal node state file could not be written. ${message}`, [
        state.deviceToken,
      ]),
    );
  }
}

export async function rememberKnownDeployments(
  stateDir: string,
  deploymentIds: readonly string[],
): Promise<string[]> {
  const state = await readState(stateDir);
  if (!state) return [];
  const merged = asStringArray([...(state.knownDeploymentIds ?? []), ...deploymentIds]).slice(-32);
  const previous = state.knownDeploymentIds ?? [];
  if (merged.length === previous.length && merged.every((id, index) => id === previous[index])) {
    return merged;
  }
  state.knownDeploymentIds = merged;
  await writeState(stateDir, state);
  return merged;
}

export async function rememberCompletedCommand(
  stateDir: string,
  commandId: string,
  outcome?: "applied" | "failed",
  executionSessionId?: string,
  buildReport?: PersonalBuildReport,
): Promise<void> {
  const state = await readState(stateDir);
  if (!state) {
    throw new Error("Personal node state is missing. Run pair before applying commands.");
  }
  if (state.completedCommandIds.includes(commandId)) return;
  if (outcome) {
    const pending = state.pendingCommandCompletions ?? [];
    if (pending.length >= MAX_PENDING_COMPLETIONS) {
      throw new Error(
        "Personal node completion outbox is full. Reconnect before applying commands.",
      );
    }
    state.pendingCommandCompletions = [
      ...pending,
      {
        commandId,
        outcome,
        ...(buildReport ? { buildReport } : {}),
        ...(executionSessionId ? { admissionProtocol: "v2" as const, executionSessionId } : {}),
      },
    ];
  }
  state.completedCommandIds.push(commandId);
  await writeState(stateDir, state);
}

export async function acknowledgeCompletedCommand(
  stateDir: string,
  commandId: string,
): Promise<void> {
  const state = await readState(stateDir);
  if (!state) throw new Error("Personal node state is missing. Run pair before applying commands.");
  state.pendingCommandCompletions = (state.pendingCommandCompletions ?? []).filter(
    (entry) => entry.commandId !== commandId,
  );
  await writeState(stateDir, state);
}
