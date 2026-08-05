import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import {
  assertPathInsideManagedRoot,
  ensureManagedArchiveWorkspace,
  ensureManagedClone,
  ensureManagedEmptyWorkspace,
  ensureUserWorkspace,
  resolveArchiveEntryPath,
  gitEnvWithCredentials,
  resolveManagedRoot,
  restoreWorkspaceDefaultBranch,
  type RunGit,
} from "./managed-workspace.js";

const TOKEN = "ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const credentials = { username: "x-access-token", token: TOKEN };

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-managed-root-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resolveManagedRoot", () => {
  it("uses IMEMORY_MANAGED_WORKSPACE_ROOT when set", () => {
    expect(resolveManagedRoot({ IMEMORY_MANAGED_WORKSPACE_ROOT: "/srv/ws" })).toBe("/srv/ws");
  });

  it("defaults to ~/.imemory/workspaces", () => {
    expect(resolveManagedRoot({})).toBe(path.join(os.homedir(), ".imemory", "workspaces"));
  });

  it("expands a leading ~ that an env file left unexpanded", () => {
    expect(resolveManagedRoot({ IMEMORY_MANAGED_WORKSPACE_ROOT: "~/.imemory/workspaces" })).toBe(
      path.join(os.homedir(), ".imemory", "workspaces"),
    );
    expect(resolveManagedRoot({ IMEMORY_MANAGED_WORKSPACE_ROOT: "~" })).toBe(os.homedir());
  });

  it("leaves a ~ that is not a home reference alone", () => {
    expect(resolveManagedRoot({ IMEMORY_MANAGED_WORKSPACE_ROOT: "/srv/~ws" })).toBe("/srv/~ws");
  });
});

describe("assertPathInsideManagedRoot", () => {
  it("accepts a leaf that does not exist yet — that is the point", () => {
    const target = path.join(tmpRoot, "my-app");
    const result = assertPathInsideManagedRoot(target, tmpRoot);
    expect(result.ok).toBe(true);
  });

  it("rejects traversal out of the root", () => {
    const result = assertPathInsideManagedRoot(path.join(tmpRoot, "..", "elsewhere"), tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes/);
  });

  it("rejects an unrelated absolute path", () => {
    const result = assertPathInsideManagedRoot("/etc", tmpRoot);
    expect(result.ok).toBe(false);
  });

  it("rejects a relative path", () => {
    const result = assertPathInsideManagedRoot("relative/dir", tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/absolute/);
  });

  it("rejects an empty path", () => {
    expect(assertPathInsideManagedRoot("", tmpRoot).ok).toBe(false);
  });

  it("blocks a symlink that points outside the root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pm-outside-"));
    try {
      const link = path.join(tmpRoot, "sneaky");
      fs.symlinkSync(outside, link);

      const result = assertPathInsideManagedRoot(path.join(link, "app"), tmpRoot);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/escapes/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("creates the root if it does not exist yet", () => {
    const root = path.join(tmpRoot, "nested", "root");
    const result = assertPathInsideManagedRoot(path.join(root, "app"), root);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
  });
});

describe("gitEnvWithCredentials", () => {
  it("passes the token via env, never argv or .git/config", () => {
    const env = gitEnvWithCredentials(credentials, {});

    expect(env.IMEMORY_GH_TOKEN).toBe(TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    // The helper reads the token from the environment; it must not inline it.
    expect(env.GIT_CONFIG_VALUE_0).not.toContain(TOKEN);
    expect(env.GIT_CONFIG_VALUE_0).toContain("$IMEMORY_GH_TOKEN");
  });

  it("never lets git prompt for credentials", () => {
    const env = gitEnvWithCredentials(null, {});
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("/usr/bin/false");
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });
});

function recordingGit(handler: (args: string[]) => { code: number; stdout?: string }) {
  const calls: string[][] = [];
  const runGit: RunGit = async (_cwd, args) => {
    calls.push(args);
    const result = handler(args);
    return { code: result.code, stdout: result.stdout ?? "", stderr: "" };
  };
  return { runGit, calls };
}

describe("ensureManagedEmptyWorkspace", () => {
  it("creates and initializes a directory for a project with no repository", async () => {
    const target = path.join(tmpRoot, "no-repo-app");
    const { runGit, calls } = recordingGit(() => ({ code: 0 }));

    const result = await ensureManagedEmptyWorkspace({ localPath: target, runGit });

    expect(result).toEqual({ ok: true, created: true, headSha: null });
    expect(fs.existsSync(target)).toBe(true);
    expect(calls).toEqual([["init"]]);
  });

  it("reuses an existing repo without resetting it — there is no remote to reset to", async () => {
    const target = path.join(tmpRoot, "already-there");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    const { runGit, calls } = recordingGit((args) =>
      args[0] === "rev-parse" ? { code: 0, stdout: "localsha\n" } : { code: 0 },
    );

    const result = await ensureManagedEmptyWorkspace({ localPath: target, runGit });

    expect(result).toEqual({ ok: true, created: false, headSha: "localsha" });
    const verbs = calls.map((c) => c[0]);
    expect(verbs).not.toContain("init");
    expect(verbs).not.toContain("reset");
  });

  it("refuses a directory that exists but is not a git repository", async () => {
    const target = path.join(tmpRoot, "user-data");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "important.txt"), "user data");
    const { runGit, calls } = recordingGit(() => ({ code: 0 }));

    const result = await ensureManagedEmptyWorkspace({ localPath: target, runGit });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a git repository/);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(target, "important.txt"))).toBe(true);
  });

  it("reports a git init failure", async () => {
    const target = path.join(tmpRoot, "init-fails");
    const runGit: RunGit = async () => ({ code: 1, stdout: "", stderr: "permission denied" });

    const result = await ensureManagedEmptyWorkspace({ localPath: target, runGit });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/git init failed: permission denied/);
  });

  it("initializes a directory that exists but is empty, same as if it were absent", async () => {
    // Regression test: ensureAllowlistedWorkspace creates a hand-configured leaf
    // directory before this function ever runs (that is how naming a not-yet-
    // existing folder is supposed to work), so this must not be mistaken for a
    // pre-existing directory with real content in it.
    const target = path.join(tmpRoot, "pre-created-empty");
    fs.mkdirSync(target, { recursive: true });
    const { runGit, calls } = recordingGit(() => ({ code: 0 }));

    const result = await ensureManagedEmptyWorkspace({ localPath: target, runGit });

    expect(result).toEqual({ ok: true, created: true, headSha: null });
    expect(calls).toEqual([["init"]]);
  });
});

describe("ensureManagedClone", () => {
  it("clones when the directory does not exist", async () => {
    const target = path.join(tmpRoot, "fresh-app");
    const { runGit, calls } = recordingGit((args) =>
      args[0] === "rev-parse" ? { code: 0, stdout: "deadbeef\n" } : { code: 0 },
    );

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: true, headSha: "deadbeef" });
    expect(calls[0]).toEqual([
      "clone",
      "--origin",
      "origin",
      "https://github.com/org/app.git",
      target,
    ]);
    // The clone URL must be tokenless — the credential travels in the env.
    expect(calls[0].join(" ")).not.toContain(TOKEN);
  });

  it("clones into a directory that exists but is empty, same as if it were absent", async () => {
    // Regression test: ensureAllowlistedWorkspace creates a hand-configured leaf
    // directory before this function ever runs, so an empty pre-existing directory
    // must be cloned into exactly like a missing one instead of being refused.
    const target = path.join(tmpRoot, "pre-created-empty");
    fs.mkdirSync(target, { recursive: true });
    const { runGit, calls } = recordingGit((args) =>
      args[0] === "rev-parse" ? { code: 0, stdout: "deadbeef\n" } : { code: 0 },
    );

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: true, headSha: "deadbeef" });
    expect(calls[0][0]).toBe("clone");
  });

  it("fetches and hard-resets an existing checkout instead of re-cloning", async () => {
    const target = path.join(tmpRoot, "existing");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) =>
      args[0] === "rev-parse" ? { code: 0, stdout: "cafe123\n" } : { code: 0 },
    );

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: false, headSha: "cafe123" });
    const verbs = calls.map((c) => c[0]);
    expect(verbs).toContain("fetch");
    expect(verbs).toContain("reset");
    expect(verbs).not.toContain("clone");
    // A cold node_modules on every job would be a serious regression.
    expect(verbs).not.toContain("clean");
  });

  it("skips checkout and reset when already at the target commit on the target branch", async () => {
    const target = path.join(tmpRoot, "already-current");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: "cafe123\n" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
      if (args[0] === "status") return { code: 0, stdout: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "cafe123\n" };
      return { code: 0 };
    });

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: false, headSha: "cafe123" });
    const verbs = calls.map((c) => c[0]);
    expect(verbs).toContain("fetch");
    expect(verbs).not.toContain("checkout");
    expect(verbs).not.toContain("reset");
  });

  it("still hard-resets when on the target commit but the working tree is dirty", async () => {
    const target = path.join(tmpRoot, "current-but-dirty");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: "cafe123\n" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
      if (args[0] === "status") return { code: 0, stdout: " M leftover.ts\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "cafe123\n" };
      return { code: 0 };
    });

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: false, headSha: "cafe123" });
    expect(calls).toContainEqual(["checkout", "-f", "main"]);
    expect(calls).toContainEqual(["reset", "--hard", "origin/main"]);
  });

  it("falls back to origin/HEAD when the named branch is missing", async () => {
    const target = path.join(tmpRoot, "odd-branch");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 128 };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/trunk\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc\n" };
      return { code: 0 };
    });

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result.ok).toBe(true);
    expect(calls).toContainEqual(["checkout", "-f", "trunk"]);
    expect(calls).toContainEqual(["reset", "--hard", "origin/trunk"]);
  });

  it("refuses a directory that exists but is not a git repository", async () => {
    const target = path.join(tmpRoot, "not-a-repo");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "important.txt"), "user data");

    const { runGit, calls } = recordingGit(() => ({ code: 0 }));

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a git repository/);
    // Must not have touched it — no delete-and-reclone.
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(target, "important.txt"))).toBe(true);
  });

  it("reports a clone failure with the token scrubbed from stderr", async () => {
    const target = path.join(tmpRoot, "fails");
    const runGit: RunGit = async () => ({
      code: 128,
      stdout: "",
      stderr: `fatal: could not read from https://x-access-token:${TOKEN}@github.com/org/app.git`,
    });

    const result = await ensureManagedClone({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain(TOKEN);
      expect(result.reason).toContain("***");
    }
  });

  it("never emits the token through onLog", async () => {
    const target = path.join(tmpRoot, "logged");
    const lines: string[] = [];
    const runGit: RunGit = async (_cwd, args) => ({
      code: 0,
      stdout: args[0] === "rev-parse" ? "sha\n" : "",
      stderr: "",
    });

    await ensureManagedClone({
      localPath: target,
      cloneUrl: `https://x-access-token:${TOKEN}@github.com/org/app.git`,
      defaultBranch: "main",
      credentials,
      onLog: (line) => lines.push(line),
      runGit,
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(TOKEN);
  });
});

describe("resolveArchiveEntryPath", () => {
  it("accepts ordinary nested entries", () => {
    const root = path.join(tmpRoot, "ws");
    expect(resolveArchiveEntryPath(root, "src/index.ts")).toBe(path.join(root, "src/index.ts"));
    expect(resolveArchiveEntryPath(root, "README.md")).toBe(path.join(root, "README.md"));
  });

  it("refuses entries that try to escape the workspace", () => {
    const root = path.join(tmpRoot, "ws");
    // Classic zip-slip, plus the variants that survive naive normalization.
    expect(resolveArchiveEntryPath(root, "../evil.txt")).toBeNull();
    expect(resolveArchiveEntryPath(root, "src/../../evil.txt")).toBeNull();
    expect(resolveArchiveEntryPath(root, "..\\evil.txt")).toBeNull();
    expect(resolveArchiveEntryPath(root, "/etc/passwd")).toBeNull();
    expect(resolveArchiveEntryPath(root, "C:\\Windows\\system32")).toBeNull();
    expect(resolveArchiveEntryPath(root, "bad\0name")).toBeNull();
  });

  it("skips directory entries and empty names", () => {
    const root = path.join(tmpRoot, "ws");
    expect(resolveArchiveEntryPath(root, "src/")).toBeNull();
    expect(resolveArchiveEntryPath(root, "")).toBeNull();
  });
});

describe("ensureManagedArchiveWorkspace", () => {
  const okGit: RunGit = async () => ({ code: 0, stdout: "", stderr: "" });

  function zipOf(files: Record<string, string>): Uint8Array {
    const encoded: Record<string, Uint8Array> = {};
    for (const [name, body] of Object.entries(files)) {
      encoded[name] = new TextEncoder().encode(body);
    }
    return zipSync(encoded);
  }

  it("unpacks the archive and initializes a repo", async () => {
    const localPath = path.join(tmpRoot, "proj");
    const archive = zipOf({ "README.md": "hello", "src/index.ts": "export {};" });

    const result = await ensureManagedArchiveWorkspace({
      localPath,
      archiveUrl: "https://example.test/signed",
      runGit: okGit,
      fetchArchive: async () => archive,
    });

    expect(result).toEqual({ ok: true, created: true, headSha: null });
    expect(fs.readFileSync(path.join(localPath, "README.md"), "utf8")).toBe("hello");
    expect(fs.readFileSync(path.join(localPath, "src/index.ts"), "utf8")).toBe("export {};");
  });

  it("writes nothing at all when any entry is unsafe", async () => {
    const localPath = path.join(tmpRoot, "proj");
    const archive = zipOf({ "good.txt": "fine", "../escape.txt": "bad" });

    const result = await ensureManagedArchiveWorkspace({
      localPath,
      archiveUrl: "https://example.test/signed",
      runGit: okGit,
      fetchArchive: async () => archive,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unsafe path/);
    // Validation happens before the first write, so no partial tree is left.
    expect(fs.existsSync(localPath)).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, "escape.txt"))).toBe(false);
  });

  it("leaves an existing repo untouched instead of re-unpacking over it", async () => {
    const localPath = path.join(tmpRoot, "proj");
    fs.mkdirSync(path.join(localPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(localPath, "work.txt"), "in progress");

    const result = await ensureManagedArchiveWorkspace({
      localPath,
      archiveUrl: "https://example.test/signed",
      runGit: async () => ({ code: 0, stdout: "abc123\n", stderr: "" }),
      fetchArchive: async () => {
        throw new Error("must not download when the workspace already exists");
      },
    });

    expect(result).toEqual({ ok: true, created: false, headSha: "abc123" });
    expect(fs.readFileSync(path.join(localPath, "work.txt"), "utf8")).toBe("in progress");
  });

  it("fails loudly when the directory exists, is not a repo, and has real content", async () => {
    const localPath = path.join(tmpRoot, "proj");
    fs.mkdirSync(localPath, { recursive: true });
    fs.writeFileSync(path.join(localPath, "important.txt"), "user data");

    const result = await ensureManagedArchiveWorkspace({
      localPath,
      archiveUrl: "https://example.test/signed",
      runGit: okGit,
      fetchArchive: async () => zipOf({ "a.txt": "a" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a git repository/);
    expect(fs.existsSync(path.join(localPath, "important.txt"))).toBe(true);
  });

  it("unpacks into a directory that exists but is empty, same as if it were absent", async () => {
    // Regression test: the allowlisted-path safety check creates a hand-configured
    // leaf directory before this function ever runs, so "exists" alone cannot mean
    // "has content to protect" — only a non-empty directory does.
    const localPath = path.join(tmpRoot, "proj");
    fs.mkdirSync(localPath, { recursive: true });
    const archive = zipOf({ "README.md": "hello" });

    const result = await ensureManagedArchiveWorkspace({
      localPath,
      archiveUrl: "https://example.test/signed",
      runGit: okGit,
      fetchArchive: async () => archive,
    });

    expect(result).toEqual({ ok: true, created: true, headSha: null });
    expect(fs.readFileSync(path.join(localPath, "README.md"), "utf8")).toBe("hello");
  });

  it("reports a download failure without leaking the signed URL", async () => {
    const localPath = path.join(tmpRoot, "proj");

    const result = await ensureManagedArchiveWorkspace({
      localPath,
      archiveUrl: "https://example.test/signed?token=SECRET",
      runGit: okGit,
      fetchArchive: async () => {
        throw new Error("archive download failed with HTTP 403");
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 403/);
      expect(result.reason).not.toContain("SECRET");
    }
  });

  it("rejects an archive with no files", async () => {
    const localPath = path.join(tmpRoot, "proj");

    const result = await ensureManagedArchiveWorkspace({
      localPath,
      archiveUrl: "https://example.test/signed",
      runGit: okGit,
      fetchArchive: async () => zipSync({}),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no files/);
  });
});

describe("ensureUserWorkspace", () => {
  it("clones when the directory does not exist — nothing to lose", async () => {
    const target = path.join(tmpRoot, "user-fresh");
    const { runGit, calls } = recordingGit((args) =>
      args[0] === "rev-parse" ? { code: 0, stdout: "deadbeef\n" } : { code: 0 },
    );

    const result = await ensureUserWorkspace({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: true, headSha: "deadbeef" });
    expect(calls[0][0]).toBe("clone");
  });

  it("fast-forwards an existing checkout and never resets it", async () => {
    // The whole contract of a user-configured directory: it may hold uncommitted
    // work, so no command may discard local state.
    const target = path.join(tmpRoot, "user-existing");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 0, stdout: "https://github.com/org/app.git\n" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "main\n" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: "cafe123\n" };
      return { code: 0 };
    });

    const result = await ensureUserWorkspace({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: false, headSha: "cafe123" });

    const flat = calls.map((c) => c.join(" "));
    expect(flat).toContain("fetch origin --prune");
    expect(flat).toContain("merge --ff-only origin/main");
    // The safety-critical assertions.
    expect(flat.some((c) => c.startsWith("reset"))).toBe(false);
    expect(flat.some((c) => c.startsWith("clean"))).toBe(false);
  });

  it("auto-stashes dirty changes then switches to the default branch", async () => {
    // Previous agent runs often leave allowlisted checkouts on a feature branch
    // with uncommitted edits. Prepare must not fail — stash, then checkout.
    const target = path.join(tmpRoot, "user-dirty");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 0, stdout: "https://github.com/org/app.git\n" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "feature/wip\n" };
      }
      if (args[0] === "status") return { code: 0, stdout: " M src/app.ts\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "cafe123\n" };
      return { code: 0 };
    });

    const result = await ensureUserWorkspace({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: false, headSha: "cafe123" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.startsWith("stash push"))).toBe(true);
    expect(flat).toContain("checkout main");
    expect(flat.some((c) => c.startsWith("reset"))).toBe(false);
  });

  it("fails when auto-stash cannot preserve dirty work before a branch switch", async () => {
    const target = path.join(tmpRoot, "user-stash-fail");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 0, stdout: "https://github.com/org/app.git\n" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "feature/wip\n" };
      }
      if (args[0] === "status") return { code: 0, stdout: " M src/app.ts\n" };
      if (args[0] === "stash") return { code: 1, stderr: "stash failed\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "cafe123\n" };
      return { code: 0 };
    });

    const result = await ensureUserWorkspace({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("auto-stash failed");
      expect(result.reason).toContain("retry");
    }
    expect(calls.map((c) => c.join(" ")).some((c) => c.startsWith("checkout"))).toBe(false);
  });

  it("fails with an actionable message when the branch has diverged", async () => {
    const target = path.join(tmpRoot, "user-diverged");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 0, stdout: "https://github.com/org/app.git\n" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "main\n" };
      }
      if (args[0] === "merge") return { code: 1 };
      if (args[0] === "rev-parse") return { code: 0, stdout: "cafe123\n" };
      return { code: 0 };
    });

    const result = await ensureUserWorkspace({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("diverged");
      expect(result.reason).toContain("retry");
    }
  });

  it("refuses a non-empty directory that is not a repository", async () => {
    const target = path.join(tmpRoot, "user-not-a-repo");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "notes.txt"), "mine");

    const { runGit } = recordingGit(() => ({ code: 0 }));

    const result = await ensureUserWorkspace({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a git repository");
  });
  it("accepts a local-only checkout that has no origin remote", async () => {
    // Someone may point the agent at a directory that was never cloned from
    // anywhere. There is nothing to fetch, and that is not an error.
    const target = path.join(tmpRoot, "user-no-origin");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 1 };
      if (args[0] === "rev-parse") return { code: 0, stdout: "local123\n" };
      return { code: 0 };
    });

    const result = await ensureUserWorkspace({
      localPath: target,
      cloneUrl: "https://github.com/org/app.git",
      defaultBranch: "main",
      credentials,
      runGit,
    });

    expect(result).toEqual({ ok: true, created: false, headSha: "local123" });
    expect(calls.map((c) => c.join(" ")).some((c) => c.startsWith("fetch"))).toBe(false);
  });
});

describe("restoreWorkspaceDefaultBranch", () => {
  it("checks out the default branch on an allowlisted feature-branch leftover", async () => {
    const target = path.join(tmpRoot, "restore-allowlisted");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 0, stdout: "https://github.com/org/app.git\n" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "feature/done\n" };
      }
      if (args[0] === "status") return { code: 0, stdout: "" };
      return { code: 0 };
    });

    const result = await restoreWorkspaceDefaultBranch({
      localPath: target,
      defaultBranch: "main",
      containment: "allowlisted",
      credentials,
      runGit,
    });

    expect(result).toEqual({
      ok: true,
      restored: true,
      branch: "main",
      detail: "checked out main",
    });
    expect(calls.map((c) => c.join(" "))).toContain("checkout main");
    expect(calls.map((c) => c.join(" ")).some((c) => c.startsWith("reset"))).toBe(false);
  });

  it("stashes dirty allowlisted leftovers before returning to main", async () => {
    const target = path.join(tmpRoot, "restore-dirty");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 0, stdout: "https://github.com/org/app.git\n" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "feature/wip\n" };
      }
      if (args[0] === "status") return { code: 0, stdout: " M leftover.ts\n" };
      return { code: 0 };
    });

    const result = await restoreWorkspaceDefaultBranch({
      localPath: target,
      defaultBranch: "main",
      containment: "allowlisted",
      credentials,
      runGit,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.restored).toBe(true);
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.startsWith("stash push"))).toBe(true);
    expect(flat).toContain("checkout main");
  });

  it("hard-resets managed workspaces left on a feature branch", async () => {
    const target = path.join(tmpRoot, "restore-managed");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    const { runGit, calls } = recordingGit((args) => {
      if (args[0] === "remote") return { code: 0, stdout: "https://github.com/org/app.git\n" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "feature/done\n" };
      }
      if (args[0] === "status") return { code: 0, stdout: "" };
      return { code: 0 };
    });

    const result = await restoreWorkspaceDefaultBranch({
      localPath: target,
      defaultBranch: "main",
      containment: "managed",
      credentials,
      runGit,
    });

    expect(result).toEqual({
      ok: true,
      restored: true,
      branch: "main",
      detail: "hard-reset to origin/main",
    });
    expect(calls).toContainEqual(["checkout", "-f", "main"]);
    expect(calls).toContainEqual(["reset", "--hard", "origin/main"]);
  });
});
