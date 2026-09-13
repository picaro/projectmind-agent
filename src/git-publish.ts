import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunnerLog } from "./runners/types.js";
import { gitEnvWithCredentials, SENSITIVE_PATH } from "./managed-workspace.js";

const execFileAsync = promisify(execFile);

const MAX_MESSAGE_CHARS = 72;

export type GitPublishResult = {
  /** Whether we attempted any git write (add/commit/push). */
  attempted: boolean;
  /** True when commit and (if enabled) push completed, or there was nothing to commit. */
  ok: boolean;
  /** Short human summary for logs / resultSummary. */
  detail: string;
  committed?: boolean;
  pushed?: boolean;
  sha?: string;
};

export type GitPublishOptions = {
  cwd: string;
  /** Preferred commit subject (runner summary). */
  message: string;
  taskId?: string;
  onLog: RunnerLog;
  /** When false, skip entirely. Default: env IMEMORY_AGENT_GIT_COMMIT !== "0". */
  enabled?: boolean;
  /** When false, commit but do not push. Default: env IMEMORY_AGENT_GIT_PUSH !== "0". */
  push?: boolean;
  /** Inject for tests. */
  runGit?: typeof runGit;
};

/**
 * Credential used for push / PR creation.
 *
 * Set from the short-lived token in the claim response, so an agent works on a
 * machine with no GitHub setup. Falls back to ambient ssh / `gh auth` when the
 * project has no GitHub App connection.
 */
let activeGitCredentials: { username: string; token: string } | null = null;

export function setActiveGitCredentials(
  credentials: { username: string; token: string } | null,
): void {
  activeGitCredentials = credentials;
}

export function getActiveGitCredentials(): { username: string; token: string } | null {
  return activeGitCredentials;
}

export async function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      env: gitEnvWithCredentials(activeGitCredentials),
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

/** Build a short one-line commit subject from the runner summary. */
export function shortCommitMessage(summary: string, taskId?: string): string {
  const lines = summary
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  let base =
    lines.find((l) => !/^(-{3,}|\*{3,}|={3,})$/.test(l)) ||
    (taskId
      ? `Complete ProjectMind task ${taskId.slice(0, 8)}`
      : "ProjectMind agent task complete");

  // Drop common markdown / list prefixes from a first-line summary.
  base = base
    .replace(/\*\*/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();

  if (!base) {
    base = taskId
      ? `Complete ProjectMind task ${taskId.slice(0, 8)}`
      : "ProjectMind agent task complete";
  }

  if (base.length <= MAX_MESSAGE_CHARS) return base;
  return `${base.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

function isGitPublishEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.IMEMORY_AGENT_GIT_COMMIT !== "0";
}

function isPushEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.IMEMORY_AGENT_GIT_PUSH !== "0";
}

/**
 * After a successful agent job: stage, commit with a short message, and push.
 * No-ops when disabled, not a git repo, or the working tree is clean.
 */
export async function commitAndPushAfterTask(
  options: GitPublishOptions,
): Promise<GitPublishResult> {
  const onLog = options.onLog;
  const git = options.runGit ?? runGit;

  if (!isGitPublishEnabled(options.enabled)) {
    return { attempted: false, ok: true, detail: "Git publish disabled" };
  }

  const rev = await git(options.cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (rev.code !== 0 || rev.stdout.trim() !== "true") {
    await onLog("Skipping git publish: not a git repository", "status");
    return { attempted: false, ok: true, detail: "Not a git repository" };
  }

  const status = await git(options.cwd, ["status", "--porcelain"]);
  if (status.code !== 0) {
    const err = status.stderr.trim() || "git status failed";
    await onLog(`Git status failed: ${err}`, "error");
    return { attempted: true, ok: false, detail: err };
  }

  if (!status.stdout.trim()) {
    await onLog("Git: working tree clean — nothing to commit", "status");
    return {
      attempted: false,
      ok: true,
      detail: "Working tree clean — nothing to commit",
    };
  }

  const message = shortCommitMessage(options.message, options.taskId);
  await onLog(`Git: staging changes and committing: ${message}`, "status");

  const add = await git(options.cwd, ["add", "-A"]);
  if (add.code !== 0) {
    const err = add.stderr.trim() || "git add failed";
    await onLog(`Git add failed: ${err}`, "error");
    return { attempted: true, ok: false, detail: err };
  }

  const staged = await git(options.cwd, ["diff", "--cached", "--name-only"]);
  if (staged.code !== 0) {
    const err = staged.stderr.trim() || "git diff --cached failed";
    await onLog(`Git staged listing failed: ${err}`, "error");
    return { attempted: true, ok: false, detail: err };
  }

  const stagedFiles = staged.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (stagedFiles.length === 0) {
    await onLog("Git: nothing staged after add (all ignored?)", "status");
    return {
      attempted: false,
      ok: true,
      detail: "Nothing staged — nothing to commit",
    };
  }

  const secrets = stagedFiles.filter((f) => SENSITIVE_PATH.test(f));
  if (secrets.length > 0) {
    const err = `Refusing to commit sensitive paths: ${secrets.slice(0, 5).join(", ")}`;
    await onLog(err, "error");
    await git(options.cwd, ["reset", "HEAD"]);
    return { attempted: true, ok: false, detail: err };
  }

  const commit = await git(options.cwd, ["commit", "-m", message]);
  if (commit.code !== 0) {
    const err = commit.stderr.trim() || commit.stdout.trim() || "git commit failed";
    await onLog(`Git commit failed: ${err}`, "error");
    return { attempted: true, ok: false, detail: err };
  }

  const shaResult = await git(options.cwd, ["rev-parse", "--short", "HEAD"]);
  const sha = shaResult.code === 0 ? shaResult.stdout.trim() : undefined;
  await onLog(`Git: committed${sha ? ` ${sha}` : ""} — ${message}`, "status");

  if (!isPushEnabled(options.push)) {
    return {
      attempted: true,
      ok: true,
      detail: `Committed ${sha ?? "HEAD"} (push disabled)`,
      committed: true,
      pushed: false,
      sha,
    };
  }

  // A repo-less project's managed workspace is a plain `git init` with no origin.
  // Reporting that plainly beats surfacing git's "does not appear to be a
  // repository" as a push failure the user cannot act on.
  const remotes = await git(options.cwd, ["remote"]);
  if (remotes.code === 0 && !remotes.stdout.trim()) {
    await onLog("Git: no remote configured — changes left in the local checkout", "status");
    return {
      attempted: true,
      ok: true,
      detail: `Committed ${sha ?? "HEAD"} locally (no remote configured)`,
      committed: true,
      pushed: false,
      sha,
    };
  }

  await onLog("Git: pushing to remote", "status");
  const push = await git(options.cwd, ["push"]);
  if (push.code !== 0) {
    // First push of a branch with no upstream.
    const retry = await git(options.cwd, ["push", "-u", "origin", "HEAD"]);
    if (retry.code !== 0) {
      const err =
        (push.stderr || retry.stderr || push.stdout || retry.stdout).trim() || "git push failed";
      await onLog(`Git push failed: ${err}`, "error");
      return {
        attempted: true,
        ok: false,
        detail: `Committed ${sha ?? "HEAD"} but push failed: ${err}`,
        committed: true,
        pushed: false,
        sha,
      };
    }
  }

  await onLog(`Git: pushed${sha ? ` ${sha}` : ""}`, "status");
  return {
    attempted: true,
    ok: true,
    detail: `Committed and pushed ${sha ?? "HEAD"}: ${message}`,
    committed: true,
    pushed: true,
    sha,
  };
}

export type EnsurePullRequestOptions = {
  cwd: string;
  baseBranch: string;
  title: string;
  body?: string;
  onLog: RunnerLog;
  /** Inject for tests. */
  runGh?: (
    cwd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

async function runGh(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        // Use the same short-lived credential as git, so PRs work on a machine
        // where `gh auth login` was never run.
        ...(activeGitCredentials?.token ? { GH_TOKEN: activeGitCredentials.token } : {}),
      },
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

/**
 * Ensure a GitHub PR exists for the current branch (view existing or create).
 * Returns the PR URL when available.
 */
export async function ensurePullRequest(
  options: EnsurePullRequestOptions,
): Promise<{ ok: boolean; prUrl: string | null; detail: string }> {
  const gh = options.runGh ?? runGh;
  const onLog = options.onLog;

  const existing = await gh(options.cwd, ["pr", "view", "--json", "url", "-q", ".url"]);
  if (existing.code === 0 && existing.stdout.trim()) {
    const prUrl = existing.stdout.trim();
    await onLog(`GitHub: existing PR ${prUrl}`, "status");
    return { ok: true, prUrl, detail: `Existing PR ${prUrl}` };
  }

  await onLog(`GitHub: creating pull request against ${options.baseBranch}`, "status");
  const created = await gh(options.cwd, [
    "pr",
    "create",
    "--base",
    options.baseBranch,
    "--title",
    options.title,
    "--body",
    options.body?.trim() || options.title,
  ]);
  if (created.code !== 0) {
    const err = (created.stderr || created.stdout).trim() || "gh pr create failed";
    await onLog(`GitHub PR create failed: ${err}`, "error");
    return { ok: false, prUrl: null, detail: err };
  }

  const urlFromCreate = created.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^https?:\/\/github\.com\//i.test(l));
  if (urlFromCreate) {
    await onLog(`GitHub: created PR ${urlFromCreate}`, "status");
    return { ok: true, prUrl: urlFromCreate, detail: `Created PR ${urlFromCreate}` };
  }

  const view = await gh(options.cwd, ["pr", "view", "--json", "url", "-q", ".url"]);
  const prUrl = view.code === 0 ? view.stdout.trim() || null : null;
  if (prUrl) {
    await onLog(`GitHub: PR ${prUrl}`, "status");
    return { ok: true, prUrl, detail: `PR ${prUrl}` };
  }

  return { ok: false, prUrl: null, detail: "PR created but URL not available" };
}
