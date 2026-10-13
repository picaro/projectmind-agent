/**
 * Idle-time continuous testing (contract `continuous_test` 1.0), agent side.
 *
 * Only ever one run at a time and never alongside a user job: the coordinator
 * claims only while the main loop is idle, and a user job that arrives
 * mid-run preempts it (SIGTERM → grace → SIGKILL the process group) before
 * the job starts. The control plane decides the verdict from the raw report;
 * this side only reports how the run ended.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  CONTINUOUS_TEST_INLINE_ARTIFACT_MAX_BYTES,
  CONTINUOUS_TEST_PROTOCOL_TOOLS as TOOLS,
  continuousTestJobPayloadSchema,
  type ClaimContinuousTestRunResponse,
  type CreateContinuousTestArtifactUploadResponse,
  type ContinuousTestAgentOutcome,
  type ContinuousTestCompletion,
  type ContinuousTestJobPayload,
  type ContinuousTestLeaseRenewal,
} from "./improvement-contracts/continuous-test-job.js";
import {
  buildChildEnv,
  forbiddenEnvKeys,
  isProcessGroupAlive,
  killProcessGroup,
  spawnProcessGroup,
  terminateProcessGroup,
  type ManagedProcess,
  type SpawnProcess,
} from "./continuous-test-process.js";
import {
  prepareReportForUpload,
  readPlaywrightReport,
  reportHasFailures,
  secretEnvValues,
  selectRunAttachments,
  type RunAttachment,
  summarizeError,
} from "./continuous-test-report.js";
import {
  captureArgv,
  findPlaywrightConfig,
  listArgv,
  writeCaptureWrapper,
} from "./continuous-test-capture.js";
import {
  checkTargetReachable,
  continuousTestStateRoot,
  detectPlaywrightBrowsers,
  hostAllowed,
  isSafeGitRevision,
  listRunStates,
  lockfileInstallCommand,
  parseOriginDefaultBranch,
  resolveTestWorkspace,
  runPaths,
  writeRunState,
  type RunPaths,
} from "./continuous-test-workspace.js";

export type McpCall = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

export type AbortReason = "preempted" | "cancelled" | "timed_out" | "lease_lost" | "shutdown";

export type RunnerDeps = {
  call: McpCall;
  agentKey: string;
  spawn: SpawnProcess;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stateRoot: string;
  fetchImpl: typeof fetch;
  now: () => number;
  log: (message: string) => void;
  /** Delay between completion retries; tests set 0. */
  retryDelayMs: number;
};

export function defaultRunnerDeps(call: McpCall, agentKey: string): RunnerDeps {
  return {
    call,
    agentKey,
    spawn: spawnProcessGroup,
    env: process.env,
    platform: process.platform,
    stateRoot: continuousTestStateRoot(),
    fetchImpl: fetch,
    now: Date.now,
    log: (message) => console.log(message),
    retryDelayMs: 2_000,
  };
}

export type RunSummary = {
  runId: string;
  outcome: ContinuousTestAgentOutcome | null;
  completed: boolean;
  errorSummary: string | null;
  artifactsUploaded: number;
};

/** Only a Playwright test invocation through a package runner — never an arbitrary command. */
export function isAllowedPlaywrightArgv(argv: readonly string[]): boolean {
  if (!["npx", "pnpm", "yarn"].includes(argv[0] ?? "")) return false;
  const pw = argv.indexOf("playwright");
  return pw > 0 && pw <= 2 && argv[pw + 1] === "test";
}

type StepResult = { ok: true; stdout: string } | { ok: false; aborted: boolean; detail: string };

type PrepareFailure = { outcome: "infra_error" | "target_unavailable"; reason: string };

type TestCode = { sha: string; note: string | null };

const STEP_TIMEOUT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 2 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ContinuousTestRun {
  readonly payload: ContinuousTestJobPayload;
  private readonly deps: RunnerDeps;
  private readonly startedAt: number;
  private readonly paths: RunPaths;
  private readonly secrets: string[];
  private abortReason: AbortReason | null = null;
  private current: ManagedProcess | null = null;
  private terminating: Promise<unknown> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private lastLeaseOkAt: number;
  private renewInFlight = false;
  private phase: "preparing" | "running" = "preparing";
  private baseDir: string | null = null;
  private commitSha: string | null = null;
  /** Set when the run could not test what the server asked for; leads the errorSummary. */
  private testCodeNote: string | null = null;
  readonly done: Promise<RunSummary>;

  constructor(payload: ContinuousTestJobPayload, deps: RunnerDeps) {
    this.payload = payload;
    this.deps = deps;
    this.startedAt = deps.now();
    this.lastLeaseOkAt = this.startedAt;
    this.paths = runPaths(deps.stateRoot, payload.runId);
    this.secrets = secretEnvValues(deps.env);
    this.done = this.execute();
  }

  get isAborted(): boolean {
    return this.abortReason !== null;
  }

  /** First reason wins, except a lost lease, which always means "do not complete". */
  abort(reason: AbortReason): void {
    if (this.abortReason && reason !== "lease_lost") return;
    if (this.abortReason === "lease_lost") return;
    this.abortReason = reason;
    this.log(`abort requested: ${reason}`);
    const proc = this.current;
    if (proc && !proc.hasExited() && !this.terminating) {
      const grace =
        reason === "shutdown"
          ? Math.min(this.payload.gracefulPreemptMs, 5_000)
          : this.payload.gracefulPreemptMs;
      this.terminating = terminateProcessGroup(proc, grace);
    }
  }

  private log(message: string): void {
    this.deps.log(`[continuous-test ${this.payload.runId.slice(0, 8)} corr=${this.payload.correlationId}] ${message}`);
  }

  private childEnv(extra: Record<string, string> = {}, commandEnv?: Record<string, string>) {
    return buildChildEnv({ agentEnv: this.deps.env, tmpDir: this.paths.tmpDir, extra, commandEnv });
  }

  private async renew(): Promise<void> {
    if (this.renewInFlight || this.abortReason === "lease_lost") return;
    this.renewInFlight = true;
    try {
      const res = await this.deps.call<ContinuousTestLeaseRenewal>(TOOLS.renewContinuousTestRunLease, {
        runId: this.payload.runId,
        leaseId: this.payload.leaseId,
        agentKey: this.deps.agentKey,
        phase: this.phase,
      });
      if (!res.ok || res.abort?.reason === "lease_lost") {
        this.abort("lease_lost");
        return;
      }
      this.lastLeaseOkAt = this.deps.now();
      if (res.abort) this.abort(res.abort.reason);
    } catch (err) {
      this.log(`lease renew failed: ${err instanceof Error ? err.message : String(err)}`);
      if (this.deps.now() - this.lastLeaseOkAt > this.payload.leaseTtlSeconds * 1000) {
        this.abort("lease_lost");
      }
    } finally {
      this.renewInFlight = false;
    }
  }

  private async step(argv: string[], cwd: string, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<StepResult> {
    if (this.abortReason) return { ok: false, aborted: true, detail: `${label} skipped (aborted)` };
    const proc = this.deps.spawn(argv, { cwd, env: this.childEnv() });
    this.current = proc;
    const timer = setTimeout(() => {
      void terminateProcessGroup(proc, 5_000);
    }, timeoutMs);
    try {
      const exit = await proc.exited;
      if (this.terminating) await this.terminating;
      if (this.abortReason) return { ok: false, aborted: true, detail: `${label} aborted` };
      if (exit.code === 0) return { ok: true, stdout: proc.stdoutTail() };
      const tail = (proc.stderrTail() || proc.stdoutTail()).trim().split("\n").slice(-5).join(" ");
      return {
        ok: false,
        aborted: false,
        detail: `${label} failed (exit ${exit.code ?? exit.signal ?? "?"}): ${tail}`,
      };
    } finally {
      clearTimeout(timer);
      if (!proc.hasExited()) proc.killGroup("SIGKILL");
      this.current = null;
    }
  }

  private async prepare(): Promise<PrepareFailure | { cwd: string } | "aborted"> {
    const p = this.payload;
    if (!isAllowedPlaywrightArgv(p.command.argv)) {
      return { outcome: "infra_error", reason: "Refused: command is not a Playwright test invocation" };
    }
    const forbidden = forbiddenEnvKeys(p.command.env);
    if (forbidden.length > 0) {
      return { outcome: "infra_error", reason: `Refused: command env sets protected keys (${forbidden.join(", ")})` };
    }
    if (!hostAllowed(p.baseUrl, p.allowedHosts)) {
      return { outcome: "infra_error", reason: "Refused: baseUrl host is not in allowedHosts" };
    }
    if (p.testCodeRevision !== null && !isSafeGitRevision(p.testCodeRevision)) {
      return { outcome: "infra_error", reason: "Refused: testCodeRevision is not a plain git revision" };
    }
    if (p.testCodeRef !== undefined && !isSafeGitRevision(p.testCodeRef)) {
      return { outcome: "infra_error", reason: "Refused: testCodeRef is not a plain git ref" };
    }
    const resolved = resolveTestWorkspace({
      projectId: p.projectId,
      projectSlug: p.projectSlug,
      localDirectory: p.localDirectory,
      env: this.deps.env,
      stateRoot: this.deps.stateRoot,
    });
    if (!resolved.ok) return { outcome: "infra_error", reason: `Workspace refused: ${resolved.reason}` };
    this.baseDir = resolved.baseDir;

    fs.mkdirSync(this.paths.tmpDir, { recursive: true });
    this.writeState(null);

    const testCode = await this.resolveTestCode(resolved.baseDir);
    if (testCode === "aborted" || "outcome" in testCode) return testCode;
    this.commitSha = testCode.sha;
    this.testCodeNote = testCode.note;
    this.log(`test code ${testCode.sha.slice(0, 12)}${testCode.note ? ` (${testCode.note})` : ""}`);

    const add = await this.step(
      ["git", "worktree", "add", "--detach", this.paths.worktree, this.commitSha],
      resolved.baseDir,
      "git worktree add",
    );
    if (!add.ok) return add.aborted ? "aborted" : { outcome: "infra_error", reason: add.detail };
    const install = lockfileInstallCommand(this.paths.worktree);
    if (!install) {
      return { outcome: "infra_error", reason: "No lockfile in test workspace; refusing an unpinned install" };
    }
    const installed = await this.step(install.argv, this.paths.worktree, `${install.manager} install`);
    if (!installed.ok) {
      return installed.aborted ? "aborted" : { outcome: "infra_error", reason: `Dependency install failed: ${installed.detail}` };
    }
    const bin = path.join(this.paths.worktree, "node_modules", ".bin", this.deps.platform === "win32" ? "playwright.cmd" : "playwright");
    if (!fs.existsSync(bin)) {
      return { outcome: "infra_error", reason: "@playwright/test is not installed by the project lockfile" };
    }
    if (detectPlaywrightBrowsers(this.childEnv(), this.deps.platform, this.paths.worktree) === false) {
      return {
        outcome: "infra_error",
        reason: "Playwright browsers missing on this computer (run: npx playwright install chromium)",
      };
    }
    if (this.abortReason) return "aborted";
    const reach = await checkTargetReachable(p.baseUrl, this.deps.fetchImpl);
    if (!reach.ok) return { outcome: "target_unavailable", reason: reach.reason };
    return { cwd: this.paths.worktree };
  }

  /**
   * The commit to test. May fetch into the base checkout's object store and its
   * `refs/remotes/origin/*`, but never moves its HEAD, index, or working tree:
   * the commit is only ever checked out in the per-run worktree.
   */
  private async resolveTestCode(baseDir: string): Promise<PrepareFailure | "aborted" | TestCode> {
    const pinned = this.payload.testCodeRevision;
    const { found, note } = pinned
      ? { found: await this.resolvePinnedRevision(baseDir, pinned), note: null }
      : await this.resolveOriginTip(baseDir);
    if (!found.ok) {
      return found.aborted ? "aborted" : { outcome: "infra_error", reason: `Test code revision ${pinned ?? "HEAD"} not found` };
    }
    const sha = found.stdout.trim().split("\n")[0];
    return sha ? { sha, note } : { outcome: "infra_error", reason: "Could not resolve test code revision" };
  }

  private async resolvePinnedRevision(baseDir: string, sha: string): Promise<StepResult> {
    let found = await this.verifyCommit(baseDir, sha);
    if (!found.ok && !found.aborted) {
      await this.fetchOrigin(baseDir, sha);
      found = await this.verifyCommit(baseDir, sha);
    }
    const ref = this.payload.testCodeRef;
    if (!found.ok && !found.aborted && ref) {
      // Some remotes refuse fetch-by-SHA; the branch the SHA was read from still contains it.
      await this.fetchBranch(baseDir, ref);
      found = await this.verifyCommit(baseDir, sha);
    }
    return found;
  }

  /** No pin from the server: test origin's tip, not whatever this checkout last pulled. */
  private async resolveOriginTip(baseDir: string): Promise<{ found: StepResult; note: string | null }> {
    const branch = this.payload.testCodeRef ?? (await this.originDefaultBranch(baseDir));
    let note = "Tested local HEAD: could not find origin's default branch";
    if (branch) {
      const fetched = await this.fetchBranch(baseDir, branch);
      const tip = fetched.ok ? await this.verifyCommit(baseDir, `refs/remotes/origin/${branch}`) : fetched;
      if (tip.ok || tip.aborted) return { found: tip, note: null };
      this.log(`could not fetch origin/${branch}: ${summarizeError(tip.detail, this.secrets)}`);
      note = `Tested local HEAD: could not fetch origin/${branch}`;
    }
    return { found: await this.verifyCommit(baseDir, "HEAD"), note };
  }

  /** Ask origin for its HEAD; fall back to the `origin/HEAD` recorded at clone time. */
  private async originDefaultBranch(baseDir: string): Promise<string | null> {
    const remote = await this.step(["git", "ls-remote", "--symref", "origin", "HEAD"], baseDir, "git ls-remote", FETCH_TIMEOUT_MS);
    const fromRemote = remote.ok ? parseOriginDefaultBranch(remote.stdout) : null;
    if (fromRemote) return fromRemote;
    const local = await this.step(["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], baseDir, "git symbolic-ref");
    return local.ok ? parseOriginDefaultBranch(local.stdout) : null;
  }

  // isSafeGitRevision on every rev/branch below means none can be read as an option
  // (git < 2.24 lacks --end-of-options).
  private verifyCommit(baseDir: string, rev: string): Promise<StepResult> {
    return this.step(["git", "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], baseDir, "git rev-parse");
  }

  private fetchOrigin(baseDir: string, refspec: string): Promise<StepResult> {
    return this.step(["git", "fetch", "--quiet", "origin", refspec], baseDir, "git fetch", FETCH_TIMEOUT_MS);
  }

  /** Explicit refspec so `origin/<branch>` is updated even in a single-branch clone. */
  private fetchBranch(baseDir: string, branch: string): Promise<StepResult> {
    return this.fetchOrigin(baseDir, `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  }

  /** Cause first: a run that fell back to local HEAD says so even when it passed. */
  private finalErrorSummary(text: string | null): string | null {
    const joined = [this.testCodeNote, text].filter(Boolean).join(". ");
    return joined ? summarizeError(joined, this.secrets) : null;
  }

  private writeState(pid: number | null): void {
    try {
      writeRunState(this.paths, {
        runId: this.payload.runId,
        leaseId: this.payload.leaseId,
        correlationId: this.payload.correlationId,
        baseDir: this.baseDir,
        pid,
        startedAt: new Date(this.startedAt).toISOString(),
      });
    } catch (err) {
      this.log(`could not write run state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async execute(): Promise<RunSummary> {
    const p = this.payload;
    const summary: RunSummary = {
      runId: p.runId,
      outcome: null,
      completed: false,
      errorSummary: null,
      artifactsUploaded: 0,
    };
    this.log(`claimed: ${p.environment}/${p.suite} ${p.baseUrl}`);
    this.heartbeat = setInterval(() => void this.renew(), p.heartbeatIntervalSeconds * 1000);
    this.deadline = setTimeout(() => this.abort("timed_out"), Math.max(0, p.timeoutMs));
    let exitCode: number | null = null;
    let outcome: ContinuousTestAgentOutcome = "infra_error";
    let errorSummary: string | null = null;
    let report: Record<string, unknown> | null = null;
    try {
      const prepared = await this.prepare();
      if (prepared === "aborted" || this.abortReason) {
        outcome = this.outcomeForAbort();
      } else if ("outcome" in prepared) {
        outcome = prepared.outcome;
        errorSummary = prepared.reason;
      } else {
        this.phase = "running";
        await this.renew();
        if (this.abortReason) {
          outcome = this.outcomeForAbort();
        } else {
          const result = await this.runPlaywright(prepared.cwd);
          exitCode = result.exitCode;
          report = result.report;
          outcome = this.abortReason ? this.outcomeForAbort() : result.report ? "completed" : "infra_error";
          if (!report && !this.abortReason) {
            errorSummary = `Playwright exited ${exitCode ?? "abnormally"} without a JSON report: ${result.stderrTail}`;
          }
        }
      }
      if (this.abortReason === "lease_lost") {
        this.log("lease lost; stopping without completing");
        summary.outcome = null;
        return summary;
      }
      if (!errorSummary && this.abortReason) errorSummary = this.abortMessage();

      let sendReport: Record<string, unknown> | undefined;
      let wantsUpload = false;
      if (report) {
        const prepared = prepareReportForUpload(report, this.secrets);
        if (prepared.ok) {
          sendReport = prepared.report;
        } else {
          errorSummary = prepared.reason;
          if (outcome === "completed") outcome = "infra_error";
        }
        wantsUpload =
          (outcome === "completed" || outcome === "timed_out") &&
          (reportHasFailures(report) || p.artifacts.passing !== undefined) &&
          p.artifacts.maxFiles > 0;
      }
      // A server that sends `capture` accepts uploads shortly after completion:
      // report the verdict first so a long upload cannot push the run past its
      // deadline. Older servers only accept uploads while the run is active.
      const uploadAfterComplete = p.artifacts.capture !== undefined;
      if (wantsUpload && report && !uploadAfterComplete) {
        summary.artifactsUploaded = await this.uploadArtifacts(report);
      }

      summary.outcome = outcome;
      summary.errorSummary = this.finalErrorSummary(errorSummary);
      summary.completed = await this.complete({
        runId: p.runId,
        leaseId: p.leaseId,
        agentKey: this.deps.agentKey,
        outcome,
        exitCode,
        ...(sendReport ? { report: sendReport } : {}),
        testCodeCommitSha: this.commitSha,
        errorSummary: summary.errorSummary,
        durationMs: Math.max(0, Math.round(this.deps.now() - this.startedAt)),
      });
      if (wantsUpload && report && uploadAfterComplete && summary.completed) {
        // The run is terminal now; heartbeats would only answer lease_lost.
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        summary.artifactsUploaded = await this.uploadArtifacts(report);
      }
      return summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`crashed: ${message}`);
      summary.outcome = "infra_error";
      summary.errorSummary = this.finalErrorSummary(`Agent error: ${message}`);
      if (this.abortReason !== "lease_lost") {
        summary.completed = await this.complete({
          runId: p.runId,
          leaseId: p.leaseId,
          agentKey: this.deps.agentKey,
          outcome: "infra_error",
          testCodeCommitSha: this.commitSha,
          errorSummary: summary.errorSummary,
          durationMs: Math.max(0, Math.round(this.deps.now() - this.startedAt)),
        });
      }
      return summary;
    } finally {
      await this.cleanup();
    }
  }

  private outcomeForAbort(): ContinuousTestAgentOutcome {
    switch (this.abortReason) {
      case "preempted":
        return "preempted";
      case "cancelled":
        return "cancelled";
      case "timed_out":
        return "timed_out";
      default:
        return "infra_error";
    }
  }

  private abortMessage(): string {
    switch (this.abortReason) {
      case "preempted":
        return "Paused for user work on this computer";
      case "cancelled":
        return "Cancelled";
      case "timed_out":
        return `Killed after ${Math.round(this.payload.timeoutMs / 1000)}s time limit`;
      case "shutdown":
        return "Agent shut down mid-run";
      default:
        return "Stopped";
    }
  }

  private async runPlaywright(cwd: string): Promise<{
    exitCode: number | null;
    report: Record<string, unknown> | null;
    stderrTail: string;
  }> {
    const p = this.payload;
    const env = this.childEnv(
      {
        PLAYWRIGHT_JSON_OUTPUT_NAME: this.paths.reportPath,
        PLAYWRIGHT_JSON_OUTPUT_FILE: this.paths.reportPath,
        // Navigation allowlist for the project's Playwright fixture (see ADVANCED.md).
        PROJECTMIND_ALLOWED_HOSTS: p.allowedHosts.join(","),
      },
      p.command.env,
    );
    const argv = await this.captureArgvFor(cwd, env);
    this.log(`spawning ${argv.slice(0, 3).join(" ")} (grep ${p.grep}) in ${cwd}`);
    const proc = this.deps.spawn(argv, { cwd, env });
    this.current = proc;
    this.writeState(proc.pid ?? null);
    if (this.abortReason && !this.terminating) {
      this.terminating = terminateProcessGroup(proc, this.payload.gracefulPreemptMs);
    }
    try {
      const exit = await proc.exited;
      if (this.terminating) await this.terminating;
      const report = readPlaywrightReport(this.paths.reportPath, proc.stdoutTail());
      const stderrTail = proc.stderrTail().trim().split("\n").slice(-5).join(" ");
      this.log(`playwright exited code=${exit.code} signal=${exit.signal} report=${report ? "yes" : "no"}`);
      return { exitCode: exit.code, report, stderrTail };
    } finally {
      if (!proc.hasExited()) proc.killGroup("SIGKILL");
    }
  }

  /**
   * The run's argv, wrapped so Playwright records what the server asked for.
   * Falls back to the project's own config when there is none, the command
   * already names one, or the wrapper fails to load (`--list` preflight).
   */
  private async captureArgvFor(cwd: string, env: Record<string, string>): Promise<string[]> {
    const argv = [...this.payload.command.argv];
    const capture = this.payload.artifacts.capture;
    if (!capture || this.abortReason) return argv;
    const base = findPlaywrightConfig(cwd);
    if (!base) {
      this.log("capture: no playwright.config.* in the test workspace; using the project's settings");
      return argv;
    }
    let wrapped: string[];
    try {
      wrapped = captureArgv(argv, writeCaptureWrapper(base, capture));
    } catch (err) {
      this.log(`capture: could not write wrapper (${err instanceof Error ? err.message : String(err)})`);
      return argv;
    }
    if (wrapped.length === argv.length) return argv;
    const preflight = this.deps.spawn(listArgv(wrapped), { cwd, env });
    this.current = preflight;
    const timer = setTimeout(() => preflight.killGroup("SIGKILL"), 60_000);
    try {
      const exit = await preflight.exited;
      if (exit.code === 0) {
        this.log(`capture: screenshot=${capture.screenshot} video=${capture.video} trace=${capture.trace}`);
        return wrapped;
      }
      const tail = (preflight.stderrTail() || preflight.stdoutTail()).trim().split("\n").slice(-3).join(" ");
      this.log(`capture unavailable (wrapper did not load): ${summarizeError(tail, this.secrets)}`);
      return argv;
    } finally {
      clearTimeout(timer);
      if (!preflight.hasExited()) preflight.killGroup("SIGKILL");
      this.current = null;
    }
  }

  private async uploadArtifacts(report: Record<string, unknown>): Promise<number> {
    const p = this.payload;
    const picked = selectRunAttachments(report, this.paths.worktree, {
      maxFiles: p.artifacts.maxFiles,
      maxBytesPerFile: p.artifacts.maxBytesPerFile,
      maxTotalBytes: p.artifacts.maxTotalBytes,
      passing: p.artifacts.passing,
    });
    // Without `capture` the server predates direct uploads and result statuses.
    const modern = p.artifacts.capture !== undefined;
    const inlineMax = Math.min(
      p.artifacts.inlineMaxBytes ?? CONTINUOUS_TEST_INLINE_ARTIFACT_MAX_BYTES,
      CONTINUOUS_TEST_INLINE_ARTIFACT_MAX_BYTES,
    );
    let directAvailable = modern;
    let uploaded = 0;
    for (const att of picked) {
      if (this.abortReason === "shutdown") break;
      try {
        const content = fs.readFileSync(att.path);
        if (directAvailable && content.length > inlineMax) {
          const done = await this.uploadDirect(att, content);
          if (done === "inline-only") {
            directAvailable = false;
            this.log(`artifact ${att.name} skipped: server takes only small inline uploads`);
            continue;
          }
        } else {
          if (content.length > inlineMax) {
            this.log(`artifact ${att.name} skipped: ${content.length} bytes is over the inline limit`);
            continue;
          }
          await this.deps.call(TOOLS.uploadContinuousTestArtifact, {
            ...this.artifactFields(att),
            contentBase64: content.toString("base64"),
          });
        }
        uploaded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`artifact ${att.name} not uploaded: ${summarizeError(message, this.secrets)}`);
        if (/limit reached|Lease not held|before completing|window .*closed/i.test(message)) break;
      }
    }
    return uploaded;
  }

  private artifactFields(att: RunAttachment): Record<string, unknown> {
    const p = this.payload;
    return {
      runId: p.runId,
      leaseId: p.leaseId,
      agentKey: this.deps.agentKey,
      kind: att.kind,
      name: att.name,
      mime: att.mime,
      testTitle: summarizeError(att.testTitle, this.secrets).slice(0, 300),
      ...(p.artifacts.capture !== undefined ? { resultStatus: att.resultStatus } : {}),
    };
  }

  /** Reserve → PUT straight to storage → finalize. */
  private async uploadDirect(att: RunAttachment, content: Buffer): Promise<"ok" | "inline-only"> {
    const res = await this.deps.call<CreateContinuousTestArtifactUploadResponse>(
      TOOLS.createContinuousTestArtifactUpload,
      { ...this.artifactFields(att), sizeBytes: content.length },
    );
    if (!res.upload || !res.artifactId) return "inline-only";
    const url = new URL(res.upload.url);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("refusing a non-https upload URL");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    try {
      const put = await this.deps.fetchImpl(url, {
        method: "PUT",
        headers: res.upload.headers,
        body: new Uint8Array(content),
        signal: controller.signal,
      });
      if (!put.ok) throw new Error(`upload PUT failed (${put.status})`);
    } finally {
      clearTimeout(timer);
    }
    await this.deps.call(TOOLS.finalizeContinuousTestArtifactUpload, {
      runId: this.payload.runId,
      leaseId: this.payload.leaseId,
      agentKey: this.deps.agentKey,
      artifactId: res.artifactId,
    });
    return "ok";
  }

  private async complete(body: ContinuousTestCompletion): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.deps.call(TOOLS.completeContinuousTestRun, body as unknown as Record<string, unknown>);
        this.log(`completed: outcome=${body.outcome}`);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`complete attempt ${attempt} failed: ${summarizeError(message, this.secrets)}`);
        if (/lease_mismatch|not_found/i.test(message)) return false;
        if (attempt < 3) await sleep(this.deps.retryDelayMs * attempt);
      }
    }
    return false;
  }

  private async cleanup(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.deadline) clearTimeout(this.deadline);
    const proc = this.current;
    if (proc && !proc.hasExited()) proc.killGroup("SIGKILL");
    this.current = null;
    await removeRunWorkspace(this.paths, this.baseDir, this.deps).catch((err) => {
      this.log(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/** Remove the per-run worktree (via its base repo when known) and the run directory. */
export async function removeRunWorkspace(
  paths: RunPaths,
  baseDir: string | null,
  deps: Pick<RunnerDeps, "spawn" | "env">,
): Promise<void> {
  if (baseDir && fs.existsSync(baseDir)) {
    const env = buildChildEnv({ agentEnv: deps.env, tmpDir: deps.env.TMPDIR ?? "/tmp" });
    for (const argv of [
      ["git", "worktree", "remove", "--force", paths.worktree],
      ["git", "worktree", "prune"],
    ]) {
      const proc = deps.spawn(argv, { cwd: baseDir, env });
      const timer = setTimeout(() => proc.killGroup("SIGKILL"), 60_000);
      await proc.exited;
      clearTimeout(timer);
    }
  }
  fs.rmSync(paths.runDir, { recursive: true, force: true });
}

/** Does any process in this group look like Playwright (runner or its browsers)? */
export function processGroupLooksLikePlaywright(pgid: number): Promise<boolean> {
  if (process.platform === "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pgid=,command="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(
        String(stdout)
          .split("\n")
          .some((line) => {
            const match = line.trim().match(/^(\d+)\s+(.*)$/);
            return match !== null && Number(match[1]) === pgid && /playwright/i.test(match[2] ?? "");
          }),
      );
    });
  });
}

export type ReconcileDeps = Pick<RunnerDeps, "call" | "agentKey" | "spawn" | "env" | "stateRoot" | "log"> & {
  isGroupAlive?: (pgid: number) => boolean;
  looksLikePlaywright?: (pgid: number) => Promise<boolean>;
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
};

/**
 * Startup recovery: kill browser trees from runs a previous agent process left
 * behind, tell the server the run died (idempotent; it may already have
 * reconciled the expired lease), and delete the workspace.
 */
export async function reconcileOrphanedRuns(deps: ReconcileDeps): Promise<number> {
  const alive = deps.isGroupAlive ?? isProcessGroupAlive;
  const looksLike = deps.looksLikePlaywright ?? processGroupLooksLikePlaywright;
  const kill = deps.killGroup ?? killProcessGroup;
  let cleaned = 0;
  for (const { paths, state } of listRunStates(deps.stateRoot)) {
    if (state?.pid && alive(state.pid) && (await looksLike(state.pid))) {
      deps.log(`continuous-test: killing orphaned Playwright group ${state.pid} (run ${state.runId})`);
      kill(state.pid, "SIGKILL");
    }
    if (state?.runId && state.leaseId) {
      await deps
        .call(TOOLS.completeContinuousTestRun, {
          runId: state.runId,
          leaseId: state.leaseId,
          agentKey: deps.agentKey,
          outcome: "infra_error",
          errorSummary: "Agent restarted mid-run",
        })
        .catch(() => {});
    }
    await removeRunWorkspace(paths, state?.baseDir ?? null, deps).catch((err) => {
      deps.log(`continuous-test: orphan cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    cleaned += 1;
  }
  return cleaned;
}

export type CoordinatorOptions = {
  deps: RunnerDeps;
  enabled: boolean;
  /** Minimum gap between claim attempts while idle. */
  claimIntervalMs: number;
};

/** Global max one continuous test run on this agent. */
export class ContinuousTestCoordinator {
  private readonly options: CoordinatorOptions;
  private active: ContinuousTestRun | null = null;
  private lastClaimAt = Number.NEGATIVE_INFINITY;
  private claiming = false;

  constructor(options: CoordinatorOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  isRunning(): boolean {
    return this.active !== null || this.claiming;
  }

  /** Called only when the main loop is idle (no user job, no child workers). */
  async maybeClaimAndStart(): Promise<ContinuousTestRun | null> {
    if (!this.options.enabled || this.isRunning()) return null;
    const { deps } = this.options;
    const now = deps.now();
    if (now - this.lastClaimAt < this.options.claimIntervalMs) return null;
    this.lastClaimAt = now;
    this.claiming = true;
    try {
      const res = await deps.call<ClaimContinuousTestRunResponse>(TOOLS.claimContinuousTestRun, {
        agentKey: deps.agentKey,
      });
      if (!res.run) return null;
      const parsed = continuousTestJobPayloadSchema.safeParse(res.payload);
      if (!parsed.success) {
        await this.rejectInvalidPayload(res.payload, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        return null;
      }
      const run = new ContinuousTestRun(parsed.data, deps);
      this.active = run;
      void run.done.finally(() => {
        if (this.active === run) this.active = null;
      });
      return run;
    } catch (err) {
      deps.log(`continuous-test: claim failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      this.claiming = false;
    }
  }

  private async rejectInvalidPayload(raw: unknown, issues: string): Promise<void> {
    const { deps } = this.options;
    deps.log(`continuous-test: invalid payload refused: ${issues}`);
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (typeof rec.runId !== "string" || typeof rec.leaseId !== "string") return;
    await deps
      .call(TOOLS.completeContinuousTestRun, {
        runId: rec.runId,
        leaseId: rec.leaseId,
        agentKey: deps.agentKey,
        outcome: "infra_error",
        errorSummary: summarizeError(`Agent refused continuous_test payload: ${issues}`),
      })
      .catch(() => {});
  }

  /** A user job arrived: stop the test (grace, then kill) before the job starts. */
  async preemptForUserJob(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.abort("preempted");
    await run.done;
  }

  async shutdown(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.abort("shutdown");
    await Promise.race([run.done, sleep(15_000)]);
  }

  async reconcileOrphans(): Promise<number> {
    return reconcileOrphanedRuns(this.options.deps);
  }
}

/** IMEMORY_CONTINUOUS_TESTS=0|false|off opts this computer out entirely. */
export function continuousTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.IMEMORY_CONTINUOUS_TESTS?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}
