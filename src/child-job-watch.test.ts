import { afterEach, describe, expect, it, vi } from "vitest";
import { isJobInaccessibleError, startChildJobWatch } from "./child-job-watch.js";
import { callToolJson } from "./mcp-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

vi.mock("./mcp-client.js", () => ({
  callToolJson: vi.fn(),
}));

const mockedCall = vi.mocked(callToolJson);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("isJobInaccessibleError", () => {
  it("matches the control-plane access denial", () => {
    expect(isJobInaccessibleError("Job not accessible for this API key")).toBe(true);
    expect(isJobInaccessibleError("network timeout")).toBe(false);
  });
});

describe("child-job-watch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stop() waits for an in-flight poll and does not log after stop", async () => {
    const list = deferred<{ delegations: never[] }>();
    mockedCall.mockImplementation(async (_client, name) => {
      if (name === "listDelegations") return list.promise;
      return {};
    });

    const logs: string[] = [];
    const watch = startChildJobWatch({
      client: {} as Client,
      parentJobId: "parent-1",
      maxConcurrent: 2,
      onLog: (message) => logs.push(message),
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(mockedCall).toHaveBeenCalled());
    const stopping = watch.stop();
    list.reject(new Error("Job not accessible for this API key"));
    await stopping;

    expect(logs).toEqual([]);
  });

  it("treats inaccessible parent job as terminal without logging a failure", async () => {
    mockedCall.mockRejectedValue(new Error("Job not accessible for this API key"));
    const logs: string[] = [];
    const watch = startChildJobWatch({
      client: {} as Client,
      parentJobId: "parent-done",
      maxConcurrent: 2,
      onLog: (message) => logs.push(message),
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(mockedCall.mock.calls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs).toEqual([]);
    await watch.stop();
    const callsAfterStop = mockedCall.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockedCall.mock.calls.length).toBe(callsAfterStop);
  });

  it("logs unexpected watch errors without throwing", async () => {
    mockedCall.mockRejectedValue(new Error("listDelegations exploded"));
    const logs: string[] = [];
    const watch = startChildJobWatch({
      client: {} as Client,
      parentJobId: "parent-1",
      maxConcurrent: 2,
      onLog: (message) => logs.push(message),
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(logs.some((line) => /Child-job watch failed/.test(line))).toBe(true));
    await watch.stop();
  });

  it("stop() clears the poller without throwing", async () => {
    mockedCall.mockResolvedValue({ delegations: [] });
    const watch = startChildJobWatch({
      client: {} as Client,
      parentJobId: "parent-1",
      maxConcurrent: 2,
      onLog: () => {},
      signal: new AbortController().signal,
    });
    await watch.stop();
  });
});
