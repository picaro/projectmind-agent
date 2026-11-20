import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecJobArgv,
  maxChildWorkers,
  parseExecJobArgs,
  resolveExecJobSpawnSpec,
  resolveSelfSpawnSpec,
  shouldSpawnQueuedChild,
  spawnExecJobProcess,
  stopAllChildWorkers,
  liveChildWorkerCount,
} from "./child-jobs.js";
import { parseCliCommand } from "./cli-commands.js";

describe("child-jobs", () => {
  afterEach(async () => {
    await stopAllChildWorkers(200);
  });

  it("parses exec-job --jobId", () => {
    expect(parseExecJobArgs(["--jobId", "abc"])).toEqual({ jobId: "abc" });
    expect(parseExecJobArgs([])).toEqual({ error: "exec-job requires --jobId <uuid>" });
  });

  it("builds spawn argv without starting a second poller", () => {
    expect(buildExecJobArgv("job-1")).toEqual(["exec-job", "--jobId", "job-1"]);
    const spec = resolveExecJobSpawnSpec("job-1");
    expect(spec.args).toContain("exec-job");
    expect(spec.args).not.toEqual([]);
  });

  it("re-invokes the script behind an npm bin symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "self-spawn-"));
    try {
      const script = join(dir, "cli.cjs");
      writeFileSync(script, "");
      const bin = join(dir, "projectmind-agent");
      symlinkSync(script, bin);
      const spec = resolveSelfSpawnSpec(["node", "run"], { argv: ["/usr/bin/node", bin], execPath: "/usr/bin/node" });
      expect(spec).toEqual({ command: "/usr/bin/node", args: [realpathSync(script), "node", "run"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a packaged binary without a script entry", () => {
    const spec = resolveSelfSpawnSpec(["node", "run"], {
      argv: ["/opt/projectmind-agent", "/opt/projectmind-agent"],
      execPath: "/opt/projectmind-agent",
      realpath: (path) => path,
    });
    expect(spec).toEqual({ command: "/opt/projectmind-agent", args: ["node", "run"] });
    expect(
      resolveSelfSpawnSpec(["x"], { argv: ["/usr/bin/node", "/src/index.ts"], execPath: "/usr/bin/node" }).args,
    ).toEqual(["/src/index.ts", "x"]);
  });

  it("caps in-flight child workers", () => {
    expect(maxChildWorkers(3)).toBe(3);
    expect(maxChildWorkers(null)).toBe(2);
    expect(
      shouldSpawnQueuedChild({
        childJobId: "c1",
        status: "queued",
        alreadySpawned: new Set(),
        inFlight: 2,
        max: 2,
      }),
    ).toBe(false);
    expect(
      shouldSpawnQueuedChild({
        childJobId: "c1",
        status: "queued",
        alreadySpawned: new Set(),
        inFlight: 0,
        max: 2,
      }),
    ).toBe(true);
    expect(
      shouldSpawnQueuedChild({
        childJobId: "c1",
        status: "running",
        alreadySpawned: new Set(),
        inFlight: 0,
        max: 2,
      }),
    ).toBe(false);
  });

  it("parses exec-job as a CLI command without starting the poller", () => {
    expect(parseCliCommand(["exec-job", "--jobId", "abc"])).toEqual({
      command: "exec-job",
      args: ["--jobId", "abc"],
    });
    expect(parseCliCommand([])).toEqual({ command: null, args: [] });
  });

  it("stopAllChildWorkers SIGTERMs spawned processes", async () => {
    spawnExecJobProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    expect(liveChildWorkerCount()).toBeGreaterThanOrEqual(1);
    await stopAllChildWorkers(1_000);
    expect(liveChildWorkerCount()).toBe(0);
  });
});
