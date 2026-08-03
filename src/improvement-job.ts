/**
 * Parse ProjectMind improvement-loop job contracts and post callbacks.
 */
import {
  assertChangeAllowed,
  extractMacAgentJobContractFromPrompt,
  parseMacAgentJobContract,
  loadImemoryProjectManifest,
  type MacAgentCallbackBody,
  type MacAgentJobContractV1,
} from "./improvement-contracts/index.js";

export {
  extractMacAgentJobContractFromPrompt,
  parseMacAgentJobContract,
  type MacAgentJobContractV1,
};

export function loadManifestForContract(contract: MacAgentJobContractV1) {
  try {
    return loadImemoryProjectManifest(contract.localDirectory);
  } catch {
    return null;
  }
}

export function enforceContractSafety(
  contract: MacAgentJobContractV1,
  changedFiles: string[],
): { ok: true } | { ok: false; reason: string } {
  if (contract.mergePullRequest !== false) {
    return { ok: false, reason: "mergePullRequest must be false" };
  }
  if (contract.deployProduction !== false) {
    return { ok: false, reason: "deployProduction must be false" };
  }
  if (contract.allowDatabaseMigrations !== false) {
    return { ok: false, reason: "allowDatabaseMigrations must be false" };
  }
  if (contract.branchName === "main" || contract.branchName === "master") {
    return { ok: false, reason: "Must not push to main/master" };
  }
  if (contract.branchName === contract.baseBranch) {
    return { ok: false, reason: "Work branch must differ from base branch" };
  }

  const manifest = loadManifestForContract(contract);
  const protectedPaths = contract.protectedPaths.length
    ? contract.protectedPaths
    : (manifest?.protectedPaths ?? []);
  const maxChangedFiles = contract.maxChangedFiles ?? manifest?.agent.maxChangedFiles ?? 12;
  const check = assertChangeAllowed(changedFiles, {
    protectedPaths,
    agent: {
      instructionsFile: manifest?.agent.instructionsFile ?? "AGENTS.md",
      maxChangedFiles,
      maxDiffLines: contract.maxDiffLines ?? manifest?.agent.maxDiffLines ?? 800,
      allowDependencyChanges: manifest?.agent.allowDependencyChanges ?? false,
      allowDatabaseMigrations: false,
      allowProductionDeployment: false,
    },
  });
  if (!check.ok) {
    return { ok: false, reason: `${check.reason}: ${check.files.join(", ")}` };
  }
  return { ok: true };
}

export async function postImprovementCallback(
  contract: MacAgentJobContractV1,
  body: Omit<MacAgentCallbackBody, "runId"> & { runId?: string },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const url = `${contract.callback.baseUrl.replace(/\/$/, "")}/api/improvement-loop/callback`;
  const payload: MacAgentCallbackBody = {
    ...body,
    runId: body.runId ?? contract.executionRunId,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${contract.callback.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}
