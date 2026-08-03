/**
 * WorkspaceManager — the one place an agent guarantees it has a usable checkout.
 *
 * Getting source code onto disk is not a step in anyone's workflow. It is a
 * precondition each agent satisfies for itself, immediately before it runs a job
 * that needs source. That has three consequences worth stating, because the
 * previous design (a user-visible "pull from GitHub" task) violated all three:
 *
 *  - The workspace is *local to this agent*. Two agents on two machines have two
 *    unrelated copies, and neither waits on the other. Nothing is synchronized.
 *  - Task dependencies describe logical workflow only. No task is ever blocked on
 *    "has some agent cloned this yet?", because that question is not global.
 *  - Preparation is idempotent and cheap on the common path: an up-to-date
 *    checkout costs a fetch and a no-op merge, not a re-clone.
 *
 * Failure is scoped to the job that triggered it: prepareWorkspace() returns a
 * reason instead of throwing, the caller fails that one job with it, and the next
 * job retries from scratch once the user has fixed the cause.
 */

import fs from "node:fs";
import path from "node:path";
import {
  assertPathInsideManagedRoot,
  ensureManagedArchiveWorkspace,
  ensureManagedClone,
  ensureManagedEmptyWorkspace,
  ensureUserWorkspace,
  resolveManagedRoot,
  type GitCredentials,
  type RunGit,
} from "./managed-workspace.js";
import { effectiveAllowlist, ensureAllowlistedWorkspace } from "./safety.js";

/**
 * How the directory came to be, which decides both the boundary it is checked
 * against and how forcefully it may be updated.
 *
 * `managed`     — the agent picked it under the root it advertises. Agent-owned
 *                 and disposable, so it is reset to match the remote exactly.
 * `allowlisted` — a person named it in the setup wizard. It may contain their
 *                 uncommitted work, so it is only ever fast-forwarded.
 */
export type WorkspaceContainment = "managed" | "allowlisted";

/**
 * What has to happen for the directory to become usable.
 *
 * `clone` is the normal case. `empty` covers a project with no repository at all
 * (a bare `git init`, nothing is ever pushed). `archive` unpacks the zip a
 * project was seeded from.
 */
export type WorkspaceMode = "clone" | "empty" | "archive";

export type PrepareWorkspaceInput = {
  localPath: string;
  containment: WorkspaceContainment;
  mode: WorkspaceMode;
  repository: { cloneUrl: string | null; defaultBranch: string | null } | null;
  credentials: GitCredentials | null;
  /** Short-lived signed URL, `archive` mode only. Never persisted, never logged. */
  archiveDownloadUrl?: string | null;
  onLog?: (line: string) => void;
  runGit?: RunGit;
};

export type PrepareWorkspaceResult =
  | {
      ok: true;
      /** The verified absolute path. Use this, not the requested one. */
      path: string;
      created: boolean;
      headSha: string | null;
      action: "cloned" | "refreshed" | "initialized" | "unpacked";
    }
  | { ok: false; reason: string };

/**
 * Codes exist so the caller can report a machine-readable cause alongside the
 * human sentence; the sentences themselves are written to be shown verbatim.
 */
function fail(reason: string): PrepareWorkspaceResult {
  return { ok: false, reason };
}

/**
 * Ensure this agent's local workspace for a project is present and current.
 *
 * Safe to call repeatedly — that is the intended usage. The expensive branch
 * (clone / unpack) runs only when the directory is missing or empty; otherwise
 * this is a fetch plus a fast-forward, and on an already-current checkout it does
 * no writes at all.
 */
export async function prepareWorkspace(
  input: PrepareWorkspaceInput,
): Promise<PrepareWorkspaceResult> {
  const requested = input.localPath?.trim();
  if (!requested) return fail("No workspace path was resolved for this job.");

  // Re-derive the boundary from THIS agent's own environment. A path handed over
  // by the control plane is a request, never an authorization — which is why the
  // check happens here and not on the server.
  const inside =
    input.containment === "allowlisted"
      ? ensureAllowlistedWorkspace(requested, effectiveAllowlist())
      : assertPathInsideManagedRoot(requested, resolveManagedRoot());
  if (!inside.ok) return fail(inside.reason);

  const localPath = inside.path;
  const onLog = input.onLog;

  // An archive job with no signed URL means the link could not be minted.
  // Falling through to an empty checkout would silently discard the sources the
  // user uploaded, so stop instead.
  const archiveUrl = input.archiveDownloadUrl?.trim() || null;
  if (input.mode === "archive" && !archiveUrl) {
    return fail(
      "This workspace expects uploaded sources, but no download link was issued. Retry the job, or re-upload the project archive.",
    );
  }

  // No repository is a legitimate state, not an error: the work simply stays
  // local. Treat it as `empty` even if the server still said `clone`.
  const cloneUrl = input.repository?.cloneUrl?.trim() || null;
  const wantsEmpty = input.mode === "empty" || (input.mode === "clone" && !cloneUrl);

  if (input.mode === "clone" && !cloneUrl && !wantsEmpty) {
    return fail("This project's repository has no usable clone URL — reconnect it through GitHub.");
  }

  const defaultBranch = input.repository?.defaultBranch?.trim() || "main";

  const result = archiveUrl
    ? await ensureManagedArchiveWorkspace({
        localPath,
        archiveUrl,
        onLog,
        runGit: input.runGit,
      })
    : wantsEmpty
      ? await ensureManagedEmptyWorkspace({ localPath, onLog, runGit: input.runGit })
      : // The containment split is the safety-critical line: only a directory the
        // agent owns may be force-matched to the remote.
        await (input.containment === "managed" ? ensureManagedClone : ensureUserWorkspace)({
          localPath,
          cloneUrl: cloneUrl!,
          defaultBranch,
          credentials: input.credentials,
          onLog,
          runGit: input.runGit,
        });

  if (!result.ok) return fail(result.reason);

  const verified = verifyWorkspaceUsable(localPath);
  if (!verified.ok) return fail(verified.reason);

  return {
    ok: true,
    path: localPath,
    created: result.created,
    headSha: result.headSha,
    action: archiveUrl
      ? "unpacked"
      : wantsEmpty
        ? result.created
          ? "initialized"
          : "refreshed"
        : result.created
          ? "cloned"
          : "refreshed",
  };
}

/**
 * Last gate before work starts: the directory exists and is a git repository.
 *
 * Everything downstream (the worktree step, the runner, git-publish) assumes both,
 * and a clear failure here is far easier to act on than the tool-specific error
 * each of them would otherwise produce.
 */
export function verifyWorkspaceUsable(
  localPath: string,
): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(localPath)) {
    return { ok: false, reason: `workspace ${localPath} does not exist after preparation.` };
  }
  if (!fs.existsSync(path.join(localPath, ".git"))) {
    return {
      ok: false,
      reason: `workspace ${localPath} is not a git repository after preparation.`,
    };
  }
  return { ok: true };
}
