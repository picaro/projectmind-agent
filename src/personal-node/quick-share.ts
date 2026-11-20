/**
 * Bounded loopback check for an already-running HTTP app.
 * The port is chosen by the control plane. This module does not scan the
 * host and does not run a shell string from the server.
 */

export const QUICK_SHARE_BLOCKED_PORTS = [
  22, 23, 25, 53, 110, 111, 135, 139, 143, 389, 445, 465, 587, 993, 995, 1433, 1521, 2049, 2375,
  2376, 2379, 2380, 3306, 3389, 5432, 5433, 5672, 5900, 5984, 6379, 6380, 6443, 8009, 8086, 8529,
  9042, 9092, 9200, 9300, 10250, 11211, 27017, 27018,
] as const;

export type LocalHttpCheck = {
  available: boolean;
  httpStatus: number | null;
  failureCode: string | null;
};

export type QuickShareDesiredItem = {
  shareId: string;
  targetPort: number;
  revision: number;
  approvalGeneration: number;
};

export type QuickShareReport = {
  shareId: string;
  targetPort: number;
  revision: number;
  approvalGeneration: number;
  httpStatus: number | null;
  available: boolean;
  failureCode: string | null;
  processKey: string | null;
};

const BLOCKED = new Set<number>(QUICK_SHARE_BLOCKED_PORTS);

export function isBlockedQuickSharePort(port: number): boolean {
  return BLOCKED.has(port);
}

export function redirectTargetIsExternal(location: string | null, port: number): boolean {
  if (!location) return false;
  if (location.startsWith("/") && !location.startsWith("//")) return false;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost") return true;
  const explicit = url.port ? Number(url.port) : null;
  if (explicit !== null && explicit !== port) return true;
  if (explicit === null && url.protocol === "https:") return true;
  return false;
}

export async function checkLoopbackHttp(
  port: number,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 2_000,
): Promise<LocalHttpCheck> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { available: false, httpStatus: null, failureCode: "invalid_port" };
  }
  if (isBlockedQuickSharePort(port)) {
    return { available: false, httpStatus: null, failureCode: "sensitive_service" };
  }
  const url = `http://127.0.0.1:${port}/`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "*/*" },
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      available: false,
      httpStatus: null,
      failureCode: timedOut ? "timeout" : "origin_unavailable",
    };
  }
  await response.body?.cancel().catch(() => undefined);
  const status = response.status;
  if (status >= 300 && status < 400) {
    const location = response.headers.get("location");
    if (redirectTargetIsExternal(location, port)) {
      return { available: false, httpStatus: status, failureCode: "redirect_external" };
    }
  }
  if (status < 100 || status > 599) {
    return { available: false, httpStatus: status, failureCode: "invalid_response" };
  }
  return { available: true, httpStatus: status, failureCode: null };
}

export async function readListenPid(port: number): Promise<string | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { timeout: 1_000 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(null);
          return;
        }
        const line = stdout.split("\n").find((entry) => /^p\d+$/.test(entry));
        resolve(line ? line.slice(1) : null);
      },
    );
  });
}

export async function syncQuickShares(input: {
  list: () => Promise<QuickShareDesiredItem[]>;
  report: (body: QuickShareReport) => Promise<void>;
  check?: (port: number) => Promise<LocalHttpCheck>;
  readProcessKey?: (port: number) => Promise<string | null>;
}): Promise<void> {
  const shares = await input.list();
  const check = input.check ?? ((port: number) => checkLoopbackHttp(port));
  const readProcessKey = input.readProcessKey ?? readListenPid;
  for (const share of shares) {
    if (!Number.isInteger(share.targetPort)) continue;
    const result = await check(share.targetPort);
    const processKey = result.available ? await readProcessKey(share.targetPort) : null;
    await input.report({
      shareId: share.shareId,
      targetPort: share.targetPort,
      revision: share.revision,
      approvalGeneration: share.approvalGeneration,
      httpStatus: result.httpStatus,
      available: result.available,
      failureCode: result.failureCode,
      processKey,
    });
  }
}
