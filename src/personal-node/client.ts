import { parseBuildReport, type PersonalBuildReport } from "./build-report.ts";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redact.ts";
import type { QuickShareDesiredItem, QuickShareReport } from "./quick-share.ts";
import {
  COMMAND_ADMISSION_HEADER,
  COMMAND_SESSION_PROTOCOL,
  COMMAND_EXECUTION_SESSION_HEADER,
  COMMAND_EXECUTION_OWNED_ELSEWHERE_CODE,
  isExecutionSessionId,
  COMMAND_ADMISSION_PROTOCOL,
  COMMAND_ADMISSION_DENIED_CODE,
  type AgentCommand,
  type HeartbeatReport,
} from "./types.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type CommandAdmissionReceipt = { admitted: true; executionSessionId?: string };

export class ControlPlaneClosedError extends Error {
  readonly status: number;
  readonly closed = true;
  constructor(status: number) {
    super(
      `Control plane rejected the node (${status}). The agent stopped and will not apply commands.`,
    );
    this.name = "ControlPlaneClosedError";
    this.status = status;
  }
}

export function isControlPlaneClosed(error: unknown): error is ControlPlaneClosedError {
  return error instanceof ControlPlaneClosedError;
}

export class ControlPlaneRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneRequestError";
  }
}

/** A command refusal is distinct from revoking the entire computer. */
export class CommandAdmissionDeniedError extends ControlPlaneRequestError {
  constructor() {
    super(409, "This command is no longer authorized. The agent will not continue it.");
    this.name = "CommandAdmissionDeniedError";
  }
}

/** A competing process must not write a completion/outbox entry for this command. */
export class CommandOwnedElsewhereError extends CommandAdmissionDeniedError {
  constructor() {
    super();
    this.name = "CommandOwnedElsewhereError";
  }
}

export type TunnelConnectorFetch = {
  configured: boolean;
  /** Present only when this node is allowed to start the connector. */
  token: string | null;
  /** `tunnel_not_configured` when the server has no connector token. */
  reason: string | null;
};

export interface PersonalNodeApi {
  readonly executionSessionId?: string;
  heartbeat(nodeId: string, body: HeartbeatReport): Promise<void>;
  listCommands(nodeId: string): Promise<AgentCommand[]>;
  /**
   * Node-authenticated connector token. A missing server token is
   * `{ configured: false, reason: "tunnel_not_configured" }`, not an error.
   */
  fetchTunnelConnector(nodeId: string): Promise<TunnelConnectorFetch>;
  ack(
    nodeId: string,
    commandId: string,
    body: {
      outcome: "ack" | "applied" | "failed" | "progress";
      log?: string;
      buildReport?: PersonalBuildReport;
      phase?: string;
      requireAdmission?: boolean;
      admissionProtocol?: "v1" | "v2";
      executionSessionId?: string;
    },
  ): Promise<void | CommandAdmissionReceipt>;
  /** Active localhost shares for this node. Absent on older control planes. */
  listQuickShareDesired?(nodeId: string): Promise<QuickShareDesiredItem[]>;
  reportQuickShare?(nodeId: string, body: QuickShareReport): Promise<void>;
  redeemEnv(
    nodeId: string,
    commandId: string,
    environmentSecretRef: string,
  ): Promise<Record<string, string>>;
  redeemGit(
    nodeId: string,
    commandId: string,
    gitSecretRef: string,
  ): Promise<{ username: string; token: string }>;
}

function trimServer(server: string): string {
  const trimmed = server.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Server URL must be an http(s) origin such as http://127.0.0.1:8080.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must be http or https.");
  }
  return trimmed;
}

export class PersonalNodeClient implements PersonalNodeApi {
  readonly executionSessionId = randomUUID();
  private readonly server: string;
  private readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;
  private readonly secrets: string[];
  /**
   * Reads delivered by the last `/sync` (heartbeat + commands + tunnel +
   * quick shares in one call). Each is used once by the matching method,
   * which saves three requests per cycle; without one it calls its own route.
   */
  private syncParts: Partial<Record<SyncPartName, SyncPart>> = {};
  /** Opt-in; turned off for good if `/sync` answers 404/405 (older control plane). */
  private syncSupported: boolean;

  constructor(options: {
    server: string;
    fetchImpl?: FetchLike;
    token?: string;
    secrets?: readonly string[];
    /** Batch the per-cycle reads into the heartbeat via `/sync`. */
    sync?: boolean;
  }) {
    this.server = trimServer(options.server);
    this.syncSupported = options.sync ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token;
    this.secrets = [...(options.secrets ?? [])];
    if (options.token) this.secrets.push(options.token);
  }

  async exchange(input: {
    sessionId: string;
    code: string;
  }): Promise<{ nodeId: string; deviceToken: string }> {
    const body = await this.request("/api/personal-nodes/pairing-sessions/exchange", {
      method: "POST",
      auth: false,
      body: { code: input.code, sessionId: input.sessionId },
      secrets: [input.code, input.sessionId],
    });
    const record = asRecord(body);
    const nodeId = record?.nodeId;
    const deviceToken = record?.deviceToken;
    if (
      typeof nodeId !== "string" ||
      typeof deviceToken !== "string" ||
      !deviceToken.startsWith("pnd_")
    ) {
      throw new Error("Exchange did not return a device credential.");
    }
    return { nodeId, deviceToken };
  }

  async heartbeat(nodeId: string, body: HeartbeatReport): Promise<void> {
    // Anything left over belongs to an earlier cycle; never serve it again.
    this.syncParts = {};
    if (this.syncSupported) {
      try {
        const response = await this.request(
          `/api/personal-nodes/${encodeURIComponent(nodeId)}/sync`,
          { method: "POST", auth: true, body },
        );
        const parts = asRecord(asRecord(response)?.parts);
        for (const name of SYNC_PART_NAMES) {
          const part = asRecord(parts?.[name]);
          if (part && typeof part.status === "number") {
            this.syncParts[name] = { status: part.status, body: part.body ?? null };
          }
        }
        return;
      } catch (error) {
        if (
          !(error instanceof ControlPlaneRequestError) ||
          (error.status !== 404 && error.status !== 405)
        ) {
          throw error;
        }
        this.syncSupported = false;
      }
    }
    await this.request(`/api/personal-nodes/${encodeURIComponent(nodeId)}/heartbeat`, {
      method: "POST",
      auth: true,
      body,
    });
  }

  async fetchTunnelConnector(nodeId: string): Promise<TunnelConnectorFetch> {
    const body =
      this.takeSyncPart("tunnel") ??
      (await this.request(`/api/personal-nodes/${encodeURIComponent(nodeId)}/tunnel`, {
        method: "GET",
        auth: true,
      }));
    const record = asRecord(body);
    const raw = record?.connectorToken;
    if (typeof raw === "string" && raw.length >= 4) this.secrets.push(raw);
    const reason = typeof record?.reason === "string" && record.reason ? record.reason : null;
    if (record?.configured === true && typeof raw === "string" && raw.length > 0) {
      return { configured: true, token: raw, reason: null };
    }
    return { configured: false, token: null, reason: reason ?? "tunnel_not_configured" };
  }

  async listCommands(nodeId: string): Promise<AgentCommand[]> {
    const body =
      this.takeSyncPart("commands") ??
      (await this.request(`/api/personal-nodes/${encodeURIComponent(nodeId)}/commands`, {
        method: "GET",
        auth: true,
      }));
    const record = asRecord(body);
    const commands = record?.commands;
    if (!Array.isArray(commands)) {
      throw new Error("Command list response did not include commands.");
    }
    return commands.map((entry) => {
      const command = asRecord(entry);
      if (!command || typeof command.id !== "string" || typeof command.deploymentId !== "string") {
        throw new Error("Command list included an entry without an id.");
      }
      return {
        id: command.id,
        deploymentId: command.deploymentId,
        type: typeof command.type === "string" ? command.type : "",
        payload: command.payload ?? {},
      };
    });
  }

  async redeemEnv(
    nodeId: string,
    commandId: string,
    environmentSecretRef: string,
  ): Promise<Record<string, string>> {
    const body = await this.request(
      `/api/personal-nodes/${encodeURIComponent(nodeId)}/commands/${encodeURIComponent(commandId)}/env`,
      {
        method: "POST",
        auth: true,
        body: { environmentSecretRef },
        executionSessionId: this.executionSessionId,
      },
    );
    const record = asRecord(body);
    const env = asRecord(record?.env);
    const out: Record<string, string> = {};
    if (!env) return out;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") continue;
      out[key] = value;
      if (value.length >= 4) this.secrets.push(value);
    }
    return out;
  }

  async redeemGit(
    nodeId: string,
    commandId: string,
    gitSecretRef: string,
  ): Promise<{ username: string; token: string }> {
    const body = await this.request(
      `/api/personal-nodes/${encodeURIComponent(nodeId)}/commands/${encodeURIComponent(commandId)}/env`,
      {
        method: "POST",
        auth: true,
        body: { gitSecretRef },
        executionSessionId: this.executionSessionId,
        secrets: [gitSecretRef],
      },
    );
    const record = asRecord(body);
    const username = record?.username;
    const token = record?.token;
    if (typeof username !== "string" || typeof token !== "string" || token.length < 8) {
      throw new Error("Git credential redemption did not return a clone credential.");
    }
    this.secrets.push(token);
    if (username.length >= 4) this.secrets.push(username);
    return { username, token };
  }

  async listQuickShareDesired(nodeId: string): Promise<QuickShareDesiredItem[]> {
    const body =
      this.takeSyncPart("quickShares") ??
      (await this.request(
        `/api/personal-nodes/${encodeURIComponent(nodeId)}/quick-shares/desired`,
        { method: "GET", auth: true },
      ));
    const record = asRecord(body);
    const shares = record?.shares;
    if (!Array.isArray(shares)) return [];
    const items: QuickShareDesiredItem[] = [];
    for (const entry of shares) {
      const share = asRecord(entry);
      if (!share || typeof share.shareId !== "string") continue;
      if (!Number.isInteger(share.targetPort) || !Number.isInteger(share.revision)) continue;
      items.push({
        shareId: share.shareId,
        targetPort: share.targetPort as number,
        revision: share.revision as number,
        approvalGeneration: Number.isInteger(share.approvalGeneration)
          ? (share.approvalGeneration as number)
          : 1,
      });
    }
    return items;
  }

  async reportQuickShare(nodeId: string, body: QuickShareReport): Promise<void> {
    await this.request(`/api/personal-nodes/${encodeURIComponent(nodeId)}/quick-shares/report`, {
      method: "POST",
      auth: true,
      body: {
        shareId: body.shareId,
        targetPort: body.targetPort,
        revision: body.revision,
        approvalGeneration: body.approvalGeneration,
        httpStatus: body.httpStatus,
        available: body.available,
        failureCode: body.failureCode,
        processKey: body.processKey,
      },
    });
  }

  async ack(
    nodeId: string,
    commandId: string,
    body: {
      outcome: "ack" | "applied" | "failed" | "progress";
      log?: string;
      buildReport?: PersonalBuildReport;
      phase?: string;
      requireAdmission?: boolean;
      admissionProtocol?: "v1" | "v2";
      executionSessionId?: string;
    },
  ): Promise<void | CommandAdmissionReceipt> {
    const protocol = body.admissionProtocol ?? COMMAND_ADMISSION_PROTOCOL;
    const session =
      protocol === COMMAND_SESSION_PROTOCOL
        ? (body.executionSessionId ?? this.executionSessionId)
        : undefined;
    if (protocol === COMMAND_SESSION_PROTOCOL && !isExecutionSessionId(session))
      throw new CommandAdmissionDeniedError();
    const report = body.outcome === "applied" ? parseBuildReport(body.buildReport) : null;
    const log = body.log === undefined ? undefined : redactSecrets(body.log, this.secrets);
    const response = await this.request(
      `/api/personal-nodes/${encodeURIComponent(nodeId)}/commands/${encodeURIComponent(commandId)}/ack`,
      {
        method: "POST",
        auth: true,
        timeoutMs: body.requireAdmission ? 10_000 : undefined,
        admissionProtocol: protocol,
        executionSessionId: session,
        body: {
          outcome: body.outcome,
          log,
          phase: body.phase,
          ...(report?.logs.commandId === commandId ? { buildReport: report } : {}),
        },
      },
    );
    const admission = asRecord(asRecord(response)?.admission);
    const phase = body.outcome === "ack" ? "ack" : body.outcome === "progress" ? body.phase : null;
    if (
      typeof phase === "string" &&
      phase.length > 0 &&
      admission?.allowed === true &&
      admission.protocol === protocol &&
      (protocol !== COMMAND_SESSION_PROTOCOL || admission.executionSessionId === session) &&
      admission.commandId === commandId &&
      admission.phase === phase
    )
      return { admitted: true, ...(session ? { executionSessionId: session } : {}) };
  }

  /**
   * The read delivered by the last `/sync`, used once. A failed part throws
   * exactly what the standalone request would have; `undefined` means the
   * caller should make its own request.
   */
  private takeSyncPart(name: SyncPartName): unknown {
    const part = this.syncParts[name];
    if (!part) return undefined;
    delete this.syncParts[name];
    if (part.status < 200 || part.status >= 300) {
      const body = asRecord(part.body);
      throwForFailedStatus(part.status, body?.error, JSON.stringify(part.body ?? ""), this.secrets);
    }
    // An empty body parses the same as `{}` in every reader, and keeps `??`
    // from mistaking it for "no synced part".
    return part.body ?? {};
  }

  private async request(
    pathname: string,
    init: {
      method: string;
      auth: boolean;
      body?: unknown;
      secrets?: readonly string[];
      timeoutMs?: number;
      admissionProtocol?: "v1" | "v2";
      executionSessionId?: string;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.auth) {
      if (!this.token) throw new Error("Device token is missing. Run pair first.");
      headers.authorization = `PersonalNode ${this.token}`;
      headers[COMMAND_ADMISSION_HEADER] = init.admissionProtocol ?? COMMAND_ADMISSION_PROTOCOL;
      if (init.executionSessionId)
        headers[COMMAND_EXECUTION_SESSION_HEADER] = init.executionSessionId;
    }
    const secrets = [...this.secrets, ...(init.secrets ?? [])];
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.server}${pathname}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      throw new Error(redactSecrets(`Control plane request failed. ${message}`, secrets));
    }
    const text = await response.text();
    if (!response.ok) {
      let code: unknown;
      try {
        code = asRecord(JSON.parse(text))?.error;
      } catch {
        // An unrelated or malformed progress response retains legacy error handling.
      }
      throwForFailedStatus(response.status, code, text, secrets);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Control plane returned a non-JSON response.");
    }
  }
}

const SYNC_PART_NAMES = ["commands", "tunnel", "quickShares"] as const;
type SyncPartName = (typeof SYNC_PART_NAMES)[number];
type SyncPart = { status: number; body: unknown };

/** Maps a failed control-plane status to the error the agent loop expects. */
function throwForFailedStatus(
  status: number,
  code: unknown,
  text: string,
  secrets: readonly string[],
): never {
  if (status === 401 || status === 403) throw new ControlPlaneClosedError(status);
  if (status === 409) {
    if (code === COMMAND_EXECUTION_OWNED_ELSEWHERE_CODE) throw new CommandOwnedElsewhereError();
    if (code === COMMAND_ADMISSION_DENIED_CODE) throw new CommandAdmissionDeniedError();
  }
  throw new ControlPlaneRequestError(
    status,
    redactSecrets(`Control plane request failed (${status}). ${text.slice(0, 180)}`, secrets),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
