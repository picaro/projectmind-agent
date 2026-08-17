/**
 * Ensure a TaskWorkspace git worktree exists on the Mac agent host.
 * Uses execFile — never concatenates untrusted strings into a shell.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TaskWorkspacePrep = {
  id: string;
  localPath: string;
  baseLocalPath: string;
  branchName: string;
  baseBranch: string;
  status: string;
};

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      code: 0,
      stdout: typeof stdout === "string" ? stdout : String(stdout),
      stderr: typeof stderr === "string" ? stderr : String(stderr),
    };
  } catch (err) {
    const e = err as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout != null ? String(e.stdout) : "",
      stderr: e.stderr != null ? String(e.stderr) : e.message || String(err),
    };
  }
}

export type EnsureTaskWorktreeResult =
  | { ok: true; created: boolean; detail: string }
  | { ok: false; reason: string };

/**
 * Whether claim prep should materialize (or rematerialize) the task worktree.
 *
 * `pending` / `leased` always need creation. `ready` / `retained` / `expired`
 * normally skip when the directory is already on disk, but must recreate when
 * cleanup, another host, or a wiped checkout left the path missing — otherwise
 * assertSafeWorkspace fails with "local_directory does not exist".
 * `cleaned` / `failed` are terminal allocations; do not recreate those rows.
 */
export function shouldEnsureTaskWorktree(
  prep: Pick<TaskWorkspacePrep, "status" | "localPath">,
  existsSync: (p: string) => boolean = fs.existsSync,
): boolean {
  const status = prep.status.trim().toLowerCase();
  if (!status || status === "cleaned" || status === "failed") return false;
  if (status === "pending" || status === "leased") return true;
  const worktree = path.resolve(prep.localPath.trim());
  if (!worktree) return false;
  return !existsSync(worktree);
}

/**
 * Create the isolated worktree when claim metadata says it is still pending,
 * or rematerialize when the allocated path is missing on disk.
 */
export async function ensureTaskWorktree(
  prep: TaskWorkspacePrep,
  deps: { runGit?: typeof runGit } = {},
): Promise<EnsureTaskWorktreeResult> {
  const base = path.resolve(prep.baseLocalPath.trim());
  const worktree = path.resolve(prep.localPath.trim());
  const branch = prep.branchName.trim();
  if (!base || !worktree || !branch) {
    return { ok: false, reason: "Task workspace prep is missing required paths/branch" };
  }
  if (!path.isAbsolute(base) || !path.isAbsolute(worktree)) {
    return { ok: false, reason: "Task workspace paths must be absolute" };
  }

  const git = deps.runGit ?? runGit;

  if (fs.existsSync(worktree)) {
    const inside = await git(worktree, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code === 0 && inside.stdout.trim().includes("true")) {
      return { ok: true, created: false, detail: "Worktree already present" };
    }
    return { ok: false, reason: `Path exists but is not a git worktree: ${worktree}` };
  }

  const baseInside = await git(base, ["rev-parse", "--is-inside-work-tree"]);
  if (baseInside.code !== 0 || !baseInside.stdout.trim().includes("true")) {
    return { ok: false, reason: `Base path is not a git repository: ${base}` };
  }

  // Path missing but git may still list a stale worktree entry — prune so add
  // can recreate the same path after successful-job cleanup or a wiped checkout.
  await git(base, ["worktree", "prune"]);

  fs.mkdirSync(path.dirname(worktree), { recursive: true });

  const add = await git(base, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  if (add.code !== 0) {
    const retry = await git(base, ["worktree", "add", worktree, branch]);
    if (retry.code !== 0) {
      return {
        ok: false,
        reason: `git worktree add failed: ${(add.stderr || retry.stderr || add.stdout).trim()}`,
      };
    }
  }

  return { ok: true, created: true, detail: `Created worktree at ${worktree} on ${branch}` };
}
