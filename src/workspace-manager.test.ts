import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareWorkspace, verifyWorkspaceUsable } from "./workspace-manager.js";
import type { RunGit } from "./managed-workspace.js";

const credentials = { username: "x-access-token", token: "ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const repository = { cloneUrl: "https://github.com/org/app.git", defaultBranch: "main" };

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-prepare-"));
  process.env.IMEMORY_MANAGED_WORKSPACE_ROOT = tmpRoot;
  process.env.IMEMORY_WORKSPACE_ALLOWLIST = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.IMEMORY_MANAGED_WORKSPACE_ROOT;
  delete process.env.IMEMORY_WORKSPACE_ALLOWLIST;
  vi.restoreAllMocks();
});

/**
 * Stands in for git. Reports a valid repo so the post-condition check passes,
 * and records every command so tests can assert on what was (not) run.
 */
function fakeGit(
  overrides: (args: string[]) => { code: number; stdout?: string } = () => ({
    code: 0,
  }),
) {
  const calls: string[][] = [];
  const runGit: RunGit = async (cwd, args) => {
    calls.push(args);
    // Materialize what the real command would have produced, so the usability
    // check at the end of prepareWorkspace sees a real repository.
    if (args[0] === "clone") {
      fs.mkdirSync(path.join(args[args.length - 1]!, ".git"), { recursive: true });
    }
    if (args[0] === "init") fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    const result = overrides(args);
    return { code: result.code, stdout: result.stdout ?? "", stderr: "" };
  };
  return { runGit, calls };
}

const headStub = (args: string[]) =>
  args[0] === "remote"
    ? { code: 0, stdout: "https://github.com/org/app.git\n" }
    : args[0] === "rev-parse" && args[1] === "--abbrev-ref"
      ? { code: 0, stdout: "main\n" }
      : args[0] === "rev-parse"
        ? { code: 0, stdout: "deadbeef\n" }
        : { code: 0 };

describe("prepareWorkspace containment routing", () => {
  it("hard-resets an agent-owned (managed) checkout", async () => {
    const target = path.join(tmpRoot, "managed-app");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    const { runGit, calls } = fakeGit(headStub);

    const result = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "clone",
      repository,
      credentials,
      runGit,
    });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.join(" ")).some((c) => c.startsWith("reset --hard"))).toBe(true);
  });

  it("never resets a user-configured (allowlisted) checkout", async () => {
    // The core safety guarantee of this refactor.
    const target = path.join(tmpRoot, "user-app");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    const { runGit, calls } = fakeGit(headStub);

    const result = await prepareWorkspace({
      localPath: target,
      containment: "allowlisted",
      mode: "clone",
      repository,
      credentials,
      runGit,
    });

    expect(result.ok).toBe(true);
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.startsWith("reset"))).toBe(false);
    expect(flat).toContain("merge --ff-only origin/main");
  });

  it("leaves a user checkout with no origin remote alone instead of failing it", async () => {
    // Regression guard: before this refactor a hand-configured directory got no
    // preparation at all, so a local-only repo worked. It must keep working.
    const target = path.join(tmpRoot, "user-no-origin");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    const { runGit, calls } = fakeGit((args) =>
      args[0] === "remote"
        ? { code: 1 }
        : args[0] === "rev-parse"
          ? { code: 0, stdout: "local123\n" }
          : { code: 0 },
    );

    const result = await prepareWorkspace({
      localPath: target,
      containment: "allowlisted",
      mode: "clone",
      repository,
      credentials,
      runGit,
    });

    expect(result).toMatchObject({ ok: true, action: "refreshed" });
    expect(calls.some((c) => c[0] === "fetch")).toBe(false);
  });

  it("rejects a path outside the agent's own boundary", async () => {
    // A path from the control plane is a request, never an authorization.
    const { runGit, calls } = fakeGit(headStub);

    const result = await prepareWorkspace({
      localPath: "/etc/definitely-not-allowed",
      containment: "managed",
      mode: "clone",
      repository,
      credentials,
      runGit,
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("prepareWorkspace idempotency", () => {
  it("clones once, then only fetches on subsequent calls", async () => {
    const target = path.join(tmpRoot, "twice");
    const { runGit, calls } = fakeGit(headStub);

    const first = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "clone",
      repository,
      credentials,
      runGit,
    });
    expect(first).toMatchObject({ ok: true, created: true, action: "cloned" });

    calls.length = 0;

    const second = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "clone",
      repository,
      credentials,
      runGit,
    });
    expect(second).toMatchObject({ ok: true, created: false, action: "refreshed" });
    expect(calls.some((c) => c[0] === "clone")).toBe(false);
  });
});

describe("prepareWorkspace modes", () => {
  it("initializes an empty repo for a project with no repository", async () => {
    const target = path.join(tmpRoot, "no-repo");
    const { runGit, calls } = fakeGit();

    const result = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "empty",
      repository: null,
      credentials: null,
      runGit,
    });

    expect(result).toMatchObject({ ok: true, action: "initialized" });
    expect(calls).toEqual([["init"]]);
  });

  it("treats a clone request with no clone URL as an empty workspace", async () => {
    // A project may legitimately have no repository; the work just stays local.
    const target = path.join(tmpRoot, "no-clone-url");
    const { runGit } = fakeGit();

    const result = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "clone",
      repository: { cloneUrl: null, defaultBranch: null },
      credentials: null,
      runGit,
    });

    expect(result).toMatchObject({ ok: true, action: "initialized" });
  });

  it("refuses archive mode with no download link rather than silently starting empty", async () => {
    const target = path.join(tmpRoot, "archive-no-url");
    const { runGit, calls } = fakeGit();

    const result = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "archive",
      repository: null,
      credentials: null,
      archiveDownloadUrl: null,
      runGit,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("re-upload");
    expect(calls).toEqual([]);
  });
});

describe("prepareWorkspace failure reporting", () => {
  it("returns a reason instead of throwing, so only the current job fails", async () => {
    const target = path.join(tmpRoot, "broken");
    const { runGit } = fakeGit((args) => (args[0] === "clone" ? { code: 128 } : { code: 0 }));

    const result = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "clone",
      repository,
      credentials,
      runGit,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("git clone failed");
  });

  it("rejects an empty path", async () => {
    const result = await prepareWorkspace({
      localPath: "   ",
      containment: "managed",
      mode: "clone",
      repository,
      credentials,
    });
    expect(result.ok).toBe(false);
  });
});

describe("verifyWorkspaceUsable", () => {
  it("fails a directory that is not a git repository", () => {
    const target = path.join(tmpRoot, "plain");
    fs.mkdirSync(target, { recursive: true });
    expect(verifyWorkspaceUsable(target)).toMatchObject({ ok: false });
  });

  it("passes a real repository", () => {
    const target = path.join(tmpRoot, "repo");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    expect(verifyWorkspaceUsable(target)).toEqual({ ok: true });
  });
});
