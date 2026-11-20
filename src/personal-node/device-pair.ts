import os from "node:os";

import { redactSecrets } from "./redact.ts";
import { writeState } from "./state.ts";
import { AGENT_VERSION, archFromProcess } from "./types.ts";

/**
 * Pairing started on the computer: create a session, have the signed-in owner
 * approve its code in the browser, then exchange the code for a device credential.
 * No code is copied from the web page to the terminal.
 */

/** The server allows 20 exchanges per IP per 15 minutes; a 10-minute session needs at most 20. */
export const PAIR_POLL_INTERVAL_MS = 30_000;

export type DevicePairDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stdout?: (line: string) => void;
  openUrl?: (url: string) => void;
};

export type DevicePairInput = {
  server: string;
  stateDir: string;
  name?: string;
};

export function pairingPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin" || platform === "linux") return platform;
  return "other";
}

/**
 * Hosting → Computers with the approval form open. The code is not in the URL:
 * the owner types it, so a forwarded link cannot approve someone else's computer.
 */
export function approvalUrl(server: string): string {
  const url = new URL("/hosting", server);
  url.searchParams.set("tab", "computers");
  url.searchParams.set("approveComputer", "1");
  return url.toString();
}

function retryAfterMs(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}

async function readError(response: Response): Promise<{ error?: string; message?: string }> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return {
      error: typeof body.error === "string" ? body.error : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
    };
  } catch {
    return {};
  }
}

export async function devicePair(
  input: DevicePairInput,
  deps: DevicePairDeps = {},
): Promise<{ nodeId: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line));
  const server = input.server.replace(/\/+$/, "");

  const created = await fetchImpl(`${server}/api/personal-nodes/pairing-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      name: input.name?.trim() || os.hostname().replace(/\.local$/, "") || "My computer",
      platform: pairingPlatform(),
      arch: archFromProcess(),
      agentVersion: AGENT_VERSION,
    }),
  });
  if (!created.ok) {
    const { message } = await readError(created);
    throw new Error(
      `Could not start pairing (${created.status}). ${message ?? "Is personal hosting enabled on this server?"}`,
    );
  }
  const session = (await created.json()) as {
    sessionId?: unknown;
    code?: unknown;
    expiresInSeconds?: unknown;
  };
  if (typeof session.sessionId !== "string" || typeof session.code !== "string") {
    throw new Error("The server did not return a pairing code.");
  }
  const { sessionId, code } = session;
  const ttlMs =
    typeof session.expiresInSeconds === "number" ? session.expiresInSeconds * 1000 : 600_000;
  const deadline = now() + ttlMs;

  const url = approvalUrl(server);
  stdout(`Pairing code: ${code}\n`);
  stdout(`Approve this computer by entering the code while signed in to ProjectMind:\n  ${url}\n`);
  stdout("Waiting for approval (Ctrl-C to cancel)…\n");
  deps.openUrl?.(url);

  let wait = PAIR_POLL_INTERVAL_MS / 2;
  while (now() + wait < deadline) {
    await sleep(wait);
    wait = PAIR_POLL_INTERVAL_MS;
    let response: Response;
    try {
      response = await fetchImpl(`${server}/api/personal-nodes/pairing-sessions/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ code, sessionId }),
      });
    } catch {
      continue;
    }
    if (response.ok) {
      const body = (await response.json()) as { nodeId?: unknown; deviceToken?: unknown };
      if (
        typeof body.nodeId !== "string" ||
        typeof body.deviceToken !== "string" ||
        !body.deviceToken.startsWith("pnd_")
      ) {
        throw new Error("Exchange did not return a device credential.");
      }
      await writeState(input.stateDir, {
        sessionId,
        nodeId: body.nodeId,
        deviceToken: body.deviceToken,
        server,
        completedCommandIds: [],
      });
      return { nodeId: body.nodeId };
    }
    if (response.status === 429) {
      wait = Math.max(PAIR_POLL_INTERVAL_MS, retryAfterMs(response, PAIR_POLL_INTERVAL_MS));
      continue;
    }
    // A deploy or a bad moment on the server; the code is still valid until the deadline.
    if (response.status >= 500) continue;
    const failure = await readError(response);
    if (failure.error === "not_approved") continue;
    throw new Error(
      redactSecrets(
        `Pairing failed (${response.status}). ${failure.message ?? "Start again."}`,
        [code, sessionId],
      ),
    );
  }
  throw new Error("The pairing code expired before it was approved. Run `node pair` again.");
}
