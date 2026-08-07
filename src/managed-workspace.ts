import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "./redact.js";

const execFileAsync = promisify(execFile);

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 *
 * Env files and UI text fields do not undergo shell expansion, so a path like
 * `~/.imemory/workspaces/my-app` would be treated as a relative path with a
 * literal `~` segment.  This helper normalises the common case without a full
 * shell invocation.
 */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export type GitCredentials = {
  username: string;
  token: string;
};

/**
 * Root for workspaces this agent creates and owns.
 *
 * Read from the agent's OWN environment, never from the job payload. The
 * control plane sends a computed leaf path, but the root it must live under is
 * decided here — otherwise a compromised or buggy control plane could make the
 * agent clone into /, ~/.ssh, or another project's checkout.
 */
export function resolveManagedRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.IMEMORY_MANAGED_WORKSPACE_ROOT?.trim();
  if (configured) {
    // `~` in an env *file* is never expanded by a shell, so an unexpanded one
    // would resolve against the agent's cwd and clone into a literal "~"
    // directory inside whatever it happened to be launched from.
    const expanded =
      configured === "~"
        ? os.homedir()
        : configured.startsWith("~/")
          ? path.join(os.homedir(), configured.slice(2))
          : configured;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), ".imemory", "workspaces");
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type ManagedPathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Verify a server-supplied path lives inside this agent's managed root.
 *
 * Unlike assertSafeWorkspace this tolerates a leaf that does not exist yet —
 * that is the whole point, the clone has not happened. The root is created if
 * missing so realpath can resolve it, and both sides are realpath'd so a
 * symlinked root cannot be used to escape.
 */
export function assertPathInsideManagedRoot(
  requestedPath: string,
  managedRoot: string,
): ManagedPathCheck {
  const requested = expandTilde(requestedPath?.trim() ?? "");
  if (!requested) return { ok: false, reason: "managed workspace path is empty" };
  if (!path.isAbsolute(requested)) {
    return { ok: false, reason: `managed workspace path must be absolute: ${requested}` };
  }

  let realRoot: string;
  try {
    fs.mkdirSync(managedRoot, { recursive: true });
    realRoot = fs.realpathSync(managedRoot);
  } catch (err) {
    return {
      ok: false,
      reason: `cannot prepare managed workspace root ${managedRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Realpath the deepest existing ancestor so a symlinked parent cannot smuggle
  // the target outside the root.
  const resolved = path.resolve(requested);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync(ancestor);
  } catch {
    realAncestor = ancestor;
  }

  const remainder = path.relative(ancestor, resolved);
  const effective = remainder ? path.resolve(realAncestor, remainder) : realAncestor;

  if (!isPathInside(realRoot, effective)) {
    return {
      ok: false,
      reason: `managed workspace path escapes IMEMORY_MANAGED_WORKSPACE_ROOT (${realRoot}): ${effective}`,
    };
  }

  return { ok: true, path: effective };
}

/**
 * Git environment carrying a short-lived credential.
 *
 * The token is injected via GIT_CONFIG_* rather than a credential helper file
 * or a `https://user:token@host` remote:
 *   - it never lands in .git/config, so it cannot outlive the process
 *   - it never appears in argv, so it is invisible to `ps`
 *   - it is not written to disk anywhere
 */
export function gitEnvWithCredentials(
  credentials: GitCredentials | null,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  };

  if (!credentials?.token) return env;

  env.IMEMORY_GH_TOKEN = credentials.token;
  env.IMEMORY_GH_USERNAME = credentials.username || "x-access-token";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 =
    '!f() { test "$1" = get && ' +
    'printf "username=%s\\npassword=%s\\n" "$IMEMORY_GH_USERNAME" "$IMEMORY_GH_TOKEN"; }; f';

  return env;
}

export type RunGit = (
  cwd: string,
  args: string[],
  credentials: GitCredentials | null,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runGitCommand: RunGit = async (cwd, args, credentials) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      env: gitEnvWithCredentials(credentials),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
};

export type EnsureManagedCloneInput = {
  localPath: string;
  cloneUrl: string;
  defaultBranch: string;
  credentials: GitCredentials | null;
  onLog?: (line: string) => void;
  runGit?: RunGit;
};

export type EnsureManagedCloneResult =
  | { ok: true; created: boolean; headSha: string | null }
  | { ok: false; reason: string };

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * True for a directory with nothing in it (including one that does not exist).
 *
 * The safety/containment step (ensureAllowlistedWorkspace / assertPathInsideManagedRoot)
 * creates a hand-configured path's leaf directory before these functions ever see
 * it — that is how naming a not-yet-existing folder is supposed to work. An empty
 * directory therefore carries the same "nothing to lose" guarantee as one that does
 * not exist yet, so it must be handled the same way instead of being mistaken for
 * a pre-existing directory with real content in it.
 */
function isEmptyDirectory(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

export type EnsureManagedEmptyWorkspaceInput = {
  localPath: string;
  onLog?: (line: string) => void;
  runGit?: RunGit;
};

/**
 * Make `localPath` a usable working tree for a project with no repository.
 *
 *  - absent            -> mkdir + git init (the runner and the worktree step both
 *                         need a git repo, and a commit history is the only record
 *                         of what the agent did here)
 *  - existing repo     -> leave it exactly as it is; there is no remote to reset to,
 *                         so resetting would destroy the only copy of prior work
 *  - existing non-repo -> fail loudly, same as the clone path
 */
export async function ensureManagedEmptyWorkspace(
  input: EnsureManagedEmptyWorkspaceInput,
): Promise<EnsureManagedCloneResult> {
  const runGit = input.runGit ?? runGitCommand;
  const log = (line: string) => input.onLog?.(line);

  const localPath = path.resolve(input.localPath);

  if (fs.existsSync(localPath)) {
    if (isGitRepo(localPath)) {
      log(`Reusing existing local-only workspace at ${localPath}`);
      const head = await runGit(localPath, ["rev-parse", "HEAD"], null);
      return { ok: true, created: false, headSha: head.code === 0 ? head.stdout.trim() : null };
    }
    if (!isEmptyDirectory(localPath)) {
      return {
        ok: false,
        reason: `managed workspace exists but is not a git repository: ${localPath}. Remove it or point the agent elsewhere.`,
      };
    }
    // Empty and not a repo — same as absent, fall through to git init below.
  }

  log(`Creating empty workspace at ${localPath} (no repository connected)`);
  try {
    fs.mkdirSync(localPath, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `cannot create managed workspace ${localPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const init = await runGit(localPath, ["init"], null);
  if (init.code !== 0) {
    return { ok: false, reason: `git init failed: ${init.stderr}` };
  }

  // No HEAD yet — an initialized repo has no commits.
  return { ok: true, created: true, headSha: null };
}

export type EnsureManagedArchiveWorkspaceInput = {
  localPath: string;
  /** Short-lived signed URL from the claim response. Never persisted, never logged. */
  archiveUrl: string;
  onLog?: (line: string) => void;
  runGit?: RunGit;
  /** Injected in tests so the unpack logic can be exercised without a network. */
  fetchArchive?: (url: string) => Promise<Uint8Array>;
};

/**
 * Total uncompressed bytes we are willing to write from one archive.
 *
 * A zip can expand to orders of magnitude more than its compressed size, so the
 * limit enforced at upload time says nothing about what lands on disk.
 */
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Resolve one archive entry to an absolute path inside `root`, or reject it.
 *
 * Zip entry names are attacker-controlled: `../` sequences, absolute paths and
 * Windows drive letters all have to be refused rather than normalized, because a
 * normalized-away traversal is still an entry that wanted to escape. The
 * containment check compares resolved paths so a `..` buried mid-path cannot
 * sneak through either.
 */
export function resolveArchiveEntryPath(root: string, entryName: string): string | null {
  if (!entryName || entryName.endsWith("/")) return null;
  if (entryName.includes("\0")) return null;
  if (path.isAbsolute(entryName)) return null;
  if (/^[A-Za-z]:/.test(entryName)) return null;
  if (entryName.split(/[\\/]/).some((segment) => segment === "..")) return null;

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, entryName);
  const rel = path.relative(resolvedRoot, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function fetchArchiveBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    // The URL carries a signature; report the status only, never the URL.
    throw new Error(`archive download failed with HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Make `localPath` a usable working tree from an uploaded source archive.
 *
 *  - absent            -> mkdir + download + unpack + git init
 *  - existing repo     -> leave it exactly as it is. Re-unpacking would overwrite
 *                         whatever the agent has already done here, and the archive
 *                         is a one-time seed, not a remote to sync against
 *  - existing non-repo -> fail loudly, same as the clone and empty paths
 */
export async function ensureManagedArchiveWorkspace(
  input: EnsureManagedArchiveWorkspaceInput,
): Promise<EnsureManagedCloneResult> {
  const runGit = input.runGit ?? runGitCommand;
  const fetchArchive = input.fetchArchive ?? fetchArchiveBytes;
  const log = (line: string) => input.onLog?.(line);

  const localPath = path.resolve(input.localPath);

  if (fs.existsSync(localPath)) {
    if (isGitRepo(localPath)) {
      log(`Reusing existing workspace at ${localPath} (archive already unpacked)`);
      const head = await runGit(localPath, ["rev-parse", "HEAD"], null);
      return { ok: true, created: false, headSha: head.code === 0 ? head.stdout.trim() : null };
    }
    if (!isEmptyDirectory(localPath)) {
      return {
        ok: false,
        reason: `managed workspace exists but is not a git repository: ${localPath}. Remove it or point the agent elsewhere.`,
      };
    }
    // Empty and not a repo — same as absent, fall through to unpack below.
  }

  log(`Unpacking uploaded sources into ${localPath}`);

  let entries: Record<string, Uint8Array>;
  try {
    const bytes = await fetchArchive(input.archiveUrl);
    const { unzipSync } = await import("fflate");
    entries = unzipSync(bytes);
  } catch (err) {
    return {
      ok: false,
      reason: `could not read source archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Everything is validated before a single byte is written, so a malicious entry
  // cannot leave a half-unpacked tree behind.
  const planned: Array<{ target: string; bytes: Uint8Array }> = [];
  let totalBytes = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const target = resolveArchiveEntryPath(localPath, name);
    if (!target) {
      return { ok: false, reason: `source archive contains an unsafe path: ${name}` };
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_UNPACKED_BYTES) {
      return { ok: false, reason: "source archive expands to more than the 2 GB unpack limit" };
    }
    planned.push({ target, bytes });
  }

  if (planned.length === 0) {
    return { ok: false, reason: "source archive contains no files" };
  }

  try {
    fs.mkdirSync(localPath, { recursive: true });
    for (const { target, bytes } of planned) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `cannot write unpacked sources to ${localPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  log(`Unpacked ${planned.length} files into ${localPath}`);

  const init = await runGit(localPath, ["init"], null);
  if (init.code !== 0) {
    return { ok: false, reason: `git init failed: ${init.stderr}` };
  }

  // Same as the empty path: an initialized repo has no commits yet.
  return { ok: true, created: true, headSha: null };
}

/**
 * Make `localPath` a usable checkout of `cloneUrl`.
 *
 *  - absent, or exists empty -> git clone (git clones into an empty directory
 *    exactly like a fresh one)
 *  - existing repo   -> fetch + reset --hard to the remote default branch
 *  - existing non-empty, non-repo -> fail loudly; never delete a directory we
 *    did not create
 */
/**
 * Bring a *user-configured* checkout up to date without discarding uncommitted work.
 *
 * This is the counterpart to ensureManagedClone for directories the agent does
 * not own. The tree is fetched, switched onto the default branch (auto-stashing
 * when a previous agent left a dirty feature branch), and updated with a strict
 * fast-forward. Uncommitted edits are never discarded — only stashed.
 *
 * Clean but diverged history (common after an agent committed on main and a
 * push was rejected) is auto-reconciled with `reset --hard origin/<branch>` so
 * the next job is not blocked. A dirty diverged tree still fails with a
 * message saying what to fix.
 *
 * Cloning into a missing/empty directory is still allowed: there is nothing to
 * lose, and naming a not-yet-existing folder is a supported way to configure one.
 */
export async function ensureUserWorkspace(
  input: EnsureManagedCloneInput,
): Promise<EnsureManagedCloneResult> {
  const runGit = input.runGit ?? runGitCommand;
  const secrets = input.credentials?.token ? [input.credentials.token] : [];
  const log = (line: string) => input.onLog?.(redactSecrets(line, secrets));

  const localPath = path.resolve(input.localPath);
  const branch = input.defaultBranch?.trim() || "main";

  const exists = fs.existsSync(localPath);
  const isRepo = exists && isGitRepo(localPath);

  // Nothing there yet (or an empty placeholder) — a clone loses nothing.
  if (!isRepo) {
    if (exists && !isEmptyDirectory(localPath)) {
      return {
        ok: false,
        reason: `workspace ${localPath} is not a git repository. Point the agent at a checkout, or empty the directory so it can be cloned.`,
      };
    }
    return ensureManagedClone({ ...input, localPath });
  }

  // A checkout with no `origin` is a legitimate local-only working copy — some
  // people point the agent at a directory that was never cloned from anywhere.
  // There is nothing to fetch, and inventing a remote would be wrong, so the
  // workspace is simply accepted as-is.
  const origin = await runGit(localPath, ["remote", "get-url", "origin"], input.credentials);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    log(`Workspace at ${localPath} has no "origin" remote — using it as-is`);
    const head = await runGit(localPath, ["rev-parse", "HEAD"], input.credentials);
    return { ok: true, created: false, headSha: head.code === 0 ? head.stdout.trim() : null };
  }

  log(`Updating workspace at ${localPath} (fast-forward only)`);

  const fetched = await runGit(localPath, ["fetch", "origin", "--prune"], input.credentials);
  if (fetched.code !== 0) {
    return { ok: false, reason: `git fetch failed: ${redactSecrets(fetched.stderr, secrets)}` };
  }

  // Resolve the target the same way the managed path does, so both kinds of
  // workspace agree on what "the required branch" means.
  let targetBranch = branch;
  const remoteRef = await runGit(
    localPath,
    ["rev-parse", "--verify", `origin/${branch}`],
    input.credentials,
  );
  if (remoteRef.code !== 0) {
    const symbolic = await runGit(
      localPath,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      input.credentials,
    );
    const detected = symbolic.stdout.trim().replace(/^origin\//, "");
    if (symbolic.code !== 0 || !detected) {
      return {
        ok: false,
        reason: `cannot resolve origin/${branch} or origin/HEAD in ${localPath}`,
      };
    }
    targetBranch = detected;
    log(`origin/${branch} not found; using origin/${targetBranch}`);
  }

  const current = await runGit(localPath, ["rev-parse", "--abbrev-ref", "HEAD"], input.credentials);
  const currentBranch = current.stdout.trim();

  // Agents often leave allowlisted checkouts on a feature branch with leftover
  // edits. Stash (never discard) so prepare can switch to the default branch;
  // the user can recover via `git stash list`.
  if (currentBranch !== targetBranch) {
    const status = await runGit(localPath, ["status", "--porcelain"], input.credentials);
    if (status.stdout.trim()) {
      const stashMsg = `projectmind-agent: auto-stash before checkout ${targetBranch} (was ${currentBranch})`;
      log(
        `Stashing uncommitted changes on "${currentBranch}" before switching to "${targetBranch}"`,
      );
      const stashed = await runGit(
        localPath,
        ["stash", "push", "--include-untracked", "-m", stashMsg],
        input.credentials,
      );
      if (stashed.code !== 0) {
        return {
          ok: false,
          reason: `workspace ${localPath} is on "${currentBranch}" with uncommitted changes and needs to be on "${targetBranch}", but auto-stash failed: ${redactSecrets(stashed.stderr, secrets)}. Commit, stash, or discard them and retry.`,
        };
      }
      log(`Stashed as "${stashMsg}" — recover with git stash list / git stash pop`);
    }
    const checkout = await runGit(localPath, ["checkout", targetBranch], input.credentials);
    if (checkout.code !== 0) {
      return {
        ok: false,
        reason: `git checkout ${targetBranch} failed: ${redactSecrets(checkout.stderr, secrets)}`,
      };
    }
  }

  // Prefer fast-forward so we never rewrite local commits when avoidable.
  const merged = await runGit(
    localPath,
    ["merge", "--ff-only", `origin/${targetBranch}`],
    input.credentials,
  );
  if (merged.code !== 0) {
    const statusAfter = await runGit(localPath, ["status", "--porcelain"], input.credentials);
    if (statusAfter.stdout.trim()) {
      return {
        ok: false,
        reason: `workspace ${localPath} has diverged from origin/${targetBranch} and cannot be fast-forwarded. Reconcile it (rebase, merge, or push) and retry.`,
      };
    }
    // Clean tree + diverged history: discard local-only commits and match origin.
    // Typical cause: prior agent committed on the default branch then push failed.
    log(
      `Clean workspace diverged from origin/${targetBranch}; hard-resetting to discard local-only commits`,
    );
    const reset = await runGit(
      localPath,
      ["reset", "--hard", `origin/${targetBranch}`],
      input.credentials,
    );
    if (reset.code !== 0) {
      return {
        ok: false,
        reason: `workspace ${localPath} has diverged from origin/${targetBranch} and reset failed: ${redactSecrets(reset.stderr, secrets)}. Reconcile it (rebase, merge, or push) and retry.`,
      };
    }
  }

  const head = await runGit(localPath, ["rev-parse", "HEAD"], input.credentials);
  return { ok: true, created: false, headSha: head.code === 0 ? head.stdout.trim() : null };
}

export async function ensureManagedClone(
  input: EnsureManagedCloneInput,
): Promise<EnsureManagedCloneResult> {
  const runGit = input.runGit ?? runGitCommand;
  const secrets = input.credentials?.token ? [input.credentials.token] : [];
  const log = (line: string) => input.onLog?.(redactSecrets(line, secrets));

  const localPath = path.resolve(input.localPath);
  const branch = input.defaultBranch?.trim() || "main";

  const exists = fs.existsSync(localPath);
  const isRepo = exists && isGitRepo(localPath);

  if (exists && !isRepo && !isEmptyDirectory(localPath)) {
    // Deliberately not delete-and-reclone: this directory may hold something
    // the user cares about, and we did not create it.
    return {
      ok: false,
      reason: `managed workspace exists but is not a git repository: ${localPath}. Remove it or point the agent elsewhere.`,
    };
  }

  if (!isRepo) {
    log(`Cloning ${input.cloneUrl} into ${localPath}`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    // Clone with a tokenless URL — the credential arrives via the environment,
    // so nothing secret is persisted into .git/config.
    const cloned = await runGit(
      path.dirname(localPath),
      ["clone", "--origin", "origin", input.cloneUrl, localPath],
      input.credentials,
    );
    if (cloned.code !== 0) {
      return { ok: false, reason: `git clone failed: ${redactSecrets(cloned.stderr, secrets)}` };
    }

    const head = await runGit(localPath, ["rev-parse", "HEAD"], input.credentials);
    return { ok: true, created: true, headSha: head.code === 0 ? head.stdout.trim() : null };
  }

  log(`Refreshing existing managed workspace at ${localPath}`);

  const fetched = await runGit(localPath, ["fetch", "origin", "--prune"], input.credentials);
  if (fetched.code !== 0) {
    return { ok: false, reason: `git fetch failed: ${redactSecrets(fetched.stderr, secrets)}` };
  }

  // Prefer the branch we were told about; fall back to the remote's own HEAD.
  let targetBranch = branch;
  const remoteRef = await runGit(
    localPath,
    ["rev-parse", "--verify", `origin/${branch}`],
    input.credentials,
  );
  let targetSha: string | null = remoteRef.code === 0 ? remoteRef.stdout.trim() : null;
  if (remoteRef.code !== 0) {
    const symbolic = await runGit(
      localPath,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      input.credentials,
    );
    const detected = symbolic.stdout.trim().replace(/^origin\//, "");
    if (symbolic.code !== 0 || !detected) {
      return {
        ok: false,
        reason: `cannot resolve origin/${branch} or origin/HEAD in ${localPath}`,
      };
    }
    targetBranch = detected;
    log(`origin/${branch} not found; using origin/${targetBranch}`);

    const targetRef = await runGit(
      localPath,
      ["rev-parse", "--verify", `origin/${targetBranch}`],
      input.credentials,
    );
    targetSha = targetRef.code === 0 ? targetRef.stdout.trim() : null;
  }

  // Idempotent no-op only when the tree is also clean. A dirty working tree on
  // the right SHA still needs reset — otherwise leftover agent edits survive
  // into the next job (docs promise a hard-reset before every job).
  if (targetSha) {
    const currentBranch = await runGit(
      localPath,
      ["symbolic-ref", "--short", "-q", "HEAD"],
      input.credentials,
    );
    const currentSha = await runGit(localPath, ["rev-parse", "HEAD"], input.credentials);
    const status = await runGit(localPath, ["status", "--porcelain"], input.credentials);
    if (
      currentBranch.code === 0 &&
      currentBranch.stdout.trim() === targetBranch &&
      currentSha.code === 0 &&
      currentSha.stdout.trim() === targetSha &&
      !status.stdout.trim()
    ) {
      log(`Already up to date at ${targetSha} (${targetBranch})`);
      return { ok: true, created: false, headSha: targetSha };
    }
  }

  // Force checkout: managed trees may be dirty from a prior job that skipped
  // cleanup. `-f` discards conflicting worktree changes (safe: agent-owned).
  let checkout = await runGit(localPath, ["checkout", "-f", targetBranch], input.credentials);
  if (checkout.code !== 0) {
    checkout = await runGit(
      localPath,
      ["checkout", "-f", "-B", targetBranch, `origin/${targetBranch}`],
      input.credentials,
    );
  }
  if (checkout.code !== 0) {
    return { ok: false, reason: `git checkout failed: ${redactSecrets(checkout.stderr, secrets)}` };
  }

  // Safe only because this directory is agent-owned: it discards local edits.
  // Never reachable for a user-configured (managed=false) workspace.
  const reset = await runGit(
    localPath,
    ["reset", "--hard", `origin/${targetBranch}`],
    input.credentials,
  );
  if (reset.code !== 0) {
    return { ok: false, reason: `git reset failed: ${redactSecrets(reset.stderr, secrets)}` };
  }

  // Note: no `git clean -fdx`. It would delete node_modules and every build
  // cache, turning each job into a cold install for no correctness benefit.

  const head = await runGit(localPath, ["rev-parse", "HEAD"], input.credentials);
  return { ok: true, created: false, headSha: head.code === 0 ? head.stdout.trim() : null };
}

export type WorkspaceContainmentKind = "managed" | "allowlisted";

export type RestoreWorkspaceDefaultBranchInput = {
  localPath: string;
  defaultBranch?: string | null;
  containment: WorkspaceContainmentKind;
  credentials?: GitCredentials | null;
  onLog?: (line: string) => void;
  runGit?: RunGit;
};

export type RestoreWorkspaceDefaultBranchResult =
  | { ok: true; restored: boolean; branch: string; detail: string }
  | { ok: false; reason: string };

/**
 * Post-job hygiene: leave the base checkout on the remote default branch so the
 * next prepare is not blocked by a leftover feature branch or diverged main.
 *
 * - managed: force-match origin/<default> (same contract as prepare), including
 *   when already on the default branch but HEAD ≠ origin
 * - allowlisted: stash if dirty then checkout; if already on default and clean
 *   but diverged from origin, hard-reset (same clean-diverge policy as prepare)
 *
 * Best-effort: callers should log failures and not fail the job over this.
 */
export async function restoreWorkspaceDefaultBranch(
  input: RestoreWorkspaceDefaultBranchInput,
): Promise<RestoreWorkspaceDefaultBranchResult> {
  const runGit = input.runGit ?? runGitCommand;
  const secrets = input.credentials?.token ? [input.credentials.token] : [];
  const log = (line: string) => input.onLog?.(redactSecrets(line, secrets));

  const localPath = path.resolve(input.localPath);
  if (!isGitRepo(localPath)) {
    return { ok: true, restored: false, branch: "", detail: "not a git repository — skipped" };
  }

  const branch = input.defaultBranch?.trim() || "main";
  const origin = await runGit(localPath, ["remote", "get-url", "origin"], input.credentials);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    return {
      ok: true,
      restored: false,
      branch: "",
      detail: "no origin remote — left checkout as-is",
    };
  }

  let targetBranch = branch;
  let targetSha: string | null = null;
  const remoteRef = await runGit(
    localPath,
    ["rev-parse", "--verify", `origin/${branch}`],
    input.credentials,
  );
  if (remoteRef.code === 0) {
    targetSha = remoteRef.stdout.trim() || null;
  } else {
    const symbolic = await runGit(
      localPath,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      input.credentials,
    );
    const detected = symbolic.stdout.trim().replace(/^origin\//, "");
    if (symbolic.code !== 0 || !detected) {
      return {
        ok: false,
        reason: `cannot resolve origin/${branch} or origin/HEAD in ${localPath}`,
      };
    }
    targetBranch = detected;
    const targetRef = await runGit(
      localPath,
      ["rev-parse", "--verify", `origin/${targetBranch}`],
      input.credentials,
    );
    targetSha = targetRef.code === 0 ? targetRef.stdout.trim() || null : null;
  }

  const current = await runGit(localPath, ["rev-parse", "--abbrev-ref", "HEAD"], input.credentials);
  const currentBranch = current.code === 0 ? current.stdout.trim() : "";
  const status = await runGit(localPath, ["status", "--porcelain"], input.credentials);
  const dirty = Boolean(status.stdout.trim());
  const head = await runGit(localPath, ["rev-parse", "HEAD"], input.credentials);
  const headSha = head.code === 0 ? head.stdout.trim() : "";
  const matchesRemote = Boolean(targetSha && headSha && headSha === targetSha);

  if (input.containment === "managed") {
    if (currentBranch === targetBranch && !dirty && matchesRemote) {
      return {
        ok: true,
        restored: false,
        branch: targetBranch,
        detail: `already on ${targetBranch} (clean)`,
      };
    }
    log(`Cleanup: restoring managed workspace to origin/${targetBranch}`);
    let checkout = await runGit(localPath, ["checkout", "-f", targetBranch], input.credentials);
    if (checkout.code !== 0) {
      checkout = await runGit(
        localPath,
        ["checkout", "-f", "-B", targetBranch, `origin/${targetBranch}`],
        input.credentials,
      );
    }
    if (checkout.code !== 0) {
      return {
        ok: false,
        reason: `git checkout failed: ${redactSecrets(checkout.stderr, secrets)}`,
      };
    }
    const reset = await runGit(
      localPath,
      ["reset", "--hard", `origin/${targetBranch}`],
      input.credentials,
    );
    if (reset.code !== 0) {
      return { ok: false, reason: `git reset failed: ${redactSecrets(reset.stderr, secrets)}` };
    }
    return {
      ok: true,
      restored: true,
      branch: targetBranch,
      detail: `hard-reset to origin/${targetBranch}`,
    };
  }

  // allowlisted
  if (currentBranch === targetBranch) {
    if (!dirty && !matchesRemote && targetSha) {
      log(
        `Cleanup: clean allowlisted workspace diverged from origin/${targetBranch}; hard-resetting`,
      );
      const reset = await runGit(
        localPath,
        ["reset", "--hard", `origin/${targetBranch}`],
        input.credentials,
      );
      if (reset.code !== 0) {
        return { ok: false, reason: `git reset failed: ${redactSecrets(reset.stderr, secrets)}` };
      }
      return {
        ok: true,
        restored: true,
        branch: targetBranch,
        detail: `hard-reset clean diverged ${targetBranch} to origin/${targetBranch}`,
      };
    }
    return {
      ok: true,
      restored: false,
      branch: targetBranch,
      detail: `already on ${targetBranch}`,
    };
  }

  if (dirty) {
    const stashMsg = `projectmind-agent: auto-stash after job before checkout ${targetBranch} (was ${currentBranch})`;
    log(`Cleanup: stashing leftover changes on "${currentBranch}" before returning to "${targetBranch}"`);
    const stashed = await runGit(
      localPath,
      ["stash", "push", "--include-untracked", "-m", stashMsg],
      input.credentials,
    );
    if (stashed.code !== 0) {
      return {
        ok: false,
        reason: `auto-stash before cleanup checkout failed: ${redactSecrets(stashed.stderr, secrets)}`,
      };
    }
    log(`Stashed as "${stashMsg}" — recover with git stash list / git stash pop`);
  }

  log(`Cleanup: checking out ${targetBranch}`);
  const checkout = await runGit(localPath, ["checkout", targetBranch], input.credentials);
  if (checkout.code !== 0) {
    return {
      ok: false,
      reason: `git checkout ${targetBranch} failed: ${redactSecrets(checkout.stderr, secrets)}`,
    };
  }

  // After switching back, clean up diverged default-branch history the same way prepare does.
  const statusOnDefault = await runGit(localPath, ["status", "--porcelain"], input.credentials);
  if (!statusOnDefault.stdout.trim() && targetSha) {
    const headOnDefault = await runGit(localPath, ["rev-parse", "HEAD"], input.credentials);
    const shaOnDefault = headOnDefault.code === 0 ? headOnDefault.stdout.trim() : "";
    if (shaOnDefault && shaOnDefault !== targetSha) {
      log(
        `Cleanup: clean allowlisted ${targetBranch} diverged from origin; hard-resetting after checkout`,
      );
      const reset = await runGit(
        localPath,
        ["reset", "--hard", `origin/${targetBranch}`],
        input.credentials,
      );
      if (reset.code !== 0) {
        return { ok: false, reason: `git reset failed: ${redactSecrets(reset.stderr, secrets)}` };
      }
      return {
        ok: true,
        restored: true,
        branch: targetBranch,
        detail: `checked out and hard-reset ${targetBranch} to origin/${targetBranch}`,
      };
    }
  }

  return {
    ok: true,
    restored: true,
    branch: targetBranch,
    detail: `checked out ${targetBranch}`,
  };
}
