/**
 * Idle-time continuous testing — Mac-agent contract (schema 1.0).
 *
 * Mirror of `packages/improvement-contracts/src/continuous-test-job.ts` in the
 * ProjectMind (imemory) repo; this agent does not depend on that package, so
 * keep the two in sync when the server bumps the contract version.
 */
import { z } from "zod";

export const CONTINUOUS_TEST_CONTRACT_VERSION = "1.0" as const;
export const CONTINUOUS_TEST_JOB_KIND = "continuous_test" as const;

/** Heartbeat `meta` flag an agent sets once it implements this contract. */
export const CONTINUOUS_TEST_AGENT_META_FLAG = "supportsContinuousTests" as const;

export const CONTINUOUS_TEST_PROTOCOL_TOOLS = {
  claimContinuousTestRun: "claimContinuousTestRun",
  renewContinuousTestRunLease: "renewContinuousTestRunLease",
  uploadContinuousTestArtifact: "uploadContinuousTestArtifact",
  createContinuousTestArtifactUpload: "createContinuousTestArtifactUpload",
  finalizeContinuousTestArtifactUpload: "finalizeContinuousTestArtifactUpload",
  completeContinuousTestRun: "completeContinuousTestRun",
} as const;

export const CONTINUOUS_TEST_ENVIRONMENTS = ["production", "staging", "preview"] as const;
export const CONTINUOUS_TEST_SUITES = ["smoke", "regression"] as const;

/** Playwright `use` capture modes the server may ask the agent to force. */
export const CONTINUOUS_TEST_SCREENSHOT_MODES = ["off", "on", "only-on-failure"] as const;
export const CONTINUOUS_TEST_VIDEO_MODES = ["off", "on", "retain-on-failure"] as const;
export const CONTINUOUS_TEST_TRACE_MODES = ["off", "retain-on-failure"] as const;

/** Larger files use the direct upload; the MCP endpoint rejects bodies over 1 MiB. */
export const CONTINUOUS_TEST_INLINE_ARTIFACT_MAX_BYTES = 700_000;

export const continuousTestCaptureSchema = z.object({
  screenshot: z.enum(CONTINUOUS_TEST_SCREENSHOT_MODES),
  video: z.enum(CONTINUOUS_TEST_VIDEO_MODES),
  trace: z.enum(CONTINUOUS_TEST_TRACE_MODES),
});
export type ContinuousTestCapture = z.infer<typeof continuousTestCaptureSchema>;

export const continuousTestJobPayloadSchema = z.object({
  schemaVersion: z.literal(CONTINUOUS_TEST_CONTRACT_VERSION),
  kind: z.literal(CONTINUOUS_TEST_JOB_KIND),
  runId: z.string().min(1),
  leaseId: z.string().min(1),
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  projectSlug: z.string().min(1),
  localDirectory: z.string().min(1).nullable(),
  environment: z.enum(CONTINUOUS_TEST_ENVIRONMENTS),
  suite: z.enum(CONTINUOUS_TEST_SUITES),
  baseUrl: z.string().url(),
  allowedHosts: z.array(z.string().min(1)).min(1),
  grep: z.string().min(1),
  /**
   * Full SHA of the test code to run (the tip of `testCodeRef` when the run was
   * queued). Null when the server could not resolve it: then test the tip of
   * `origin/<testCodeRef>` (or origin's default branch), and only fall back to
   * the checkout's own HEAD when that fetch fails.
   */
  testCodeRevision: z.string().min(1).nullable(),
  /** Branch `testCodeRevision` was read from, usually `main`. Optional within 1.0. */
  testCodeRef: z.string().min(1).optional(),
  deployedRevision: z.object({
    deploymentId: z.string().nullable(),
    commitSha: z.string().nullable(),
  }),
  command: z.object({
    argv: z.array(z.string().min(1)).min(1),
    env: z.record(z.string(), z.string()),
  }),
  workers: z.number().int().min(1).max(4),
  retries: z.number().int().min(0).max(3),
  timeoutMs: z.number().int().positive(),
  gracefulPreemptMs: z.number().int().nonnegative(),
  leaseTtlSeconds: z.number().int().positive(),
  heartbeatIntervalSeconds: z.number().int().positive(),
  artifacts: z.object({
    uploadOn: z.literal("failure"),
    maxFiles: z.number().int().nonnegative(),
    maxBytesPerFile: z.number().int().positive(),
    retainDays: z.number().int().positive(),
    /*
     * Optional within 1.0. Present only from servers that also accept direct
     * uploads and uploads shortly after completion.
     */
    capture: continuousTestCaptureSchema.optional(),
    passing: z.object({ screenshot: z.boolean(), video: z.boolean() }).optional(),
    inlineMaxBytes: z.number().int().positive().optional(),
    maxTotalBytes: z.number().int().positive().optional(),
  }),
});

export type ContinuousTestJobPayload = z.infer<typeof continuousTestJobPayloadSchema>;

export function parseContinuousTestJobPayload(raw: unknown): ContinuousTestJobPayload {
  return continuousTestJobPayloadSchema.parse(raw);
}

export const CONTINUOUS_TEST_AGENT_OUTCOMES = [
  "completed",
  "timed_out",
  "preempted",
  "infra_error",
  "target_unavailable",
  "cancelled",
] as const;
export type ContinuousTestAgentOutcome = (typeof CONTINUOUS_TEST_AGENT_OUTCOMES)[number];

/** Upper bound on the serialized Playwright JSON report accepted by complete. */
export const CONTINUOUS_TEST_MAX_REPORT_BYTES = 2_000_000;

/** `completeContinuousTestRun` errorSummary limit. */
export const CONTINUOUS_TEST_MAX_ERROR_SUMMARY_CHARS = 500;

export type ContinuousTestCompletion = {
  runId: string;
  leaseId: string;
  agentKey: string;
  outcome: ContinuousTestAgentOutcome;
  exitCode?: number | null;
  report?: unknown;
  testCodeCommitSha?: string | null;
  errorSummary?: string | null;
  durationMs?: number | null;
};

export type ContinuousTestLeaseRenewal = {
  ok: boolean;
  leaseExpiresAt: string | null;
  abort: null | { reason: "preempted" | "cancelled" | "lease_lost"; message: string };
};

export const CONTINUOUS_TEST_ARTIFACT_KINDS = ["screenshot", "trace", "video", "report"] as const;
export type ContinuousTestArtifactKind = (typeof CONTINUOUS_TEST_ARTIFACT_KINDS)[number];

/** Playwright result status of the attempt an artifact came from. */
export const CONTINUOUS_TEST_ARTIFACT_RESULT_STATUSES = [
  "passed",
  "failed",
  "timedOut",
  "interrupted",
] as const;
export type ContinuousTestArtifactResultStatus =
  (typeof CONTINUOUS_TEST_ARTIFACT_RESULT_STATUSES)[number];

export type CreateContinuousTestArtifactUploadResponse =
  | { artifactId: string; upload: { method: "PUT"; url: string; headers: Record<string, string> } }
  | { artifactId: null; upload: null; reason: "inline-only" };

/** Mime types the server accepts per artifact kind. */
export const CONTINUOUS_TEST_ARTIFACT_MIME_BY_KIND: Record<
  ContinuousTestArtifactKind,
  readonly string[]
> = {
  screenshot: ["image/png", "image/jpeg"],
  video: ["video/webm", "video/mp4"],
  trace: ["application/zip"],
  report: ["application/json", "text/html"],
};

export type ClaimContinuousTestRunResponse =
  | { run: null; reason?: string }
  | { run: { id: string; status: string }; payload: unknown };
