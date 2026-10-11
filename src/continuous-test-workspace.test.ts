import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkTargetReachable,
  detectPlaywrightBrowsers,
  hostAllowed,
  isSafeGitRevision,
  lockfileInstallCommand,
  parseWorkspaceMap,
  playwrightBrowsersDir,
  recordProjectWorkspace,
  resolveTestWorkspace,
} from "./continuous-test-workspace.js";

let root: string;
let allowed: string;
let managed: string;
let stateRoot: string;

function gitDir(p: string): string {
  fs.mkdirSync(path.join(p, ".git"), { recursive: true });
  return p;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-ct-ws-")));
  allowed = path.join(root, "allowed");
  managed = path.join(root, "managed");
  stateRoot = path.join(managed, ".pm-continuous-tests");
  fs.mkdirSync(allowed, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { IMEMORY_WORKSPACE_ALLOWLIST: allowed, IMEMORY_MANAGED_WORKSPACE_ROOT: managed, ...extra };
}

describe("resolveTestWorkspace", () => {
  it("prefers the payload path, then the env map (slug or id), then the recorded job checkout", () => {
    const a = gitDir(path.join(allowed, "a"));
    const b = gitDir(path.join(allowed, "b"));
    const c = gitDir(path.join(allowed, "c"));
    recordProjectWorkspace({ projectId: "p1", localDirectory: c, stateRoot, managedRoot: managed });
    const base = { projectId: "p1", projectSlug: "shop", stateRoot };

    expect(resolveTestWorkspace({ ...base, localDirectory: a, env: env({ IMEMORY_CONTINUOUS_TEST_WORKSPACES: `shop=${b}` }) })).toEqual({ ok: true, baseDir: a });
    expect(resolveTestWorkspace({ ...base, localDirectory: null, env: env({ IMEMORY_CONTINUOUS_TEST_WORKSPACES: `shop=${b}` }) })).toEqual({ ok: true, baseDir: b });
    expect(resolveTestWorkspace({ ...base, localDirectory: null, env: env({ IMEMORY_CONTINUOUS_TEST_WORKSPACES: `p1=${b}` }) })).toEqual({ ok: true, baseDir: b });
    expect(resolveTestWorkspace({ ...base, localDirectory: null, env: env() })).toEqual({ ok: true, baseDir: c });
  });

  it("refuses paths outside the allowlist, symlink escapes, non-git dirs, and unknown projects", () => {
    const outside = gitDir(path.join(root, "outside"));
    const link = path.join(allowed, "link");
    fs.symlinkSync(outside, link);
    const plain = path.join(allowed, "plain");
    fs.mkdirSync(plain);
    const base = { projectId: "p1", projectSlug: "shop", stateRoot, env: env() };

    expect(resolveTestWorkspace({ ...base, localDirectory: outside })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    expect(resolveTestWorkspace({ ...base, localDirectory: link })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    expect(resolveTestWorkspace({ ...base, localDirectory: plain })).toMatchObject({ ok: false, reason: expect.stringMatching(/not a git checkout/) });
    expect(resolveTestWorkspace({ ...base, localDirectory: null })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/IMEMORY_CONTINUOUS_TEST_WORKSPACES=shop=/),
    });
  });

  it("never records disposable task worktrees", () => {
    const wt = path.join(managed, ".pm-task-workspaces", "t1");
    recordProjectWorkspace({ projectId: "p1", localDirectory: wt, stateRoot, managedRoot: managed });
    expect(fs.existsSync(path.join(stateRoot, "project-workspaces.json"))).toBe(false);
  });
});

describe("helpers", () => {
  it("parseWorkspaceMap", () => {
    expect([...parseWorkspaceMap("a=/x, b = /y ,bad,=z").entries()]).toEqual([
      ["a", "/x"],
      ["b", "/y"],
    ]);
  });

  it("isSafeGitRevision blocks option injection and ranges", () => {
    expect(isSafeGitRevision("main")).toBe(true);
    expect(isSafeGitRevision("deadbeef")).toBe(true);
    expect(isSafeGitRevision("release/1.2")).toBe(true);
    expect(isSafeGitRevision("--upload-pack=evil")).toBe(false);
    expect(isSafeGitRevision("a..b")).toBe(false);
    expect(isSafeGitRevision("a b")).toBe(false);
  });

  it("lockfileInstallCommand picks a frozen, script-free install", () => {
    const dir = path.join(root, "proj");
    fs.mkdirSync(dir);
    expect(lockfileInstallCommand(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    expect(lockfileInstallCommand(dir)?.argv).toEqual(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    expect(lockfileInstallCommand(dir)?.argv).toContain("--frozen-lockfile");
    expect(lockfileInstallCommand(dir)?.argv).toContain("--ignore-scripts");
  });

  it("detects Playwright browsers per platform and override", () => {
    expect(playwrightBrowsersDir({ HOME: "/h" }, "darwin")).toBe("/h/Library/Caches/ms-playwright");
    expect(playwrightBrowsersDir({ HOME: "/h" }, "linux")).toBe("/h/.cache/ms-playwright");
    expect(playwrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: "0" }, "darwin")).toBeNull();
    const dir = path.join(root, "pw");
    fs.mkdirSync(dir);
    expect(detectPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: dir })).toBe(false);
    fs.mkdirSync(path.join(dir, "chromium_headless_shell-1200"));
    expect(detectPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: dir })).toBe(true);
    expect(detectPlaywrightBrowsers({ PLAYWRIGHT_BROWSERS_PATH: "0" })).toBeNull();
  });

  it("hostAllowed", () => {
    expect(hostAllowed("https://Shop.example.com/x", ["shop.example.com"])).toBe(true);
    expect(hostAllowed("https://evil.com", ["shop.example.com"])).toBe(false);
    expect(hostAllowed("nope", ["x"])).toBe(false);
  });

  it("checkTargetReachable: non-5xx is up, 5xx / network errors are unavailable", async () => {
    const respond = (status: number) => (async () => new Response(null, { status })) as typeof fetch;
    expect(await checkTargetReachable("https://x", respond(302))).toEqual({ ok: true, status: 302 });
    expect(await checkTargetReachable("https://x", respond(503))).toMatchObject({ ok: false, reason: "Target answered HTTP 503" });
    const fail = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await checkTargetReachable("https://x", fail)).toMatchObject({ ok: false, reason: expect.stringMatching(/ECONNREFUSED/) });
  });
});
