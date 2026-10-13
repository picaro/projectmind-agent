import { beforeEach, describe, expect, it, vi } from "vitest";

const callToolJson = vi.hoisted(() => vi.fn());
const runHealthCheck = vi.hoisted(() => vi.fn());

vi.mock("./mcp-client.js", () => ({
  callToolJson: (...args: unknown[]) => callToolJson(...args),
  connectMcpClient: vi.fn(),
}));

vi.mock("./health-check.js", () => ({
  runHealthCheck: (...args: unknown[]) => runHealthCheck(...args),
}));

import { buildMcpUrl, maybeRunHealthCheck, parseIntervalMs } from "./index.js";

describe("buildMcpUrl", () => {
  it("adds a project slug once and drops a trailing slash", () => {
    const url = buildMcpUrl("http://localhost:8080/api/mcp/", "alpha");
    expect(url.href).toBe("http://localhost:8080/api/mcp?projectSlug=alpha");
  });

  it("keeps an existing slug and ignores an empty one", () => {
    expect(buildMcpUrl("http://localhost:8080/api/mcp?projectSlug=keep", "other").searchParams.get(
      "projectSlug",
    )).toBe("keep");
    expect(buildMcpUrl("http://localhost:8080/api/mcp", "").search).toBe("");
  });
});

describe("parseIntervalMs", () => {
  it("uses the fallback for a blank value and floors a valid number", () => {
    expect(parseIntervalMs(undefined, 5_000, 1)).toBe(5_000);
    expect(parseIntervalMs("   ", 5_000, 1)).toBe(5_000);
    expect(parseIntervalMs("10.9", 5_000, 1)).toBe(10);
    expect(parseIntervalMs("1", 5_000, 1)).toBe(1);
  });

  it("rejects non-numeric and too-small intervals", () => {
    expect(() => parseIntervalMs("nope", 5_000, 1)).toThrow(/Interval must be a number/);
    expect(() => parseIntervalMs("0", 5_000, 1)).toThrow(/>= 1/);
  });
});

describe("maybeRunHealthCheck", () => {
  const client = {} as never;

  beforeEach(() => {
    callToolJson.mockReset();
    runHealthCheck.mockReset();
    runHealthCheck.mockResolvedValue([{ runner: "cursor_cli", ok: true }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("ignores a missing or empty request", async () => {
    const state = { busy: false, lastHealthCheckRequestedAt: null as string | null };
    await maybeRunHealthCheck(client, null, "agent", state);
    await maybeRunHealthCheck(client, { healthCheckRequestedAt: "" }, "agent", state);
    await maybeRunHealthCheck(client, { healthCheckRequestedAt: 1 }, "agent", state);
    expect(runHealthCheck).not.toHaveBeenCalled();
  });

  it("skips a repeated request and a request that arrives while busy", async () => {
    const state = { busy: true, lastHealthCheckRequestedAt: null as string | null };
    await maybeRunHealthCheck(client, { healthCheckRequestedAt: "t1" }, "agent", state);
    expect(runHealthCheck).not.toHaveBeenCalled();
    expect(state.lastHealthCheckRequestedAt).toBeNull();

    state.busy = false;
    state.lastHealthCheckRequestedAt = "t1";
    await maybeRunHealthCheck(client, { healthCheckRequestedAt: "t1" }, "agent", state);
    expect(runHealthCheck).not.toHaveBeenCalled();
  });

  it("reports results and clears the busy flag", async () => {
    const state = { busy: false, lastHealthCheckRequestedAt: null as string | null };
    await maybeRunHealthCheck(client, { healthCheckRequestedAt: "t2" }, "agent", state);
    expect(state.busy).toBe(false);
    expect(state.lastHealthCheckRequestedAt).toBe("t2");
    expect(callToolJson).toHaveBeenCalledWith(
      client,
      "reportAgentHealthCheck",
      expect.objectContaining({ agentKey: "agent", requestedAt: "t2" }),
    );
  });

  it("clears the busy flag when the probe throws and does not report", async () => {
    runHealthCheck.mockRejectedValue(new Error("boom"));
    const state = { busy: false, lastHealthCheckRequestedAt: null as string | null };
    await maybeRunHealthCheck(client, { healthCheckRequestedAt: "t3" }, "agent", state);
    expect(state.busy).toBe(false);
    expect(state.lastHealthCheckRequestedAt).toBe("t3");
    expect(callToolJson).not.toHaveBeenCalled();
  });
});
