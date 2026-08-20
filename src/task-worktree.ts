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

export type RemoveTaskWorktreeResult =
  | { ok: true; removed: boolean; detail: string }
  | { ok: false; reason: string };

/**
 * Remove a task worktree from disk. The control plane cannot do this for Mac
 * agents (paths live on this host); call after every job that used a TaskWorkspace.
 */
export async function removeTaskWorktree(
  prep: Pick<TaskWorkspacePrep, "localPath" | "baseLocalPath">,
  deps: { runGit?: typeof runGit } = {},
): Promise<RemoveTaskWorktreeResult> {
  const base = path.resolve(prep.baseLocalPath.trim());
  const worktree = path.resolve(prep.localPath.trim());
  if (!base || !worktree) {
    return { ok: false, reason: "Task workspace prep is missing required paths" };
  }
  if (!path.isAbsolute(base) || !path.isAbsolute(worktree)) {
    return { ok: false, reason: "Task workspace paths must be absolute" };
  }

  if (!fs.existsSync(worktree)) {
    if (fs.existsSync(base)) {
      const git = deps.runGit ?? runGit;
      await git(base, ["worktree", "prune"]);
    }
    return { ok: true, removed: false, detail: "Worktree already absent" };
  }

  const git = deps.runGit ?? runGit;
  if (fs.existsSync(base)) {
    const remove = await git(base, ["worktree", "remove", "--force", worktree]);
    if (remove.code === 0) {
      return { ok: true, removed: true, detail: `Removed worktree at ${worktree}` };
    }
    await git(base, ["worktree", "prune"]);
  }

  try {
    fs.rmSync(worktree, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to remove worktree ${worktree}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (fs.existsSync(worktree)) {
    return { ok: false, reason: `Worktree still present after remove: ${worktree}` };
  }
  return { ok: true, removed: true, detail: `Removed worktree at ${worktree}` };
}

export type PruneStaleTaskWorktreesResult = {
  scanned: number;
  removed: number;
  failed: number;
  bytesFreedEstimate: number;
  details: string[];
};

/**
 * Delete leftover leaves under `{managedRoot}/.pm-task-workspaces/**`.
 *
 * The control plane often marks rows `cleaned` when the path is absent on the
 * *server*, which leaves Mac checkouts behind forever. Run on agent startup and
 * after jobs so disk does not grow without bound.
 *
 * @param maxAgeMs — only remove directories whose mtime is older than this.
 *   `0` removes every leaf not listed in `keepPaths`.
 */
export function pruneStaleTaskWorktrees(input: {
  managedRoot: string;
  maxAgeMs?: number;
  keepPaths?: Iterable<string>;
  nowMs?: number;
}): PruneStaleTaskWorktreesResult {
  const managedRoot = path.resolve(input.managedRoot.trim());
  const maxAgeMs = Math.max(0, input.maxAgeMs ?? 0);
  const nowMs = input.nowMs ?? Date.now();
  const keep = new Set(
    [...(input.keepPaths ?? [])].map((p) => path.resolve(p.trim())).filter(Boolean),
  );

  const result: PruneStaleTaskWorktreesResult = {
    scanned: 0,
    removed: 0,
    failed: 0,
    bytesFreedEstimate: 0,
    details: [],
  };

  const root = path.join(managedRoot, ".pm-task-workspaces");
  if (!fs.existsSync(root)) return result;

  let repoDirs: string[] = [];
  try {
    repoDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return result;
  }

  for (const repoDir of repoDirs) {
    let leaves: string[] = [];
    try {
      leaves = fs
        .readdirSync(repoDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(repoDir, d.name));
    } catch {
      continue;
    }

    for (const leaf of leaves) {
      result.scanned += 1;
      const resolved = path.resolve(leaf);
      if (keep.has(resolved)) continue;

      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(leaf).mtimeMs;
      } catch {
        continue;
      }
      if (maxAgeMs > 0 && nowMs - mtimeMs < maxAgeMs) continue;

      try {
        // Cheap size estimate before delete (du of large trees is too slow here).
        result.bytesFreedEstimate += estimateDirSizeBytes(leaf, 2000);
        fs.rmSync(leaf, { recursive: true, force: true });
        result.removed += 1;
        result.details.push(`removed ${leaf}`);
      } catch (err) {
        result.failed += 1;
        result.details.push(
          `failed ${leaf}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Drop empty repo fragment dirs.
    try {
      if (fs.readdirSync(repoDir).length === 0) {
        fs.rmdirSync(repoDir);
      }
    } catch {
      // ignore
    }
  }

  return result;
}

/** Bounded walk so prune stays fast even when a leaf is multi-GB. */
function estimateDirSizeBytes(dir: string, maxEntries: number): number {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0 && seen < maxEntries) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) break;
      seen += 1;
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch {
        // ignore
      }
    }
  }
  return total;
}

/** Default: drop task worktrees idle longer than 2 hours. */
export const DEFAULT_TASK_WORKTREE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function parseTaskWorktreeMaxAgeMs(
  raw: string | undefined,
  fallback: number = DEFAULT_TASK_WORKTREE_MAX_AGE_MS,
): number {
  if (raw == null || !raw.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
