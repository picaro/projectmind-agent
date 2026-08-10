import { tmpdir } from "node:os";
import { createRunnerByName, resolveAutoRunnerChain } from "./runners/resolve.js";
import { authModeForRunner, type AuthMode } from "./provider-pacing.js";
import type { Runner, RunnerName } from "./runners/types.js";

/** Prompt sent to each runner; deliberately trivial so a fast, cheap reply proves the model responds. */
export const HEALTH_CHECK_PROMPT =
  "This is an automated health check. Reply with exactly the word OK and nothing else. Do not read or modify any files.";

export const HEALTH_CHECK_TIMEOUT_MS = 60_000;

export type ModelHealthResult = {
  runner: Exclude<RunnerName, "auto">;
  ok: boolean;
  error?: string;
  durationMs: number;
  model?: string;
  /** Billing-relevant auth mode observed for the runner. */
  authMode?: AuthMode;
};

function openRouterApiKey(): string {
  return (
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.IMEMORY_OPENROUTER_API_KEY?.trim() ||
    ""
  );
}

function tokenRouterApiKey(): string {
  return (
    process.env.TOKENROUTER_API_KEY?.trim() ||
    process.env.IMEMORY_TOKENROUTER_API_KEY?.trim() ||
    ""
  );
}

/** Runners this Mac agent is actually configured to use, in the same order the auto cascade tries them. */
export async function candidateHealthCheckRunners(deps?: {
  autoChainDeps?: Parameters<typeof resolveAutoRunnerChain>[0];
  openRouterApiKey?: () => string;
  tokenRouterApiKey?: () => string;
}): Promise<Array<Exclude<RunnerName, "auto">>> {
  const chain: Array<Exclude<RunnerName, "auto">> = [
    ...(await resolveAutoRunnerChain(deps?.autoChainDeps)),
  ];
  if ((deps?.openRouterApiKey ?? openRouterApiKey)()) {
    chain.push("openrouter");
  }
  if ((deps?.tokenRouterApiKey ?? tokenRouterApiKey)()) {
    chain.push("tokenrouter");
  }
  return Array.from(new Set(chain));
}

/** Run a single runner against the trivial health-check prompt, bounded by a timeout. */
export async function checkRunnerHealth(
  name: Exclude<RunnerName, "auto">,
  opts?: { timeoutMs?: number; createRunner?: (name: Exclude<RunnerName, "auto">) => Runner },
): Promise<ModelHealthResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS);

  try {
    const runner = (opts?.createRunner ?? createRunnerByName)(name);
    const result = await runner.run({
      cwd: tmpdir(),
      prompt: HEALTH_CHECK_PROMPT,
      onLog: () => {},
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const authMode = authModeForRunner(name);
    if (result.status === "succeeded") {
      return { runner: name, ok: true, durationMs, model: result.model, authMode };
    }
    return {
      runner: name,
      ok: false,
      durationMs,
      authMode,
      error: result.error || `Runner ${name} did not succeed (${result.status})`,
    };
  } catch (err) {
    return {
      runner: name,
      ok: false,
      durationMs: Date.now() - startedAt,
      authMode: authModeForRunner(name),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health-check mode: probe every model runner this Mac agent is configured to use and
 * report whether each one can actually respond. Runs sequentially (not in parallel) so
 * CLI-based runners don't contend for the same local resources.
 */
export async function runHealthCheck(deps?: {
  autoChainDeps?: Parameters<typeof resolveAutoRunnerChain>[0];
  llmApiKey?: () => string;
  openRouterApiKey?: () => string;
  tokenRouterApiKey?: () => string;
  timeoutMs?: number;
  createRunner?: (name: Exclude<RunnerName, "auto">) => Runner;
}): Promise<ModelHealthResult[]> {
  const runners = await candidateHealthCheckRunners(deps);
  const results: ModelHealthResult[] = [];
  for (const name of runners) {
    results.push(
      await checkRunnerHealth(name, {
        timeoutMs: deps?.timeoutMs,
        createRunner: deps?.createRunner,
      }),
    );
  }
  return results;
}
