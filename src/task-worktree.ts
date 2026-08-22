/**
 * Ensure a TaskWorkspace git worktree exists on the Mac agent host,
 * and delete it when the job is done so leftover checkouts cannot fill the disk.
 * Uses execFile — never concatenates untrusted strings into a shell.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveManagedRoot } from "./managed-workspace.js";

const execFileAsync = promisify(execFile);

/** Directory name used by the control plane for isolated per-task worktrees. */
export const TASK_WORKSPACE_DIR_NAME = ".pm-task-workspaces";

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * True when `localPath` is an isolated task worktree under this agent's managed
 * root. Anything else (allowlisted checkouts, managed project clones) must never
 * be deleted by worktree cleanup.
 */
export function isDisposableTaskWorkspacePath(localPath: string, managedRoot: string): boolean {
  const root = path.resolve(managedRoot.trim());
  const target = path.resolve((localPath ?? "").trim());
  if (!root || !target || !path.isAbsolute(target)) return false;
  if (!isPathInside(root, target) || target === root) return false;
  const rel = path.relative(root, target);
  return rel.split(path.sep).includes(TASK_WORKSPACE_DIR_NAME);
}

export type TaskWorkspacePrep = {
  id: string;
  localPath: string;
  baseLocalPath: string;
  branchName: string;
  baseBranch: string;
  status: string;
  /** Control-plane hint: always run worktree add before using cwd. */
  mustMaterialize?: boolean;
  /** Control-plane hint: rematerialize when the leaf is missing on disk. */
  recreateIfMissing?: boolean;
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
 * Prefer explicit `mustMaterialize` / `recreateIfMissing` from the control plane
 * when present. Otherwise: `pending` / `leased` always need creation;
 * `ready` / `retained` / `expired` recreate when the path is missing;
 * `cleaned` / `failed` are terminal allocations.
 */
export function shouldEnsureTaskWorktree(
  prep: Pick<
    TaskWorkspacePrep,
    "status" | "localPath" | "mustMaterialize" | "recreateIfMissing"
  >,
  existsSync: (p: string) => boolean = fs.existsSync,
): boolean {
  if (prep.mustMaterialize === true) return true;
  const status = prep.status.trim().toLowerCase();
  if (!status || status === "cleaned" || status === "failed") return false;
  if (status === "pending" || status === "leased") return true;
  const worktree = path.resolve(prep.localPath.trim());
  if (!worktree) return false;
  if (prep.recreateIfMissing === false) return false;
  // Default (and recreateIfMissing: true): rematerialize when the leaf is gone.
  return !existsSync(worktree);
}

/**
 * Create the isolated worktree when claim metadata says it is still pending,
 * or rematerialize when the allocated path is missing / broken on disk.
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
    // Empty or broken leaf — remove and recreate (first-time reprovision).
    try {
      fs.rmSync(worktree, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        reason: `Path exists but is not a git worktree and could not be removed: ${worktree} (${
          err instanceof Error ? err.message : String(err)
        })`,
      };
    }
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

export type RemoveTaskWorktreeResult =
  | { ok: true; removed: boolean; detail: string }
  | { ok: false; reason: string };

/**
 * Remove one task worktree from disk. Refuses paths that are not under
 * `{managedRoot}/.pm-task-workspaces`.
 */
export async function removeTaskWorktree(
  prep: Pick<TaskWorkspacePrep, "localPath" | "baseLocalPath">,
  deps: { runGit?: typeof runGit; managedRoot?: string } = {},
): Promise<RemoveTaskWorktreeResult> {
  const managedRoot = deps.managedRoot ?? resolveManagedRoot();
  const worktree = path.resolve((prep.localPath ?? "").trim());
  const base = path.resolve((prep.baseLocalPath ?? "").trim());
  if (!worktree || !path.isAbsolute(worktree)) {
    return { ok: false, reason: "Task workspace path is missing" };
  }
  if (!isDisposableTaskWorkspacePath(worktree, managedRoot)) {
    return {
      ok: false,
      reason: `Refusing to delete non-task-workspace path: ${worktree}`,
    };
  }

  const git = deps.runGit ?? runGit;
  if (!fs.existsSync(worktree)) {
    if (base && path.isAbsolute(base) && fs.existsSync(base)) {
      await git(base, ["worktree", "prune"]);
    }
    return { ok: true, removed: false, detail: "Worktree already absent" };
  }

  if (base && path.isAbsolute(base) && fs.existsSync(base)) {
    const removed = await git(base, ["worktree", "remove", "--force", worktree]);
    if (removed.code === 0) {
      return { ok: true, removed: true, detail: `Removed worktree at ${worktree}` };
    }
    await git(base, ["worktree", "prune"]);
  }

  try {
    fs.rmSync(worktree, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to delete worktree ${worktree}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, removed: true, detail: `Removed worktree at ${worktree}` };
}

export type PruneStaleTaskWorktreesResult = {
  removed: string[];
  kept: string[];
  errors: string[];
};

function listTaskWorkspaceLeaves(taskRoot: string): string[] {
  const leaves: string[] = [];
  let repos: fs.Dirent[];
  try {
    repos = fs.readdirSync(taskRoot, { withFileTypes: true });
  } catch {
    return leaves;
  }
  for (const repo of repos) {
    if (!repo.isDirectory()) continue;
    const repoDir = path.join(taskRoot, repo.name);
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(repoDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isDirectory()) leaves.push(path.join(repoDir, child.name));
    }
  }
  return leaves;
}

function normalizeKeepPaths(keepPaths: string[] | undefined): Set<string> {
  const keep = new Set<string>();
  for (const raw of keepPaths ?? []) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    keep.add(path.resolve(trimmed));
  }
  return keep;
}

async function pruneRegisteredWorktrees(
  managedRoot: string,
  git: typeof runGit,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(managedRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === TASK_WORKSPACE_DIR_NAME) continue;
    const repo = path.join(managedRoot, ent.name);
    if (!fs.existsSync(path.join(repo, ".git"))) continue;
    await git(repo, ["worktree", "prune"]);
  }
}

/**
 * Delete leftover isolated task worktrees under `{managedRoot}/.pm-task-workspaces`.
 * Never touches managed project clones or allowlisted paths. `keepPaths` are
 * skipped (the job currently running).
 */
export async function pruneStaleTaskWorktrees(input: {
  managedRoot: string;
  keepPaths?: string[];
  runGit?: typeof runGit;
}): Promise<PruneStaleTaskWorktreesResult> {
  const managedRoot = path.resolve(input.managedRoot.trim());
  const result: PruneStaleTaskWorktreesResult = { removed: [], kept: [], errors: [] };
  if (!managedRoot || !path.isAbsolute(managedRoot)) {
    result.errors.push("managedRoot must be an absolute path");
    return result;
  }

  const taskRoot = path.join(managedRoot, TASK_WORKSPACE_DIR_NAME);
  if (!fs.existsSync(taskRoot)) return result;

  const keep = normalizeKeepPaths(input.keepPaths);
  const git = input.runGit ?? runGit;

  for (const leaf of listTaskWorkspaceLeaves(taskRoot)) {
    if (!isDisposableTaskWorkspacePath(leaf, managedRoot)) {
      result.errors.push(`Skipped unexpected path: ${leaf}`);
      continue;
    }
    if (keep.has(path.resolve(leaf))) {
      result.kept.push(leaf);
      continue;
    }
    try {
      fs.rmSync(leaf, { recursive: true, force: true });
      result.removed.push(leaf);
    } catch (err) {
      result.errors.push(
        `Failed to delete ${leaf}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    for (const repo of fs.readdirSync(taskRoot, { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      const repoDir = path.join(taskRoot, repo.name);
      try {
        if (fs.readdirSync(repoDir).length === 0) fs.rmdirSync(repoDir);
      } catch {
        // leave non-empty or busy directories
      }
    }
  } catch {
    // ignore
  }

  await pruneRegisteredWorktrees(managedRoot, git);
  return result;
}

export function formatTaskWorktreePruneLog(result: PruneStaleTaskWorktreesResult): string | null {
  if (result.removed.length === 0 && result.errors.length === 0) return null;
  const parts: string[] = [];
  if (result.removed.length > 0) {
    parts.push(`pruned ${result.removed.length} leftover task worktree(s)`);
  }
  if (result.errors.length > 0) {
    parts.push(`${result.errors.length} error(s): ${result.errors[0]}`);
  }
  return parts.join("; ");
}
