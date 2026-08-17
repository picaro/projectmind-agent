import { describe, expect, it } from "vitest";
import { ensureTaskWorktree, shouldEnsureTaskWorktree } from "./task-worktree.js";
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
});
