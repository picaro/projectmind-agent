/**
 * Workspace side of continuous test runs: which local checkout a run may use,
 * an isolated per-run git worktree at the requested revision, a pinned
 * (lockfile, no install scripts) dependency install, Playwright browser and
 * target reachability checks, and on-disk run state so a restarted agent can
 * kill and clean up a run it lost track of.
 *
 * Layout: `{managedRoot}/.pm-continuous-tests/<runId>/{worktree,tmp,report.json,state.json}`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandTilde, resolveManagedRoot } from "./managed-workspace.js";
import { assertSafeWorkspace, effectiveAllowlist } from "./safety.js";
import { isDisposableTaskWorkspacePath } from "./task-worktree.js";

export const CONTINUOUS_TEST_DIR_NAME = ".pm-continuous-tests";
const PROJECT_DIRS_FILE = "project-workspaces.json";

export function continuousTestStateRoot(managedRoot: string = resolveManagedRoot()): string {
  return path.join(managedRoot, CONTINUOUS_TEST_DIR_NAME);
}

/** `slug=/abs/path,other=/abs/path` from IMEMORY_CONTINUOUS_TEST_WORKSPACES. */
export function parseWorkspaceMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key && value) map.set(key, path.resolve(expandTilde(value)));
  }
  return map;
}

type ProjectWorkspaceRecord = { localDirectory: string; projectSlug?: string | null; updatedAt: string };

function readProjectDirs(stateRoot: string): Record<string, ProjectWorkspaceRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateRoot, PROJECT_DIRS_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Remember which checkout this agent used for a project's user jobs, so a later
 * test run (whose payload has `localDirectory: null`) uses the same one.
 * Disposable task worktrees are never recorded — they are deleted after the job.
 */
export function recordProjectWorkspace(input: {
  projectId: string;
  projectSlug?: string | null;
  localDirectory: string | null | undefined;
  stateRoot?: string;
  managedRoot?: string;
  now?: Date;
}): void {
  const dir = input.localDirectory?.trim();
  if (!input.projectId || !dir || !path.isAbsolute(dir)) return;
  const managedRoot = input.managedRoot ?? resolveManagedRoot();
  if (isDisposableTaskWorkspacePath(dir, managedRoot)) return;
  const stateRoot = input.stateRoot ?? continuousTestStateRoot(managedRoot);
  try {
    fs.mkdirSync(stateRoot, { recursive: true });
    const all = readProjectDirs(stateRoot);
    all[input.projectId] = {
      localDirectory: dir,
      projectSlug: input.projectSlug ?? all[input.projectId]?.projectSlug ?? null,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    const file = path.join(stateRoot, PROJECT_DIRS_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // Best-effort cache; the explicit env map still works without it.
  }
}

export type ResolvedTestWorkspace = { ok: true; baseDir: string } | { ok: false; reason: string };

/**
 * Pick the checkout for a run, then require it to pass the same allowlist
 * check user jobs use. Order: payload path → IMEMORY_CONTINUOUS_TEST_WORKSPACES
 * (by slug or project id) → the checkout last used for this project's jobs.
 */
export function resolveTestWorkspace(input: {
  projectId: string;
  projectSlug: string;
  localDirectory: string | null;
  env?: NodeJS.ProcessEnv;
  stateRoot?: string;
}): ResolvedTestWorkspace {
  const env = input.env ?? process.env;
  const map = parseWorkspaceMap(env.IMEMORY_CONTINUOUS_TEST_WORKSPACES);
  const stateRoot = input.stateRoot ?? continuousTestStateRoot(resolveManagedRoot(env));
  const candidate =
    input.localDirectory?.trim() ||
    map.get(input.projectSlug) ||
    map.get(input.projectId) ||
    readProjectDirs(stateRoot)[input.projectId]?.localDirectory;
  if (!candidate) {
    return {
      ok: false,
      reason:
        `No local checkout known for project ${input.projectSlug}: run a job for it on this computer ` +
        `or set IMEMORY_CONTINUOUS_TEST_WORKSPACES=${input.projectSlug}=/path/to/checkout`,
    };
  }
  const safe = assertSafeWorkspace(candidate, effectiveAllowlist(env));
  if (!safe.ok) return { ok: false, reason: safe.reason };
  if (!fs.existsSync(path.join(safe.cwd, ".git"))) {
    return { ok: false, reason: `Test workspace is not a git checkout: ${safe.cwd}` };
  }
  return { ok: true, baseDir: safe.cwd };
}

/** A revision we will pass to git: a ref/sha, never something git could read as an option. */
export function isSafeGitRevision(rev: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(rev) && !rev.includes("..");
}

/**
 * Origin's default branch from `git ls-remote --symref origin HEAD`
 * (`ref: refs/heads/main\tHEAD`) or `git symbolic-ref refs/remotes/origin/HEAD`
 * (`refs/remotes/origin/main`). Null when neither matches or the name is unsafe.
 */
export function parseOriginDefaultBranch(output: string): string | null {
  const match =
    output.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m) ?? output.trim().match(/^refs\/remotes\/origin\/(\S+)$/);
  const branch = match?.[1];
  return branch && isSafeGitRevision(branch) ? branch : null;
}

export type RunPaths = {
  runDir: string;
  worktree: string;
  tmpDir: string;
  reportPath: string;
  statePath: string;
};

export function runPaths(stateRoot: string, runId: string): RunPaths {
  const safeId = runId.replace(/[^A-Za-z0-9_-]/g, "_");
  const runDir = path.join(stateRoot, safeId);
  return {
    runDir,
    worktree: path.join(runDir, "worktree"),
    tmpDir: path.join(runDir, "tmp"),
    reportPath: path.join(runDir, "report.json"),
    statePath: path.join(runDir, "state.json"),
  };
}

export type RunState = {
  runId: string;
  leaseId: string;
  correlationId: string;
  baseDir: string | null;
  pid: number | null;
  startedAt: string;
};

export function writeRunState(paths: RunPaths, state: RunState): void {
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(paths.statePath, JSON.stringify(state, null, 2));
}

export function listRunStates(stateRoot: string): Array<{ paths: RunPaths; state: RunState | null }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const paths = runPaths(stateRoot, entry.name);
      let state: RunState | null = null;
      try {
        state = JSON.parse(fs.readFileSync(paths.statePath, "utf8")) as RunState;
      } catch {
        state = null;
      }
      return { paths, state };
    });
}

export type LockfileInstall = { manager: "pnpm" | "npm" | "yarn"; argv: string[] };

/**
 * Pinned install from the lockfile only. `--ignore-scripts` keeps the agent's
 * "never execute repository scripts during preparation" policy: Playwright
 * browsers come from the machine cache, not a postinstall hook.
 */
export function lockfileInstallCommand(cwd: string): LockfileInstall | null {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return {
      manager: "pnpm",
      argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    };
  }
  if (
    fs.existsSync(path.join(cwd, "package-lock.json")) ||
    fs.existsSync(path.join(cwd, "npm-shrinkwrap.json"))
  ) {
    return { manager: "npm", argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"] };
  }
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
    return { manager: "yarn", argv: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"] };
  }
  return null;
}

/** Where Playwright keeps browsers for this user (PLAYWRIGHT_BROWSERS_PATH wins). */
export function playwrightBrowsersDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): string | null {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured === "0") {
    return cwd ? path.join(cwd, "node_modules", "playwright-core", ".local-browsers") : null;
  }
  if (configured) return path.resolve(expandTilde(configured));
  const home = env.HOME?.trim() || os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return path.join(local, "ms-playwright");
  }
  return path.join(env.XDG_CACHE_HOME?.trim() || path.join(home, ".cache"), "ms-playwright");
}

/** true/false when we can tell; null when browsers live in a project we have not seen. */
export function detectPlaywrightBrowsers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): boolean | null {
  const dir = playwrightBrowsersDir(env, platform, cwd);
  if (!dir) return null;
  try {
    return fs
      .readdirSync(dir)
      .some((name) => /^(chromium|chromium_headless_shell|firefox|webkit)-\d+$/.test(name));
  } catch {
    return false;
  }
}

export type ReachabilityResult = { ok: true; status: number } | { ok: false; reason: string };

/** One GET with no redirect following; any non-5xx answer means the target is up. */
export async function checkTargetReachable(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<ReachabilityResult> {
  try {
    const res = await fetchImpl(baseUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 500) return { ok: false, reason: `Target answered HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      reason: `Target unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.some((allowed) => allowed.toLowerCase() === host);
  } catch {
    return false;
  }
}
