import { describe, expect, it, vi } from "vitest";
import { startChildJobWatch } from "./child-job-watch.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

vi.mock("./mcp-client.js", () => ({
  callToolJson: vi.fn(async (_client: unknown, name: string) => {
    if (name === "listDelegations") return { delegations: [] };
    if (name === "getAgentJob") return { job: { status: "queued" } };
    return {};
  }),
}));

describe("child-job-watch", () => {
  it("stop() clears the poller without throwing", async () => {
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
