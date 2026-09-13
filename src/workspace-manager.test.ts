import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareWorkspace, verifyWorkspaceUsable } from "./workspace-manager.js";
import type { RunGit } from "./managed-workspace.js";

const credentials = { username: "x-access-token", token: "ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const repository = { cloneUrl: "https://github.com/org/app.git", defaultBranch: "main" };

let tmpRoot: string;
let managedRoot: string;
let allowRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-prepare-"));
  managedRoot = path.join(tmpRoot, "managed");
  allowRoot = path.join(tmpRoot, "allow");
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.mkdirSync(allowRoot, { recursive: true });
  process.env.IMEMORY_MANAGED_WORKSPACE_ROOT = managedRoot;
  process.env.IMEMORY_WORKSPACE_ALLOWLIST = allowRoot;
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
    const target = path.join(managedRoot, "managed-app");
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

  it("never resets a user-configured (allowlisted) checkout outside the managed root", async () => {
    // The core safety guarantee of this refactor for personal directories.
    const target = path.join(allowRoot, "user-app");
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

  it("treats an allowlisted claim under the managed root as managed (hard-reset)", async () => {
    const target = path.join(managedRoot, "misbound-app");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    const logs: string[] = [];
    const { runGit, calls } = fakeGit(headStub);

    const result = await prepareWorkspace({
      localPath: target,
      containment: "allowlisted",
      mode: "clone",
      repository,
      credentials,
      runGit,
      onLog: (line) => logs.push(line),
    });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.join(" ")).some((c) => c.startsWith("reset --hard"))).toBe(true);
    expect(logs.some((l) => /treating as managed/i.test(l))).toBe(true);
  });

  it("leaves a user checkout with no origin remote alone instead of failing it", async () => {
    // Regression guard: before this refactor a hand-configured directory got no
    // preparation at all, so a local-only repo worked. It must keep working.
    const target = path.join(allowRoot, "user-no-origin");
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
    const target = path.join(managedRoot, "twice");
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
    const target = path.join(managedRoot, "no-repo");
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
    const target = path.join(managedRoot, "no-clone-url");
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
    const target = path.join(managedRoot, "archive-no-url");
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

describe("prepareWorkspace existing non-git folder", () => {
  it("adopts a person-configured folder that already holds source code", async () => {
    const target = path.join(allowRoot, "client-code");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "main.py"), "print(1)\n");
    const { runGit, calls } = fakeGit((args) =>
      args[0] === "diff" ? { code: 0, stdout: "main.py\n" } : { code: 0, stdout: "abc123\n" },
    );

    const result = await prepareWorkspace({
      localPath: target,
      containment: "allowlisted",
      mode: "empty",
      repository: null,
      credentials: null,
      runGit,
    });

    expect(result).toMatchObject({ ok: true, action: "initialized" });
    expect(calls.map((c) => c[0])).toContain("init");
    expect(calls.some((c) => c.includes("commit"))).toBe(true);
    expect(calls.some((c) => c[0] === "clone" || c[0] === "fetch")).toBe(false);
    expect(fs.readFileSync(path.join(target, "main.py"), "utf8")).toBe("print(1)\n");
  });

  it("still refuses a non-empty non-git folder the agent owns", async () => {
    const target = path.join(managedRoot, "half-cloned");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "junk"), "x");
    const { runGit, calls } = fakeGit();

    const result = await prepareWorkspace({
      localPath: target,
      containment: "managed",
      mode: "empty",
      repository: null,
      credentials: null,
      runGit,
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("prepareWorkspace failure reporting", () => {
  it("returns a reason instead of throwing, so only the current job fails", async () => {
    const target = path.join(managedRoot, "broken");
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
