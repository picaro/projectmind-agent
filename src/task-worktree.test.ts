import { describe, expect, it } from "vitest";
import {
  ensureTaskWorktree,
  isDisposableTaskWorkspacePath,
  pruneStaleTaskWorktrees,
  removeTaskWorktree,
  shouldEnsureTaskWorktree,
} from "./task-worktree.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("shouldEnsureTaskWorktree", () => {
  it("honors mustMaterialize even when the path already exists", () => {
    expect(
      shouldEnsureTaskWorktree(
        { status: "ready", localPath: "/present", mustMaterialize: true },
        () => true,
      ),
    ).toBe(true);
  });

  it("skips recreate when recreateIfMissing is false and path is missing", () => {
    expect(
      shouldEnsureTaskWorktree(
        { status: "ready", localPath: "/gone", recreateIfMissing: false },
        () => false,
      ),
    ).toBe(false);
  });

  it("always materializes pending and leased", () => {
    expect(
      shouldEnsureTaskWorktree(
        { status: "pending", localPath: "/missing" },
        () => true,
      ),
    ).toBe(true);
    expect(
      shouldEnsureTaskWorktree(
        { status: "leased", localPath: "/present" },
        () => true,
      ),
    ).toBe(true);
  });

  it("recreates ready/retained when the path is missing on disk", () => {
    expect(
      shouldEnsureTaskWorktree(
        { status: "ready", localPath: "/gone" },
        () => false,
      ),
    ).toBe(true);
    expect(
      shouldEnsureTaskWorktree(
        { status: "retained", localPath: "/gone" },
        () => false,
      ),
    ).toBe(true);
  });

  it("skips ready when the directory already exists", () => {
    expect(
      shouldEnsureTaskWorktree(
        { status: "ready", localPath: "/present" },
        () => true,
      ),
    ).toBe(false);
  });

  it("never rematerializes cleaned or failed rows", () => {
    expect(
      shouldEnsureTaskWorktree(
        { status: "cleaned", localPath: "/gone" },
        () => false,
      ),
    ).toBe(false);
    expect(
      shouldEnsureTaskWorktree(
        { status: "failed", localPath: "/gone" },
        () => false,
      ),
    ).toBe(false);
  });
});

describe("ensureTaskWorktree", () => {
  it("creates an isolated worktree for pending prep", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-tw-"));
    const base = path.join(root, "base");
    const wt = path.join(root, "tasks", "t1");
    initRepo(base);

    const first = await ensureTaskWorktree({
      id: "tw-1",
      localPath: wt,
      baseLocalPath: base,
      branchName: "pm/task/macagent1",
      baseBranch: "main",
      status: "pending",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.created).toBe(true);
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);

    const second = await ensureTaskWorktree({
      id: "tw-1",
      localPath: wt,
      baseLocalPath: base,
      branchName: "pm/task/macagent1",
      baseBranch: "main",
      status: "pending",
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.created).toBe(false);
  });

  it("recreates a ready worktree after the directory was removed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-tw-recreate-"));
    const base = path.join(root, "base");
    const wt = path.join(root, "tasks", "t-ready");
    initRepo(base);

    const created = await ensureTaskWorktree({
      id: "tw-ready",
      localPath: wt,
      baseLocalPath: base,
      branchName: "pm/task/ready1",
      baseBranch: "main",
      status: "pending",
    });
    expect(created.ok).toBe(true);

    fs.rmSync(wt, { recursive: true, force: true });
    expect(fs.existsSync(wt)).toBe(false);
    expect(shouldEnsureTaskWorktree({ status: "ready", localPath: wt })).toBe(true);

    const recreated = await ensureTaskWorktree({
      id: "tw-ready",
      localPath: wt,
      baseLocalPath: base,
      branchName: "pm/task/ready1",
      baseBranch: "main",
      status: "ready",
    });
    expect(recreated.ok).toBe(true);
    if (recreated.ok) expect(recreated.created).toBe(true);
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
  });

  it("removes a broken non-git leaf and recreates the worktree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-tw-broken-"));
    const base = path.join(root, "base");
    const wt = path.join(root, "tasks", "t-broken");
    initRepo(base);
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, "junk.txt"), "not a worktree\n");

    const recreated = await ensureTaskWorktree({
      id: "tw-broken",
      localPath: wt,
      baseLocalPath: base,
      branchName: "pm/task/broken1",
      baseBranch: "main",
      status: "pending",
      mustMaterialize: true,
    });
    expect(recreated.ok).toBe(true);
    if (recreated.ok) expect(recreated.created).toBe(true);
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
  });
});

describe("isDisposableTaskWorkspacePath", () => {
  it("accepts isolated task worktrees under the managed root", () => {
    expect(
      isDisposableTaskWorkspacePath(
        "/Users/me/.imemory/workspaces/.pm-task-workspaces/abc/task-1",
        "/Users/me/.imemory/workspaces",
      ),
    ).toBe(true);
  });

  it("rejects managed project clones and paths outside the root", () => {
    expect(
      isDisposableTaskWorkspacePath(
        "/Users/me/.imemory/workspaces/imemory",
        "/Users/me/.imemory/workspaces",
      ),
    ).toBe(false);
    expect(
      isDisposableTaskWorkspacePath("/Users/me/code/secret", "/Users/me/.imemory/workspaces"),
    ).toBe(false);
    expect(
      isDisposableTaskWorkspacePath(
        "/Users/me/.imemory/workspaces",
        "/Users/me/.imemory/workspaces",
      ),
    ).toBe(false);
  });
});

describe("removeTaskWorktree / pruneStaleTaskWorktrees", () => {
  it("removes a created worktree from disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-tw-rm-"));
    try {
      const base = path.join(root, "base");
      const wt = path.join(root, ".pm-task-workspaces", "repo", "t1");
      initRepo(base);

      const created = await ensureTaskWorktree({
        id: "tw-rm",
        localPath: wt,
        baseLocalPath: base,
        branchName: "pm/task/rm1",
        baseBranch: "main",
        status: "pending",
      });
      expect(created.ok).toBe(true);
      expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);

      const removed = await removeTaskWorktree(
        { localPath: wt, baseLocalPath: base },
        { managedRoot: root },
      );
      expect(removed.ok).toBe(true);
      if (removed.ok) expect(removed.removed).toBe(true);
      expect(fs.existsSync(wt)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to delete a managed project clone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-tw-refuse-"));
    try {
      const clone = path.join(root, "imemory");
      fs.mkdirSync(clone, { recursive: true });
      fs.writeFileSync(path.join(clone, "keep.txt"), "do not delete\n");

      const refused = await removeTaskWorktree(
        { localPath: clone, baseLocalPath: clone },
        { managedRoot: root },
      );
      expect(refused.ok).toBe(false);
      expect(fs.existsSync(path.join(clone, "keep.txt"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes leftover task worktrees while keeping the active one and sibling clones", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-tw-prune-"));
    try {
      const stale = path.join(root, ".pm-task-workspaces", "repo", "old");
      const active = path.join(root, ".pm-task-workspaces", "repo", "current");
      const clone = path.join(root, "imemory");
      fs.mkdirSync(stale, { recursive: true });
      fs.mkdirSync(active, { recursive: true });
      fs.mkdirSync(clone, { recursive: true });
      fs.writeFileSync(path.join(stale, "gone.txt"), "stale\n");
      fs.writeFileSync(path.join(active, "keep.txt"), "active\n");
      fs.writeFileSync(path.join(clone, "repo.txt"), "clone\n");

      const pruned = await pruneStaleTaskWorktrees({
        managedRoot: root,
        keepPaths: [active],
      });
      expect(pruned.removed).toContain(stale);
      expect(pruned.kept).toContain(active);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(path.join(active, "keep.txt"))).toBe(true);
      expect(fs.existsSync(path.join(clone, "repo.txt"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
