import fs from "node:fs";
import path from "node:path";
import { expandTilde } from "./managed-workspace.js";

export type SafetyResult = { ok: true; cwd: string } | { ok: false; reason: string };

/**
 * Result of resolving a path that may not exist yet. Distinct from SafetyResult
 * because it reports the *resolved* path (the caller needs it — the realpathed
 * leaf can differ from what was requested), not a validated cwd.
 */
export type AllowlistedPathResult = { ok: true; path: string } | { ok: false; reason: string };

/** Parse comma-separated allowlist roots from env. */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => path.resolve(part));
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Allowlist roots this agent will run jobs under.
 *
 * The managed root is included implicitly: the agent creates and owns those
 * checkouts, so requiring the operator to also list it in
 * IMEMORY_WORKSPACE_ALLOWLIST would be pure friction. It is read from this
 * agent's own environment — never from a job payload.
 */
export function effectiveAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = parseAllowlist(env.IMEMORY_WORKSPACE_ALLOWLIST);
  const managedRoot = managedRootFromEnv(env);
  if (!managedRoot) return configured;
  if (configured.some((root) => isPathInside(root, managedRoot))) return configured;
  return [...configured, managedRoot];
}

/**
 * The managed root, if this agent has one: either explicitly configured, or the
 * default location once it exists on disk (i.e. after a first managed clone).
 */
function managedRootFromEnv(env: NodeJS.ProcessEnv): string | null {
  const configured = env.IMEMORY_MANAGED_WORKSPACE_ROOT?.trim();
  if (configured) return path.resolve(configured);

  const home = env.HOME?.trim();
  if (!home) return null;
  const fallback = path.join(home, ".imemory", "workspaces");
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Prepare a workspace directory the *user* named in the setup wizard, creating
 * it if it does not exist yet.
 *
 * This is deliberately separate from `assertSafeWorkspace`, which guards job
 * execution and rightly insists the directory already exists. Here the whole
 * point is that it may not: someone typed a path for a project that has never
 * been checked out.
 *
 * The boundary is the agent's own allowlist, read from this agent's environment
 * — never from the job payload. A path the control plane sends is a request, and
 * the allowlist is the operator's standing statement of where this agent may
 * work; creating a directory inside it is within that grant, and anything
 * outside is refused. Symlink escapes are blocked by resolving the deepest
 * existing ancestor before comparing, since the leaf itself may not exist yet.
 */
export function ensureAllowlistedWorkspace(
  localDirectory: string,
  allowlist: string[],
): AllowlistedPathResult {
  if (!localDirectory?.trim()) {
    return { ok: false, reason: "local_directory is empty" };
  }
  if (allowlist.length === 0) {
    return {
      ok: false,
      reason:
        "No workspace roots configured: set IMEMORY_WORKSPACE_ALLOWLIST (comma-separated absolute roots) " +
        "to let this agent use a directory chosen for a project",
    };
  }

  const requested = path.resolve(expandTilde(localDirectory.trim()));
  if (!path.isAbsolute(requested)) {
    return { ok: false, reason: "local_directory must be an absolute path" };
  }

  // Resolve the deepest ancestor that exists, so a symlinked parent cannot
  // smuggle the target outside the allowlist.
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync(ancestor);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to resolve local_directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const suffix = path.relative(ancestor, requested);
  const resolved = suffix ? path.join(realAncestor, suffix) : realAncestor;

  const allowed = allowlist.some((root) => {
    let realRoot: string;
    try {
      realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    } catch {
      realRoot = path.resolve(root);
    }
    return isPathInside(realRoot, resolved);
  });

  if (!allowed) {
    return {
      ok: false,
      reason:
        `local_directory is outside this agent's allowlist: ${requested}. ` +
        `Allowed roots: ${allowlist.join(", ")}`,
    };
  }

  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, reason: `local_directory is not a directory: ${requested}` };
    }
    return { ok: true, path: fs.realpathSync(resolved) };
  }

  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to create local_directory ${requested}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return { ok: true, path: fs.realpathSync(resolved) };
}

/**
 * Ensure cwd is absolute, exists, is a directory, and sits under an allowlist root
 * after realpath resolution (blocks symlink escapes).
 */
export function assertSafeWorkspace(localDirectory: string, allowlist: string[]): SafetyResult {
  if (!localDirectory?.trim()) {
    return { ok: false, reason: "local_directory is empty" };
  }
  if (allowlist.length === 0) {
    return {
      ok: false,
      reason:
        "No workspace roots configured: set IMEMORY_WORKSPACE_ALLOWLIST (comma-separated absolute roots), " +
        "or IMEMORY_MANAGED_WORKSPACE_ROOT to let the agent clone projects itself",
    };
  }

  const requested = path.resolve(expandTilde(localDirectory.trim()));
  if (!path.isAbsolute(requested)) {
    return { ok: false, reason: "local_directory must be an absolute path" };
  }

  let real: string;
  try {
    if (!fs.existsSync(requested)) {
      return { ok: false, reason: `local_directory does not exist: ${requested}` };
    }
    const stat = fs.statSync(requested);
    if (!stat.isDirectory()) {
      return { ok: false, reason: `local_directory is not a directory: ${requested}` };
    }
    real = fs.realpathSync(requested);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to resolve local_directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const allowed = allowlist.some((root) => {
    let realRoot: string;
    try {
      realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    } catch {
      realRoot = path.resolve(root);
    }
    return isPathInside(realRoot, real);
  });

  if (!allowed) {
    return {
      ok: false,
      reason: `local_directory is outside IMEMORY_WORKSPACE_ALLOWLIST: ${real}`,
    };
  }

  return { ok: true, cwd: real };
}

/** Resolve a relative path under cwd; reject escapes and symlink escapes. */
export function resolveUnderCwd(cwd: string, relativePath: string): string | null {
  let realCwd: string;
  try {
    realCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
  } catch {
    realCwd = path.resolve(cwd);
  }

  const target = path.resolve(realCwd, relativePath);
  if (!isPathInside(realCwd, target)) return null;

  try {
    if (fs.existsSync(target)) {
      const realTarget = fs.realpathSync(target);
      if (!isPathInside(realCwd, realTarget) && realTarget !== realCwd) return null;
      return realTarget;
    }

    // Nonexistent path: realpath the deepest existing ancestor (blocks symlink dirs).
    let ancestor = path.dirname(target);
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      if (!isPathInside(realCwd, parent) && parent !== realCwd) return null;
      ancestor = parent;
    }
    if (fs.existsSync(ancestor)) {
      const realAncestor = fs.realpathSync(ancestor);
      if (!isPathInside(realCwd, realAncestor) && realAncestor !== realCwd) return null;
      const remainder = path.relative(ancestor, target);
      const reconstructed = path.resolve(realAncestor, remainder);
      if (!isPathInside(realCwd, reconstructed) && reconstructed !== realCwd) return null;
      return reconstructed;
    }
  } catch {
    return null;
  }

  return target;
}
