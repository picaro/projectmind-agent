import { describe, expect, it } from "vitest";
import { ensureTaskWorktree } from "./task-worktree.js";
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
});
