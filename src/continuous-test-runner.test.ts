import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ContinuousTestCoordinator,
  ContinuousTestRun,
  continuousTestsEnabled,
  isAllowedPlaywrightArgv,
  reconcileOrphanedRuns,
  type RunnerDeps,
} from "./continuous-test-runner.js";
import { spawnProcessGroup, type ManagedProcess, type ProcessExit, type SpawnOptions } from "./continuous-test-process.js";
import type { ContinuousTestJobPayload } from "./improvement-contracts/continuous-test-job.js";
import { runPaths, writeRunState } from "./continuous-test-workspace.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

type Call = { name: string; args: Record<string, unknown> };

type FakeProc = ManagedProcess & { signals: NodeJS.Signals[]; exit: (e: ProcessExit) => void };

function fakeProc(opts: { ignoreTerm?: boolean; stdout?: string; stderr?: string } = {}): FakeProc {
  let resolveExit!: (e: ProcessExit) => void;
  let done = false;
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const signals: NodeJS.Signals[] = [];
  const exit = (e: ProcessExit) => {
    if (done) return;
    done = true;
    resolveExit(e);
  };
  return {
    pid: 4242,
    exited,
    hasExited: () => done,
    stdoutTail: () => opts.stdout ?? "",
    stderrTail: () => opts.stderr ?? "",
    signals,
    exit,
    killGroup: (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL" || !opts.ignoreTerm) exit({ code: null, signal });
    },
  };
}

function exitedProc(code: number, stdout = "", stderr = ""): FakeProc {
  const proc = fakeProc({ stdout, stderr });
  proc.exit({ code, signal: null });
  return proc;
}

type PlaywrightBehavior = (opts: SpawnOptions) => FakeProc;

type Harness = {
  root: string;
  baseDir: string;
  stateRoot: string;
  calls: Call[];
  spawned: Array<{ argv: string[]; opts: SpawnOptions; proc: FakeProc }>;
  deps: RunnerDeps;
  renew: (n: number) => Record<string, unknown>;
  playwright: PlaywrightBehavior;
  install: () => FakeProc;
  list: () => FakeProc;
  logs: string[];
};

let h: Harness;

function passingReport(): Record<string, unknown> {
  return {
    config: { rootDir: "/Users/someone/secret-path" },
    suites: [
      {
        title: "smoke/home.spec.ts",
        specs: [
          {
            title: "home renders @smoke @prod-safe",
            tests: [
              {
                status: "expected",
                projectName: "chromium",
                results: [{ status: "passed", stdout: [{ text: "hello" }], attachments: [] }],
              },
            ],
          },
        ],
        suites: [],
      },
    ],
    errors: [],
  };
}

function failingReport(worktree: string): Record<string, unknown> {
  const results = path.join(worktree, "test-results", "home-failed");
  fs.mkdirSync(results, { recursive: true });
  fs.writeFileSync(path.join(results, "test-failed-1.png"), Buffer.from("png-bytes"));
  fs.writeFileSync(path.join(results, "trace.zip"), Buffer.from("zip-bytes"));
  fs.writeFileSync(path.join(results, "storageState.json"), "{\"cookies\":[]}");
  fs.writeFileSync(path.join(results, "video.webm"), Buffer.alloc(10_000));
  const outside = path.join(h.root, "outside.png");
  fs.writeFileSync(outside, Buffer.from("leak"));
  return {
    suites: [
      {
        title: "smoke/home.spec.ts",
        specs: [
          {
            title: "checkout works @smoke",
            tests: [
              {
                status: "unexpected",
                projectName: "chromium",
                results: [
                  {
                    status: "failed",
                    stdout: [{ text: "Authorization: Bearer abcdefghijklmnop" }],
                    error: { message: "expected visible; password=hunter2hunter2" },
                    attachments: [
                      { name: "screenshot", contentType: "image/png", path: path.join(results, "test-failed-1.png") },
                      { name: "trace", contentType: "application/zip", path: path.join(results, "trace.zip") },
                      { name: "video", contentType: "video/webm", path: path.join(results, "video.webm") },
                      { name: "state", contentType: "image/png", path: path.join(results, "storageState.json") },
                      { name: "outside", contentType: "image/png", path: outside },
                      { name: "inline", contentType: "image/png", body: "aGVsbG8=" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: [],
  };
}

function payload(overrides: Partial<ContinuousTestJobPayload> = {}): ContinuousTestJobPayload {
  return {
    schemaVersion: "1.0",
    kind: "continuous_test",
    runId: RUN_ID,
    leaseId: "lease-1",
    correlationId: "corr-1",
    projectId: "proj-1",
    projectSlug: "shop",
    localDirectory: null,
    environment: "production",
    suite: "smoke",
    baseUrl: "https://shop.example.com",
    allowedHosts: ["shop.example.com"],
    grep: "(?=.*@smoke)(?=.*@prod-safe)",
    testCodeRevision: null,
    deployedRevision: { deploymentId: "dpl_1", commitSha: "abc" },
    command: {
      argv: ["npx", "playwright", "test", "--reporter=json", "--workers=1", "--retries=1", "--grep", "(?=.*@smoke)(?=.*@prod-safe)"],
      env: {
        CI: "1",
        E2E_BASE_URL: "https://shop.example.com",
        PLAYWRIGHT_BASE_URL: "https://shop.example.com",
        PROJECTMIND_TEST_RUN_ID: RUN_ID,
        PROJECTMIND_CORRELATION_ID: "corr-1",
      },
    },
    workers: 1,
    retries: 1,
    timeoutMs: 60_000,
    gracefulPreemptMs: 50,
    leaseTtlSeconds: 120,
    heartbeatIntervalSeconds: 40,
    artifacts: { uploadOn: "failure", maxFiles: 10, maxBytesPerFile: 5_000, retainDays: 7 },
    ...overrides,
  };
}

function writeReport(opts: SpawnOptions, report: unknown): void {
  fs.writeFileSync(opts.env.PLAYWRIGHT_JSON_OUTPUT_NAME!, JSON.stringify(report));
}

function worktreeOf(): string {
  return runPaths(h.stateRoot, RUN_ID).worktree;
}

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-ct-")));
  const baseDir = path.join(root, "allowed", "shop");
  fs.mkdirSync(path.join(baseDir, ".git"), { recursive: true });
  const browsers = path.join(root, "browsers");
  fs.mkdirSync(path.join(browsers, "chromium-1200"), { recursive: true });
  const stateRoot = path.join(root, "managed", ".pm-continuous-tests");
  const calls: Call[] = [];
  const spawned: Harness["spawned"] = [];
  const logs: string[] = [];
  h = {
    root,
    baseDir,
    stateRoot,
    calls,
    spawned,
    logs,
    renew: () => ({ ok: true, leaseExpiresAt: "2026-01-01T00:00:00Z", abort: null }),
    playwright: (opts) => {
      writeReport(opts, passingReport());
      return exitedProc(0);
    },
    install: () => exitedProc(0),
    list: () => exitedProc(0),
    deps: undefined as unknown as RunnerDeps,
  };
  let renewCount = 0;
  h.deps = {
    agentKey: "mac-mini",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      IMEMORY_API_KEY: "pm_live_supersecretapikey123",
      IMEMORY_WORKSPACE_ALLOWLIST: path.join(root, "allowed"),
      IMEMORY_MANAGED_WORKSPACE_ROOT: path.join(root, "managed"),
      IMEMORY_CONTINUOUS_TEST_WORKSPACES: `shop=${baseDir}`,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
    },
    platform: "darwin",
    stateRoot,
    now: Date.now,
    log: (m) => logs.push(m),
    retryDelayMs: 0,
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    call: (async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "renewContinuousTestRunLease") return h.renew(++renewCount);
      return {};
    }) as RunnerDeps["call"],
    spawn: (argv, opts) => {
      let proc: FakeProc;
      if (argv[0] === "git" && argv[1] === "rev-parse") {
        proc = exitedProc(0, "deadbeefcafe\n");
      } else if (argv[0] === "git" && argv[1] === "ls-remote") {
        proc = exitedProc(0, "ref: refs/heads/main\tHEAD\ndeadbeefcafe\tHEAD\n");
      } else if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "add") {
        const wt = argv[4]!;
        fs.mkdirSync(path.join(wt, "node_modules", ".bin"), { recursive: true });
        fs.writeFileSync(path.join(wt, "pnpm-lock.yaml"), "lockfileVersion: 9");
        fs.writeFileSync(path.join(wt, "node_modules", ".bin", "playwright"), "");
        fs.writeFileSync(path.join(wt, "playwright.config.ts"), "export default {};\n");
        proc = exitedProc(0);
      } else if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove") {
        fs.rmSync(argv[4]!, { recursive: true, force: true });
        proc = exitedProc(0);
      } else if (argv[0] === "git") {
        proc = exitedProc(0);
      } else if (argv[0] === "pnpm") {
        proc = h.install();
      } else if (argv.includes("--list")) {
        proc = h.list();
      } else {
        proc = h.playwright(opts);
      }
      spawned.push({ argv, opts, proc });
      return proc;
    },
  };
});

afterEach(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

function completion(): Record<string, unknown> | undefined {
  return h.calls.find((c) => c.name === "completeContinuousTestRun")?.args;
}

function playwrightSpawns() {
  return h.spawned.filter((s) => s.argv[1] === "playwright");
}

describe("ContinuousTestRun", () => {
  it("claim → success: runs argv without a shell in the worktree and completes with the report", async () => {
    const summary = await new ContinuousTestRun(payload(), h.deps).done;

    expect(summary).toMatchObject({ outcome: "completed", completed: true, artifactsUploaded: 0 });
    const [pw] = playwrightSpawns();
    expect(pw!.argv).toEqual(payload().command.argv);
    expect(pw!.opts.cwd).toBe(worktreeOf());
    expect(pw!.opts.env.E2E_BASE_URL).toBe("https://shop.example.com");
    expect(pw!.opts.env.PROJECTMIND_ALLOWED_HOSTS).toBe("shop.example.com");
    expect(pw!.opts.env.IMEMORY_API_KEY).toBeUndefined();
    expect(pw!.opts.env.IMEMORY_WORKSPACE_ALLOWLIST).toBeUndefined();

    const renews = h.calls.filter((c) => c.name === "renewContinuousTestRunLease");
    expect(renews[0]!.args).toMatchObject({ runId: RUN_ID, leaseId: "lease-1", phase: "running" });

    const done = completion()!;
    expect(done).toMatchObject({
      runId: RUN_ID,
      leaseId: "lease-1",
      agentKey: "mac-mini",
      outcome: "completed",
      exitCode: 0,
      testCodeCommitSha: "deadbeefcafe",
      errorSummary: null,
    });
    const sent = done.report as Record<string, unknown>;
    expect(sent.config).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("hello");

    expect(h.spawned.some((s) => s.argv.join(" ") === "pnpm install --frozen-lockfile --ignore-scripts --prefer-offline")).toBe(true);
    expect(fs.existsSync(runPaths(h.stateRoot, RUN_ID).runDir)).toBe(false);
    expect(h.spawned.some((s) => s.argv.slice(0, 3).join(" ") === "git worktree remove")).toBe(true);
  });

  it("failure with report: uploads bounded failure evidence (never storageState or outside files) before completing", async () => {
    h.playwright = (opts) => {
      writeReport(opts, failingReport(worktreeOf()));
      return exitedProc(1);
    };
    const summary = await new ContinuousTestRun(payload(), h.deps).done;

    expect(summary.outcome).toBe("completed");
    const uploads = h.calls.filter((c) => c.name === "uploadContinuousTestArtifact");
    expect(uploads.map((u) => [u.args.kind, u.args.name, u.args.mime])).toEqual([
      ["screenshot", "test-failed-1.png", "image/png"],
      ["trace", "trace.zip", "application/zip"],
    ]);
    expect(uploads[0]!.args).toMatchObject({ runId: RUN_ID, leaseId: "lease-1", agentKey: "mac-mini" });
    expect(Buffer.from(String(uploads[0]!.args.contentBase64), "base64").toString()).toBe("png-bytes");
    expect(uploads[0]!.args.testTitle).toContain("checkout works @smoke");

    const names = h.calls.map((c) => c.name);
    expect(names.lastIndexOf("uploadContinuousTestArtifact")).toBeLessThan(names.indexOf("completeContinuousTestRun"));

    const done = completion()!;
    expect(done).toMatchObject({ outcome: "completed", exitCode: 1 });
    const text = JSON.stringify(done.report);
    expect(text).not.toContain("aGVsbG8=");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain('"status":"unexpected"');
  });

  it("respects artifacts.maxFiles", async () => {
    h.playwright = (opts) => {
      writeReport(opts, failingReport(worktreeOf()));
      return exitedProc(1);
    };
    await new ContinuousTestRun(
      payload({ artifacts: { uploadOn: "failure", maxFiles: 1, maxBytesPerFile: 5_000, retainDays: 7 } }),
      h.deps,
    ).done;
    expect(h.calls.filter((c) => c.name === "uploadContinuousTestArtifact")).toHaveLength(1);
  });

  it("nonzero exit without a report → infra_error with a scrubbed stderr excerpt", async () => {
    h.playwright = () =>
      exitedProc(1, "", "Error: config crashed token=ghp_abcdefghijklmnopqrstuvwxyz0123 pm_live_supersecretapikey123");
    const summary = await new ContinuousTestRun(payload(), h.deps).done;

    expect(summary.outcome).toBe("infra_error");
    const done = completion()!;
    expect(done.report).toBeUndefined();
    expect(done.exitCode).toBe(1);
    expect(String(done.errorSummary)).toMatch(/without a JSON report/);
    expect(String(done.errorSummary)).not.toContain("ghp_");
    expect(String(done.errorSummary)).not.toContain("supersecretapikey");
  });

  it("parses the report from stdout when no report file was written", async () => {
    h.playwright = () => exitedProc(1, `noise\n${JSON.stringify(passingReport(), null, 2)}`);
    await new ContinuousTestRun(payload(), h.deps).done;
    expect(completion()).toMatchObject({ outcome: "completed", exitCode: 1 });
    expect(completion()!.report).toBeDefined();
  });

  it("timeout → SIGTERM/SIGKILL the group and complete timed_out", async () => {
    let pw!: FakeProc;
    h.playwright = () => (pw = fakeProc({ ignoreTerm: true }));
    const summary = await new ContinuousTestRun(payload({ timeoutMs: 300 }), h.deps).done;

    expect(summary.outcome).toBe("timed_out");
    expect(pw.signals.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(completion()).toMatchObject({ outcome: "timed_out" });
    expect(String(completion()!.errorSummary)).toMatch(/time limit/);
  });

  it("server abort mid-run (heartbeat) → group kill after grace and PREEMPTED", async () => {
    let pw!: FakeProc;
    h.playwright = () => (pw = fakeProc({ ignoreTerm: true }));
    h.renew = (n) =>
      n >= 2
        ? { ok: true, leaseExpiresAt: null, abort: { reason: "preempted", message: "user work" } }
        : { ok: true, leaseExpiresAt: null, abort: null };
    const started = Date.now();
    const summary = await new ContinuousTestRun(payload({ heartbeatIntervalSeconds: 1, gracefulPreemptMs: 100 }), h.deps).done;

    expect(summary.outcome).toBe("preempted");
    expect(pw.signals.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(completion()).toMatchObject({ outcome: "preempted" });
    expect(fs.existsSync(runPaths(h.stateRoot, RUN_ID).runDir)).toBe(false);
  });

  it("server cancel → CANCELLED", async () => {
    h.renew = () => ({ ok: true, leaseExpiresAt: null, abort: { reason: "cancelled", message: "x" } });
    const summary = await new ContinuousTestRun(payload(), h.deps).done;
    expect(summary.outcome).toBe("cancelled");
    expect(playwrightSpawns()).toHaveLength(0);
    expect(completion()).toMatchObject({ outcome: "cancelled" });
  });

  it("lease lost → stops without completing", async () => {
    h.renew = () => ({ ok: false, leaseExpiresAt: null, abort: { reason: "lease_lost", message: "gone" } });
    const summary = await new ContinuousTestRun(payload(), h.deps).done;
    expect(summary).toMatchObject({ outcome: null, completed: false });
    expect(completion()).toBeUndefined();
    expect(fs.existsSync(runPaths(h.stateRoot, RUN_ID).runDir)).toBe(false);
  });

  it("refuses a directory outside the allowlist without spawning anything", async () => {
    const outside = path.join(h.root, "elsewhere");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    const summary = await new ContinuousTestRun(payload({ localDirectory: outside }), h.deps).done;

    expect(summary.outcome).toBe("infra_error");
    expect(h.spawned).toHaveLength(0);
    expect(String(completion()!.errorSummary)).toMatch(/Workspace refused.*outside/);
  });

  it("refuses non-Playwright commands and protected env keys", async () => {
    await new ContinuousTestRun(payload({ command: { argv: ["bash", "-c", "rm -rf ~"], env: {} } }), h.deps).done;
    expect(String(completion()!.errorSummary)).toMatch(/not a Playwright test invocation/);

    h.calls.length = 0;
    await new ContinuousTestRun(
      payload({ command: { argv: payload().command.argv, env: { NODE_OPTIONS: "--require /tmp/x.js" } } }),
      h.deps,
    ).done;
    expect(String(completion()!.errorSummary)).toMatch(/protected keys \(NODE_OPTIONS\)/);
    expect(h.spawned).toHaveLength(0);
  });

  it("refuses a testCodeRef git could read as an option", async () => {
    await new ContinuousTestRun(payload({ testCodeRef: "--upload-pack=evil" }), h.deps).done;
    expect(String(completion()!.errorSummary)).toMatch(/testCodeRef is not a plain git ref/);
    expect(h.spawned).toHaveLength(0);
  });

  it("refuses a baseUrl outside allowedHosts", async () => {
    await new ContinuousTestRun(payload({ allowedHosts: ["other.example.com"] }), h.deps).done;
    expect(String(completion()!.errorSummary)).toMatch(/allowedHosts/);
    expect(h.spawned).toHaveLength(0);
  });

  it("distinct outcomes for install failure, missing browsers, unreachable target", async () => {
    h.install = () => exitedProc(1, "", "ERR_PNPM_OUTDATED_LOCKFILE");
    await new ContinuousTestRun(payload(), h.deps).done;
    expect(completion()).toMatchObject({ outcome: "infra_error" });
    expect(String(completion()!.errorSummary)).toMatch(/Dependency install failed.*OUTDATED_LOCKFILE/);

    h.install = () => exitedProc(0);
    h.calls.length = 0;
    fs.rmSync(path.join(h.root, "browsers", "chromium-1200"), { recursive: true });
    await new ContinuousTestRun(payload(), h.deps).done;
    expect(String(completion()!.errorSummary)).toMatch(/browsers missing/);

    fs.mkdirSync(path.join(h.root, "browsers", "chromium-1200"));
    h.calls.length = 0;
    h.deps.fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    await new ContinuousTestRun(payload(), h.deps).done;
    expect(completion()).toMatchObject({ outcome: "target_unavailable" });
    expect(playwrightSpawns()).toHaveLength(0);
  });

  it("cleanup always runs, even when the spawn itself crashes", async () => {
    h.playwright = () => {
      throw new Error("spawn npx ENOENT");
    };
    const summary = await new ContinuousTestRun(payload(), h.deps).done;
    expect(summary.outcome).toBe("infra_error");
    expect(String(completion()!.errorSummary)).toMatch(/spawn npx ENOENT/);
    expect(fs.existsSync(runPaths(h.stateRoot, RUN_ID).runDir)).toBe(false);
  });

  it("drops the report and reports infra_error when it cannot fit the size cap", async () => {
    const huge = passingReport();
    (huge.suites as Array<Record<string, unknown>>)[0]!.title = "x".repeat(2_100_000);
    h.playwright = (opts) => {
      writeReport(opts, huge);
      return exitedProc(0);
    };
    await new ContinuousTestRun(payload(), h.deps).done;
    expect(completion()).toMatchObject({ outcome: "infra_error" });
    expect(completion()!.report).toBeUndefined();
    expect(String(completion()!.errorSummary)).toMatch(/limit 2000000/);
  });
});

describe("ContinuousTestCoordinator", () => {
  function coordinator(claimPayload: unknown = payload()) {
    const base = h.deps.call;
    let claims = 0;
    h.deps.call = (async (name: string, args: Record<string, unknown>) => {
      if (name === "claimContinuousTestRun") {
        claims += 1;
        h.calls.push({ name, args });
        return { run: { id: RUN_ID, status: "PREPARING" }, payload: claimPayload };
      }
      return base(name, args);
    }) as RunnerDeps["call"];
    return {
      c: new ContinuousTestCoordinator({ deps: h.deps, enabled: true, claimIntervalMs: 0 }),
      claims: () => claims,
    };
  }

  it("user job arrival preempts the running test and frees the slot", async () => {
    let pw!: FakeProc;
    h.playwright = () => (pw = fakeProc());
    const { c } = coordinator();
    const run = await c.maybeClaimAndStart();
    expect(run).not.toBeNull();
    await expect.poll(() => playwrightSpawns().length).toBe(1);

    await c.preemptForUserJob();
    expect(pw.signals[0]).toBe("SIGTERM");
    expect(completion()).toMatchObject({ outcome: "preempted" });
    await expect.poll(() => c.isRunning()).toBe(false);
  });

  it("never runs two test runs at once", async () => {
    h.playwright = () => fakeProc();
    const { c, claims } = coordinator();
    await c.maybeClaimAndStart();
    expect(await c.maybeClaimAndStart()).toBeNull();
    expect(claims()).toBe(1);
    await c.preemptForUserJob();
  });

  it("does not claim when disabled", async () => {
    const c = new ContinuousTestCoordinator({ deps: h.deps, enabled: false, claimIntervalMs: 0 });
    expect(await c.maybeClaimAndStart()).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an invalid payload and completes it as infra_error", async () => {
    const { c } = coordinator({ ...payload(), schemaVersion: "2.0" });
    expect(await c.maybeClaimAndStart()).toBeNull();
    expect(completion()).toMatchObject({ runId: RUN_ID, leaseId: "lease-1", outcome: "infra_error" });
    expect(String(completion()!.errorSummary)).toMatch(/schemaVersion/);
    expect(h.spawned).toHaveLength(0);
  });

  it("shutdown stops the run and still cleans up", async () => {
    h.playwright = () => fakeProc();
    const { c } = coordinator();
    await c.maybeClaimAndStart();
    await expect.poll(() => playwrightSpawns().length).toBe(1);
    await c.shutdown();
    expect(completion()).toMatchObject({ outcome: "infra_error", errorSummary: "Agent shut down mid-run" });
    expect(fs.existsSync(runPaths(h.stateRoot, RUN_ID).runDir)).toBe(false);
  });
});

describe("real git worktree", () => {
  it("checks out the requested revision in an isolated worktree and removes it afterwards", async () => {
    fs.rmSync(path.join(h.baseDir, ".git"), { recursive: true, force: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: h.baseDir }).toString().trim();
    git("init", "-q");
    fs.writeFileSync(path.join(h.baseDir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    fs.writeFileSync(path.join(h.baseDir, "marker.txt"), "v1");
    git("add", ".");
    git("commit", "-qm", "v1");
    const v1 = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(h.baseDir, "marker.txt"), "v2");
    git("commit", "-qam", "v2");

    let seenMarker: string | null = null;
    h.deps.spawn = (argv, opts) => {
      if (argv[0] === "git") return spawnProcessGroup(argv, opts);
      if (argv[0] === "pnpm") {
        fs.mkdirSync(path.join(opts.cwd, "node_modules", ".bin"), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, "node_modules", ".bin", "playwright"), "");
        return exitedProc(0);
      }
      seenMarker = fs.readFileSync(path.join(opts.cwd, "marker.txt"), "utf8");
      writeReport(opts, passingReport());
      return exitedProc(0);
    };

    await new ContinuousTestRun(payload({ testCodeRevision: v1 }), h.deps).done;

    expect(seenMarker).toBe("v1");
    expect(completion()).toMatchObject({ outcome: "completed", testCodeCommitSha: v1 });
    expect(fs.existsSync(runPaths(h.stateRoot, RUN_ID).runDir)).toBe(false);
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(h.baseDir, "marker.txt"), "utf8")).toBe("v2");
  });
});

function gitIn(cwd: string) {
  return (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
}

describe("test code from origin (real git)", () => {
  let origin: string;
  let upstream: (...args: string[]) => string;
  let user: (...args: string[]) => string;
  let commits: Record<string, string>;
  let seenMarker: string | null;
  let baseDirGitCommands: string[];

  /** Commit `marker.txt = name` in the upstream clone and push it to origin's `branch`. */
  function pushCommit(name: string, branch = "main"): string {
    fs.writeFileSync(path.join(h.root, "upstream", "marker.txt"), name);
    upstream("commit", "-qam", name);
    upstream("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    commits[name] = upstream("rev-parse", "HEAD");
    return commits[name]!;
  }

  // origin.git ← upstream pushes v1, then the user clones (on `feature`, with an
  // uncommitted edit), then upstream pushes v2 the user's checkout has never seen.
  beforeEach(() => {
    commits = {};
    seenMarker = null;
    baseDirGitCommands = [];
    origin = path.join(h.root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    gitIn(origin)("symbolic-ref", "HEAD", "refs/heads/main");
    const upstreamDir = path.join(h.root, "upstream");
    execFileSync("git", ["clone", "-q", origin, upstreamDir], { stdio: "ignore" });
    upstream = gitIn(upstreamDir);
    fs.writeFileSync(path.join(upstreamDir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    fs.writeFileSync(path.join(upstreamDir, "marker.txt"), "");
    upstream("add", ".");
    upstream("commit", "-qm", "init");
    pushCommit("v1");

    fs.rmSync(h.baseDir, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", origin, h.baseDir], { stdio: "ignore" });
    user = gitIn(h.baseDir);
    user("checkout", "-qb", "feature");
    fs.writeFileSync(path.join(h.baseDir, "marker.txt"), "local edit");
    pushCommit("v2");

    h.deps.spawn = (argv, opts) => {
      if (argv[0] === "git") {
        if (opts.cwd === h.baseDir) baseDirGitCommands.push(argv[1]!);
        return spawnProcessGroup(argv, opts);
      }
      if (argv[0] === "pnpm") {
        fs.mkdirSync(path.join(opts.cwd, "node_modules", ".bin"), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, "node_modules", ".bin", "playwright"), "");
        return exitedProc(0);
      }
      seenMarker = fs.readFileSync(path.join(opts.cwd, "marker.txt"), "utf8");
      writeReport(opts, passingReport());
      return exitedProc(0);
    };
  });

  /** The user's working copy: same branch, same commit, uncommitted edit intact, no extra worktrees. */
  function expectUserCheckoutUntouched(): void {
    expect(user("symbolic-ref", "--short", "HEAD")).toBe("feature");
    expect(user("rev-parse", "HEAD")).toBe(commits.v1);
    expect(user("status", "--porcelain")).toBe("M marker.txt");
    expect(fs.readFileSync(path.join(h.baseDir, "marker.txt"), "utf8")).toBe("local edit");
    expect(user("worktree", "list").split("\n")).toHaveLength(1);
    expect(fs.existsSync(runPaths(h.stateRoot, RUN_ID).runDir)).toBe(false);
    const readOnlyOrFetch = ["rev-parse", "fetch", "ls-remote", "symbolic-ref", "worktree"];
    expect(baseDirGitCommands.filter((c) => !readOnlyOrFetch.includes(c))).toEqual([]);
  }

  it("null revision: fetches origin and tests the tip of testCodeRef, not the stale local HEAD", async () => {
    await new ContinuousTestRun(payload({ testCodeRevision: null, testCodeRef: "main" }), h.deps).done;

    expect(seenMarker).toBe("v2");
    expect(completion()).toMatchObject({ outcome: "completed", testCodeCommitSha: commits.v2, errorSummary: null });
    expect(baseDirGitCommands).toContain("fetch");
    expectUserCheckoutUntouched();
  });

  it("null revision without testCodeRef: tests the tip of origin's default branch", async () => {
    // origin's HEAD moves to `trunk` after the user cloned, so their origin/HEAD still says main.
    upstream("checkout", "-qb", "trunk");
    pushCommit("v3", "trunk");
    gitIn(origin)("symbolic-ref", "HEAD", "refs/heads/trunk");

    await new ContinuousTestRun(payload({ testCodeRevision: null }), h.deps).done;

    expect(seenMarker).toBe("v3");
    expect(completion()).toMatchObject({ outcome: "completed", testCodeCommitSha: commits.v3, errorSummary: null });
    expect(baseDirGitCommands).toContain("ls-remote");
    expectUserCheckoutUntouched();
  });

  it("null revision and origin unreachable: tests local HEAD and says so in errorSummary", async () => {
    user("remote", "set-url", "origin", path.join(h.root, "gone.git"));

    for (const testCodeRef of ["main", undefined]) {
      h.calls.length = 0;
      seenMarker = null;
      await new ContinuousTestRun(payload({ testCodeRevision: null, testCodeRef }), h.deps).done;

      expect(seenMarker).toBe("v1");
      expect(completion()).toMatchObject({
        outcome: "completed",
        testCodeCommitSha: commits.v1,
        errorSummary: "Tested local HEAD: could not fetch origin/main",
      });
      expectUserCheckoutUntouched();
    }
  });

  it("the fallback note leads any other errorSummary", async () => {
    user("remote", "set-url", "origin", path.join(h.root, "gone.git"));
    h.deps.fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch;

    await new ContinuousTestRun(payload({ testCodeRevision: null, testCodeRef: "main" }), h.deps).done;

    expect(completion()).toMatchObject({
      outcome: "target_unavailable",
      errorSummary: "Tested local HEAD: could not fetch origin/main. Target answered HTTP 503",
    });
  });

  it("pinned SHA the remote will not serve by SHA: fetches testCodeRef, then tests the pinned SHA", async () => {
    // v2 is no longer a branch tip, and protocol v0 without allow*SHA1InWant refuses unadvertised objects.
    pushCommit("v3");
    user("config", "protocol.version", "0");
    const pinned = commits.v2!;

    await new ContinuousTestRun(payload({ testCodeRevision: pinned }), h.deps).done;
    expect(completion()).toMatchObject({ outcome: "infra_error", errorSummary: `Test code revision ${pinned} not found` });
    expect(seenMarker).toBeNull();

    h.calls.length = 0;
    await new ContinuousTestRun(payload({ testCodeRevision: pinned, testCodeRef: "main" }), h.deps).done;

    expect(seenMarker).toBe("v2");
    expect(completion()).toMatchObject({ outcome: "completed", testCodeCommitSha: pinned, errorSummary: null });
    expectUserCheckoutUntouched();
  });
});

describe("reconcileOrphanedRuns", () => {
  it("kills a leftover Playwright group, reports the run, and deletes its workspace", async () => {
    const paths = runPaths(h.stateRoot, RUN_ID);
    writeRunState(paths, {
      runId: RUN_ID,
      leaseId: "lease-old",
      correlationId: "c",
      baseDir: h.baseDir,
      pid: 9999,
      startedAt: new Date().toISOString(),
    });
    const killed: Array<[number, string]> = [];
    const n = await reconcileOrphanedRuns({
      ...h.deps,
      isGroupAlive: () => true,
      looksLikePlaywright: async () => true,
      killGroup: (pid, sig) => killed.push([pid, sig]),
    });
    expect(n).toBe(1);
    expect(killed).toEqual([[9999, "SIGKILL"]]);
    expect(completion()).toMatchObject({ runId: RUN_ID, leaseId: "lease-old", outcome: "infra_error" });
    expect(fs.existsSync(paths.runDir)).toBe(false);
  });

  it("never kills a reused pid that is not Playwright", async () => {
    writeRunState(runPaths(h.stateRoot, RUN_ID), {
      runId: RUN_ID,
      leaseId: "l",
      correlationId: "c",
      baseDir: null,
      pid: 9999,
      startedAt: new Date().toISOString(),
    });
    const killed: number[] = [];
    await reconcileOrphanedRuns({
      ...h.deps,
      isGroupAlive: () => true,
      looksLikePlaywright: async () => false,
      killGroup: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([]);
  });
});

describe("helpers", () => {
  it("isAllowedPlaywrightArgv", () => {
    expect(isAllowedPlaywrightArgv(["npx", "playwright", "test"])).toBe(true);
    expect(isAllowedPlaywrightArgv(["pnpm", "exec", "playwright", "test"])).toBe(true);
    expect(isAllowedPlaywrightArgv(["npx", "playwright", "install"])).toBe(false);
    expect(isAllowedPlaywrightArgv(["sh", "-c", "npx playwright test"])).toBe(false);
  });

  it("continuousTestsEnabled defaults on and honors opt-out", () => {
    expect(continuousTestsEnabled({})).toBe(true);
    expect(continuousTestsEnabled({ IMEMORY_CONTINUOUS_TESTS: "0" })).toBe(false);
    expect(continuousTestsEnabled({ IMEMORY_CONTINUOUS_TESTS: "off" })).toBe(false);
  });
});

describe("screenshots and video (servers that send artifacts.capture)", () => {
  const modern = (extra: Partial<ContinuousTestJobPayload["artifacts"]> = {}) =>
    payload({
      artifacts: {
        uploadOn: "failure",
        maxFiles: 40,
        maxBytesPerFile: 20_000_000,
        retainDays: 7,
        capture: { screenshot: "on", video: "on", trace: "retain-on-failure" },
        passing: { screenshot: true, video: true },
        inlineMaxBytes: 700_000,
        maxTotalBytes: 150_000_000,
        ...extra,
      },
    });

  /** One failing test (screenshot + 1 MB video) and one passing test (screenshot + video). */
  function mixedReport(worktree: string): Record<string, unknown> {
    const dir = path.join(worktree, "test-results");
    fs.mkdirSync(dir, { recursive: true });
    const file = (name: string, bytes: number) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.alloc(bytes, 7));
      return p;
    };
    const failShot = file("fail.png", 100);
    const failVideo = file("fail.webm", 1_000_000);
    const passShot = file("pass.png", 100);
    const passVideo = file("pass.webm", 200);
    const passTrace = file("pass-trace.zip", 100);
    const setupShot = file("setup.png", 100);
    const spec = (title: string, status: string, resultStatus: string, attachments: Array<[string, string]>, projectName = "chromium") => ({
      title,
      tests: [
        {
          status,
          projectName,
          results: [
            { status: resultStatus, attachments: attachments.map(([contentType, p]) => ({ contentType, path: p })) },
          ],
        },
      ],
    });
    return {
      suites: [
        {
          title: "smoke.spec.ts",
          specs: [
            spec("checkout", "unexpected", "failed", [
              ["video/webm", failVideo],
              ["image/png", failShot],
            ]),
            spec("home", "expected", "passed", [
              ["image/png", passShot],
              ["video/webm", passVideo],
              ["application/zip", passTrace],
            ]),
            spec("log in", "expected", "passed", [["image/png", setupShot]], "setup"),
          ],
        },
      ],
      errors: [],
    };
  }

  let puts: Array<{ url: string; headers: Record<string, string>; bytes: number }>;

  beforeEach(() => {
    puts = [];
    let n = 0;
    const base = h.deps.call;
    h.deps.call = (async (name: string, args: Record<string, unknown>) => {
      if (name === "createContinuousTestArtifactUpload") {
        h.calls.push({ name, args });
        n += 1;
        return {
          artifactId: `art-${n}`,
          upload: { method: "PUT", url: `https://storage.example/up/${n}`, headers: { "content-type": String(args.mime) } },
        };
      }
      return base(name, args);
    }) as RunnerDeps["call"];
    h.deps.fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      if (init?.method !== "PUT") return new Response("ok", { status: 200 });
      puts.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        bytes: (init?.body as Uint8Array).byteLength,
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    h.playwright = (opts) => {
      writeReport(opts, mixedReport(worktreeOf()));
      return exitedProc(1);
    };
  });

  it("forces capture through a wrapper config, completes first, then uploads (large files directly)", async () => {
    let wrapper = "";
    h.list = () => {
      wrapper = fs.readFileSync(path.join(worktreeOf(), "playwright.projectmind.config.ts"), "utf8");
      return exitedProc(0);
    };
    const summary = await new ContinuousTestRun(modern(), h.deps).done;
    expect(summary).toMatchObject({ outcome: "completed", completed: true, artifactsUploaded: 4 });

    expect(wrapper).toContain('import loaded from "./playwright.config.ts"');
    expect(wrapper).toContain('{"screenshot":"on","video":"on","trace":"retain-on-failure"}');
    const runs = playwrightSpawns().filter((s) => !s.argv.includes("--list"));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv.slice(-2)).toEqual(["--config", path.join(worktreeOf(), "playwright.projectmind.config.ts")]);

    const names = h.calls.map((c) => c.name).filter((n) => n !== "renewContinuousTestRunLease");
    expect(names[0]).toBe("completeContinuousTestRun");

    const uploads = h.calls.filter((c) =>
      ["uploadContinuousTestArtifact", "createContinuousTestArtifactUpload"].includes(c.name),
    );
    // Failed test first (screenshot, then video), then passing media; never a passing trace or setup media.
    expect(uploads.map((u) => [u.name, u.args.name, u.args.resultStatus])).toEqual([
      ["uploadContinuousTestArtifact", "fail.png", "failed"],
      ["createContinuousTestArtifactUpload", "fail.webm", "failed"],
      ["uploadContinuousTestArtifact", "pass.png", "passed"],
      ["uploadContinuousTestArtifact", "pass.webm", "passed"],
    ]);
    expect(uploads[1]!.args.sizeBytes).toBe(1_000_000);
    expect(puts).toEqual([
      { url: "https://storage.example/up/1", headers: { "content-type": "video/webm" }, bytes: 1_000_000 },
    ]);
    expect(h.calls.find((c) => c.name === "finalizeContinuousTestArtifactUpload")?.args).toMatchObject({
      runId: RUN_ID,
      leaseId: "lease-1",
      artifactId: "art-1",
    });
  });

  it("runs the project's own config when the wrapper does not load", async () => {
    h.list = () => exitedProc(1, "", "SyntaxError: Cannot use import statement outside a module");
    const summary = await new ContinuousTestRun(modern(), h.deps).done;
    expect(summary.completed).toBe(true);
    const runs = playwrightSpawns().filter((s) => !s.argv.includes("--list"));
    expect(runs[0]!.argv).toEqual(payload().command.argv);
    expect(h.logs.some((l) => l.includes("capture unavailable"))).toBe(true);
  });

  it("skips large files when the server only takes inline uploads", async () => {
    const base = h.deps.call;
    h.deps.call = (async (name: string, args: Record<string, unknown>) =>
      name === "createContinuousTestArtifactUpload"
        ? { artifactId: null, upload: null, reason: "inline-only" }
        : base(name, args)) as RunnerDeps["call"];
    const summary = await new ContinuousTestRun(modern(), h.deps).done;
    expect(summary.artifactsUploaded).toBe(3);
    expect(puts).toHaveLength(0);
  });

  it("older servers (no capture): failure evidence only, uploaded before completing, no wrapper", async () => {
    const summary = await new ContinuousTestRun(payload(), h.deps).done;
    expect(summary.artifactsUploaded).toBe(1);
    expect(playwrightSpawns().some((s) => s.argv.includes("--list"))).toBe(false);
    const names = h.calls.map((c) => c.name).filter((n) => n !== "renewContinuousTestRunLease");
    expect(names).toEqual(["uploadContinuousTestArtifact", "completeContinuousTestRun"]);
    expect(h.calls[h.calls.findIndex((c) => c.name === "uploadContinuousTestArtifact")]!.args.resultStatus).toBeUndefined();
  });
});
