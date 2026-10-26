/**
 * Runs native .projectm workflow jobs (kind `projectm_workflow`) on this Mac.
 *
 * The control plane routes a workflow job here when its `runs-on` asks for macOS
 * — image publishes, mainly, because cloud workers get no Docker. The job is a
 * bash script, not an agent task: it runs as-is in a throwaway directory. No AI
 * runner ever sees it.
 *
 * Secrets arrive only in the claim response. They go to the script through a
 * 0600 file the wrapper sources and deletes before any step runs. `DOCKER_CONFIG`
 * points into the job directory, so `docker login` never writes the registry
 * token into the user's ~/.docker; the directory is removed afterwards.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LEASE_RENEW_MS, isFatalLeaseRenewError } from "./lease-keepalive.js";
import { callToolJson } from "./mcp-client.js";
import { redactSecrets } from "./redact.js";

/** Capability advertised on heartbeat; the control plane only targets agents that set it. */
export const PROJECTM_WORKFLOW_CAPABILITY = "projectmWorkflows";

export type ProjectmWorkflowClaim = {
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  repoFullName: string;
  commitSha: string;
  branch: string;
  stepScript: string;
  computeClass?: string;
  githubStatusContext?: string | null;
  secrets?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const OUTPUT_TAIL_LINES = 80;
const OUTPUT_TAIL_MAX_CHARS = 4000;

export function isProjectmWorkflowJob(
  job: { job_kind?: string | null } | null | undefined,
): boolean {
  return job?.job_kind === "projectm_workflow";
}

/** Must match the control plane's `secrets.NAME` → `${PM_SECRET_NAME}` naming. */
export function secretShellVar(name: string): string {
  return `PM_SECRET_${name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

function singleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildSecretsFile(
  secrets: Record<string, string> | undefined,
): string {
  return Object.entries(secrets ?? {})
    .map(
      ([name, value]) =>
        `export ${secretShellVar(name)}=${singleQuoted(value)}`,
    )
    .join("\n");
}

export function buildWrapperScript(dir: string): string {
  const secrets = join(dir, ".pm-secrets.sh");
  return [
    "#!/bin/bash",
    `if [ -f ${singleQuoted(secrets)} ]; then . ${singleQuoted(secrets)}; rm -f ${singleQuoted(secrets)}; fi`,
    `exec /bin/bash ${singleQuoted(join(dir, ".pm-steps.sh"))}`,
    "",
  ].join("\n");
}

/** Replace secret values in text (longest first), then the usual token shapes. */
export function maskOutput(
  text: string,
  secrets: Record<string, string> | undefined,
): string {
  let masked = text;
  for (const value of Object.values(secrets ?? {})
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length)) {
    masked = masked.split(value).join("***");
  }
  return redactSecrets(masked);
}

/**
 * The daemon socket of the user's current Docker context (Docker Desktop,
 * OrbStack, colima…). Needed because the job gets its own empty DOCKER_CONFIG,
 * which would otherwise lose the context. Null when docker is unavailable.
 */
export function resolveDockerHost(): string | null {
  if (process.env.DOCKER_HOST?.trim()) return process.env.DOCKER_HOST.trim();
  const result = spawnSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) return null;
  const host = result.stdout.trim();
  return host || null;
}

/** Whether `docker` is installed and its daemon answers; advertised on heartbeat. */
export function detectDocker(): boolean {
  const result = spawnSync(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  return result.status === 0 && result.stdout.trim().length > 0;
}

export type RunProjectmWorkflowDeps = {
  call?: typeof callToolJson;
  /** Override the shell spawn (tests). */
  spawnScript?: typeof spawn;
  dockerHost?: () => string | null;
  timeoutMs?: number;
  leaseRenewMs?: number;
  log?: (message: string) => void;
};

export type ProjectmWorkflowOutcome = {
  status: "succeeded" | "failed";
  exitCode: number | null;
  summary: string;
};

export async function runProjectmWorkflowJob(
  client: Client,
  job: { id: string },
  agentKey: string,
  workflow: ProjectmWorkflowClaim | null | undefined,
  deps: RunProjectmWorkflowDeps = {},
): Promise<ProjectmWorkflowOutcome> {
  const call = deps.call ?? callToolJson;
  const log =
    deps.log ??
    ((message: string) =>
      console.log(`[job ${job.id.slice(0, 8)}] ${message}`));
  const complete = async (outcome: ProjectmWorkflowOutcome) => {
    await call(client, "completeAgentJob", {
      jobId: job.id,
      agentKey,
      status: outcome.status,
      ...(outcome.status === "succeeded"
        ? { resultSummary: outcome.summary }
        : { error: outcome.summary }),
      updateTask: false,
    }).catch((err: unknown) => log(`completeAgentJob failed: ${String(err)}`));
    return outcome;
  };

  if (!workflow?.stepScript?.trim()) {
    return complete({
      status: "failed",
      exitCode: null,
      summary: "Workflow job has no step script",
    });
  }

  const name = `${workflow.workflowName} (${workflow.jobName})`;
  log(`Running workflow ${name} @ ${workflow.commitSha.slice(0, 7)}`);
  // Real path: macOS tmpdir is a /var → /private/var symlink, and the script's $PWD is physical.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pm-workflow-")));
  const dockerConfig = join(dir, ".docker");
  let renewTimer: ReturnType<typeof setInterval> | null = null;

  try {
    writeFileSync(join(dir, ".pm-steps.sh"), workflow.stepScript, {
      mode: 0o700,
    });
    writeFileSync(
      join(dir, ".pm-secrets.sh"),
      buildSecretsFile(workflow.secrets),
      { mode: 0o600 },
    );
    writeFileSync(join(dir, "run-workflow.sh"), buildWrapperScript(dir), {
      mode: 0o700,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DOCKER_CONFIG: dockerConfig,
    };
    const dockerHost = (deps.dockerHost ?? resolveDockerHost)();
    if (dockerHost) env.DOCKER_HOST = dockerHost;

    const child = (deps.spawnScript ?? spawn)(
      "/bin/bash",
      [join(dir, "run-workflow.sh")],
      {
        cwd: dir,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const tail: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let abortReason: string | null = null;
    const kill = (reason: string) => {
      abortReason ??= reason;
      try {
        // Negative pid: the whole process group (docker build children included).
        process.kill(-(child.pid ?? 0), "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };

    // Workflow jobs outlive the 2-minute lease; keep it alive while the script runs.
    let renewFailures = 0;
    renewTimer = setInterval(() => {
      void call(client, "renewAgentJobLease", { jobId: job.id, agentKey })
        .then(() => {
          renewFailures = 0;
        })
        .catch((err: unknown) => {
          renewFailures += 1;
          const text = err instanceof Error ? err.message : String(err);
          if (isFatalLeaseRenewError(text) || renewFailures >= 3)
            kill(`lost the job lease: ${text}`);
        });
    }, deps.leaseRenewMs ?? LEASE_RENEW_MS);
    const timeout = setTimeout(
      () => kill("timed out"),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        tail.push(String(err));
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });
    clearTimeout(timeout);

    const output = maskOutput(tail.join("\n"), workflow.secrets)
      .slice(-OUTPUT_TAIL_MAX_CHARS)
      .trim();
    if (exitCode === 0 && !abortReason) {
      log(`Workflow ${name} succeeded`);
      return complete({
        status: "succeeded",
        exitCode,
        summary: `Workflow job ${name} completed successfully`,
      });
    }
    const why = abortReason ?? `failed with exit code ${exitCode ?? "unknown"}`;
    log(`Workflow ${name} ${why}`);
    return complete({
      status: "failed",
      exitCode,
      summary: `Workflow job ${name} ${why}${output ? `\n--- last output ---\n${output}` : ""}`,
    });
  } catch (err) {
    const message = maskOutput(
      err instanceof Error ? err.message : String(err),
      workflow.secrets,
    );
    return complete({
      status: "failed",
      exitCode: null,
      summary: `Workflow job ${name} could not start: ${message}`,
    });
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    rmSync(dir, { recursive: true, force: true });
  }
}
