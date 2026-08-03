/**
 * Self-contained ProjectMind improvement contracts module.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const macAgentCallbackSchema = z.object({
  runId: z.string(),
  status: z.enum(["completed", "failed"]),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  error: z.string().optional(),
});

export type MacAgentCallbackBody = z.infer<typeof macAgentCallbackSchema>;

export const macAgentJobContractSchema = z.object({
  schemaVersion: z.literal("1.0"),
  jobId: z.string(),
  executionRunId: z.string(),
  projectId: z.string(),
  projectSlug: z.string(),
  planId: z.string(),
  propositionId: z.string(),
  localDirectory: z.string(),
  branchName: z.string(),
  baseBranch: z.string(),
  createPullRequest: z.boolean(),
  mergePullRequest: z.literal(false),
  deployProduction: z.literal(false),
  prompt: z.string(),
  acceptanceCriteria: z.array(z.string()),
  protectedPaths: z.array(z.string()).default([]),
  maxChangedFiles: z.number().optional(),
  maxDiffLines: z.number().optional(),
  allowDatabaseMigrations: z.literal(false),
  requiredCommands: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
      }),
    )
    .default([]),
  callback: z.object({
    baseUrl: z.string(),
    token: z.string(),
    expiresAt: z.string(),
  }),
  timeoutMs: z.number().default(3600000),
});

export type MacAgentJobContractV1 = z.infer<typeof macAgentJobContractSchema>;

export function parseMacAgentJobContract(data: unknown): MacAgentJobContractV1 {
  return macAgentJobContractSchema.parse(data);
}

export function extractMacAgentJobContractFromPrompt(prompt: string): MacAgentJobContractV1 | null {
  const jsonMatch = prompt.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) return null;
  try {
    const raw = JSON.parse(jsonMatch[1]);
    return parseMacAgentJobContract(raw);
  } catch {
    return null;
  }
}

function matchPathPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path.startsWith(prefix);
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  return path === pattern;
}

export function assertChangeAllowed(
  changedFiles: string[],
  options: {
    protectedPaths?: string[];
    agent?: {
      instructionsFile?: string;
      maxChangedFiles?: number;
      maxDiffLines?: number;
      allowDependencyChanges?: boolean;
      allowDatabaseMigrations?: boolean;
      allowProductionDeployment?: boolean;
    };
  },
): { ok: true } | { ok: false; reason: string; files: string[] } {
  const protectedPaths = options.protectedPaths ?? [];
  const maxChangedFiles = options.agent?.maxChangedFiles ?? 12;

  if (changedFiles.length > maxChangedFiles) {
    return {
      ok: false,
      reason: `Too many changed files (${changedFiles.length} > ${maxChangedFiles})`,
      files: changedFiles,
    };
  }

  const blocked: string[] = [];
  for (const file of changedFiles) {
    for (const pattern of protectedPaths) {
      if (matchPathPattern(file, pattern)) {
        blocked.push(file);
        break;
      }
    }
  }

  if (blocked.length > 0) {
    return {
      ok: false,
      reason: "Blocked changes to protected path",
      files: blocked,
    };
  }

  return { ok: true };
}

export function loadImemoryProjectManifest(directory: string): {
  protectedPaths?: string[];
  agent: {
    instructionsFile: string;
    maxChangedFiles: number;
    maxDiffLines: number;
    allowDependencyChanges: boolean;
  };
} | null {
  const manifestPath = join(directory, ".imemory", "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const content = JSON.parse(readFileSync(manifestPath, "utf8"));
    return content;
  } catch {
    return null;
  }
}
