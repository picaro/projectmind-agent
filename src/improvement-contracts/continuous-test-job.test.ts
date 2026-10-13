import { describe, expect, it } from "vitest";
import { parseContinuousTestJobPayload } from "./continuous-test-job.js";

function validPayload() {
  return {
    schemaVersion: "1.0" as const,
    kind: "continuous_test" as const,
    runId: "run-1",
    leaseId: "lease-1",
    correlationId: "corr-1",
    projectId: "proj-1",
    projectSlug: "alpha",
    localDirectory: "/tmp/alpha",
    environment: "staging" as const,
    suite: "smoke" as const,
    baseUrl: "https://alpha.example",
    allowedHosts: ["alpha.example"],
    grep: "@smoke",
    testCodeRevision: "abc123",
    deployedRevision: { deploymentId: null, commitSha: null },
    command: { argv: ["npx", "playwright", "test"], env: { CI: "1" } },
    workers: 2,
    retries: 1,
    timeoutMs: 60_000,
    gracefulPreemptMs: 0,
    leaseTtlSeconds: 120,
    heartbeatIntervalSeconds: 15,
    artifacts: {
      uploadOn: "failure" as const,
      maxFiles: 3,
      maxBytesPerFile: 1_000,
      retainDays: 7,
    },
  };
}

describe("parseContinuousTestJobPayload", () => {
  it("accepts a 1.0 payload with the optional fields omitted and a null revision", () => {
    const parsed = parseContinuousTestJobPayload({
      ...validPayload(),
      testCodeRevision: null,
      localDirectory: null,
    });
    expect(parsed.testCodeRef).toBeUndefined();
    expect(parsed.artifacts.capture).toBeUndefined();
    expect(parsed.artifacts.passing).toBeUndefined();
    expect(parsed.testCodeRevision).toBeNull();
  });

  it("accepts capture, passing, and testCodeRef when present", () => {
    const parsed = parseContinuousTestJobPayload({
      ...validPayload(),
      testCodeRef: "main",
      artifacts: {
        ...validPayload().artifacts,
        capture: { screenshot: "only-on-failure", video: "retain-on-failure", trace: "off" },
        passing: { screenshot: true, video: false },
        inlineMaxBytes: 100,
        maxTotalBytes: 200,
      },
    });
    expect(parsed.testCodeRef).toBe("main");
    expect(parsed.artifacts.capture?.screenshot).toBe("only-on-failure");
  });

  it.each([
    ["schemaVersion", { schemaVersion: "2.0" }],
    ["kind", { kind: "other" }],
    ["runId", { runId: "" }],
    ["grep", { grep: "" }],
    ["allowedHosts", { allowedHosts: [] }],
    ["baseUrl", { baseUrl: "not a url" }],
    ["workers low", { workers: 0 }],
    ["workers high", { workers: 5 }],
    ["retries low", { retries: -1 }],
    ["retries high", { retries: 4 }],
    ["timeoutMs", { timeoutMs: 0 }],
    ["environment", { environment: "dev" }],
    ["suite", { suite: "load" }],
    ["capture", { artifacts: { ...validPayload().artifacts, capture: { screenshot: "sometimes", video: "off", trace: "off" } } }],
    ["revision", { testCodeRevision: "" }],
    ["argv", { command: { argv: [], env: {} } }],
    ["env", { command: { argv: ["npm"], env: { CI: 1 } } }],
  ])("rejects %s", (_label, patch) => {
    expect(() => parseContinuousTestJobPayload({ ...validPayload(), ...patch })).toThrow();
  });
});
