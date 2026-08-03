import { describe, expect, it } from "vitest";
import {
  extractMacAgentJobContractFromPrompt,
  parseMacAgentJobContract,
} from "./improvement-contracts/index.js";
import { enforceContractSafety } from "./improvement-job.js";

describe("improvement job contract (mac-agent)", () => {
  const base = {
    schemaVersion: "1.0" as const,
    jobId: "run-1",
    executionRunId: "run-1",
    projectId: "proj",
    projectSlug: "tripbooster",
    planId: "plan-1",
    propositionId: "prop-1",
    localDirectory: "/tmp/trip-vault-does-not-need-to-exist-for-parse",
    branchName: "improve/tripbooster/abc-health",
    baseBranch: "main",
    createPullRequest: true,
    mergePullRequest: false as const,
    deployProduction: false as const,
    prompt: "fix health",
    acceptanceCriteria: ["tests pass"],
    protectedPaths: ["supabase/migrations/**", ".env*"],
    maxChangedFiles: 12,
    allowDatabaseMigrations: false as const,
    requiredCommands: [{ name: "test", command: "npm test" }],
    callback: {
      baseUrl: "https://imemory.example.com",
      token: "tok_" + "x".repeat(24),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    timeoutMs: 3_600_000,
  };

  it("parses a valid ProjectMind execution job", () => {
    const contract = parseMacAgentJobContract(base);
    expect(contract.schemaVersion).toBe("1.0");
    expect(contract.mergePullRequest).toBe(false);
    expect(contract.deployProduction).toBe(false);
  });

  it("extracts contract from prompt fence", () => {
    const prompt = ["# plan", "```json", JSON.stringify(base), "```"].join("\n");
    const extracted = extractMacAgentJobContractFromPrompt(prompt);
    expect(extracted?.executionRunId).toBe("run-1");
  });

  it("rejects protected path and migration changes", () => {
    const contract = parseMacAgentJobContract(base);
    const blocked = enforceContractSafety(contract, ["supabase/migrations/20260101_foo.sql"]);
    expect(blocked.ok).toBe(false);

    const ok = enforceContractSafety(contract, ["src/lib/imemory/health.ts"]);
    expect(ok.ok).toBe(true);
  });

  it("rejects push to main", () => {
    const contract = parseMacAgentJobContract({
      ...base,
      branchName: "main",
    });
    expect(enforceContractSafety(contract, []).ok).toBe(false);
  });
});
