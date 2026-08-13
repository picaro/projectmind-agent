import { runCliProcess } from "./cli-process.js";
import type { Runner, RunnerResult } from "./types.js";

/**
 * Google Antigravity CLI (`agy`) non-interactive runner.
 * Uses print mode + skip-permissions for headless Mac-agent jobs.
 */
export function createAntigravityCliRunner(options: {
  /** Binary name or path. Default: agy */
  command?: string;
  model?: string;
  /** Extra args after fixed flags, before -p prompt. */
  extraArgs?: string[];
  /**
   * Auto-approve tool permissions (required for unattended runs).
   * Default true; set IMEMORY_ANTIGRAVITY_SKIP_PERMISSIONS=0 to disable.
   */
  skipPermissions?: boolean;
}): Runner {
  const command =
    options.command?.trim() ||
    process.env.IMEMORY_ANTIGRAVITY_CLI_BIN?.trim() ||
    process.env.ANTIGRAVITY_CLI_BIN?.trim() ||
    "agy";
  const model = options.model?.trim() || process.env.IMEMORY_ANTIGRAVITY_MODEL?.trim() || undefined;
  const skipPermissions =
    options.skipPermissions ?? process.env.IMEMORY_ANTIGRAVITY_SKIP_PERMISSIONS?.trim() !== "0";

  return {
    name: "antigravity_cli",
    async run({ cwd, prompt, onLog, signal, timeoutMs }): Promise<RunnerResult> {
      const args: string[] = [];

      if (model) {
        args.push("--model", model);
      }
      if (skipPermissions) {
        args.push("--dangerously-skip-permissions");
      }
      // Prefer accepting edits over plan-only for implementation jobs.
      args.push("--mode", "accept-edits");
      // Antigravity defaults print mode to five minutes, which is shorter than
      // normal ProjectMind jobs and causes long-running test/build work to be
      // killed while the agent lease is still healthy. Leave headroom below
      // the job wall clock so the queue watchdog remains authoritative.
      const printTimeoutMs = timeoutMs && timeoutMs > 0 ? Math.max(60_000, timeoutMs - 30_000) : undefined;
      if (printTimeoutMs) {
        args.push("--print-timeout", `${Math.ceil(printTimeoutMs / 1000)}s`);
      }
      if (options.extraArgs?.length) {
        args.push(...options.extraArgs);
      }
      args.push("-p", prompt);

      await onLog(
        `Starting Antigravity CLI (${command}) in ${cwd}` +
          (model ? ` model=${model}` : "") +
          (skipPermissions ? " skip-permissions" : ""),
        "status",
      );

      const result = await runCliProcess({
        command,
        args,
        cwd,
        signal,
        onLog,
      });

      if (result.cancelled || signal.aborted) {
        return {
          status: "cancelled",
          summary: result.stdout.trim().slice(0, 8_000) || "Cancelled",
          model: model || "default",
        };
      }

      if (result.code !== 0) {
        const errTail = (result.stderr || result.stdout).trim().slice(-4_000);
        return {
          status: "failed",
          summary: result.stdout.trim().slice(0, 8_000),
          error:
            `Antigravity CLI exited with code ${result.code ?? "?"}` +
            (errTail ? `: ${errTail}` : ""),
          model: model || "default",
        };
      }

      const summary = result.stdout.trim().slice(0, 8_000) || "Antigravity CLI finished";
      return {
        status: "succeeded",
        summary,
        model: model || "default",
      };
    },
  };
}
