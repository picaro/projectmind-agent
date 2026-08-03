import { runCliProcess } from "./cli-process.js";
import type { Runner, RunnerResult } from "./types.js";

/**
 * GitHub Copilot CLI (`copilot`) non-interactive runner.
 * Uses `-p` prompt mode with allow-all + no-ask-user for headless Mac-agent jobs.
 */
export function createCopilotCliRunner(options: {
  /** Binary name or path. Default: copilot */
  command?: string;
  apiKey?: string;
  model?: string;
  /**
   * Grant all tools/paths/URLs (required for unattended coding jobs).
   * Default true; set IMEMORY_COPILOT_ALLOW_ALL=0 to disable.
   */
  allowAll?: boolean;
  /** Extra args after fixed flags, before -p prompt. */
  extraArgs?: string[];
}): Runner {
  const command =
    options.command?.trim() ||
    process.env.IMEMORY_COPILOT_CLI_BIN?.trim() ||
    process.env.COPILOT_CLI_BIN?.trim() ||
    "copilot";
  const model = options.model?.trim() || process.env.IMEMORY_COPILOT_MODEL?.trim() || undefined;
  const allowAll = options.allowAll ?? process.env.IMEMORY_COPILOT_ALLOW_ALL?.trim() !== "0";

  return {
    name: "copilot_cli",
    async run({ cwd, prompt, onLog, signal }): Promise<RunnerResult> {
      const args: string[] = ["-p", prompt, "--no-ask-user"];

      if (model) {
        args.push("--model", model);
      }
      if (allowAll) {
        // GitHub docs: --allow-all / --yolo for unattended tool use.
        args.push("--allow-all");
      } else {
        args.push("--allow-tool=write,shell");
      }
      if (options.extraArgs?.length) {
        args.push(...options.extraArgs);
      }

      await onLog(
        `Starting Copilot CLI (${command}) in ${cwd}` +
          (model ? ` model=${model}` : "") +
          (allowAll ? " allow-all" : ""),
        "status",
      );

      const env: NodeJS.ProcessEnv = {};
      if (options.apiKey?.trim()) {
        // Preferred token env for Copilot CLI programmatic use.
        env.COPILOT_GITHUB_TOKEN = options.apiKey.trim();
        env.GH_TOKEN = options.apiKey.trim();
      }

      const result = await runCliProcess({
        command,
        args,
        cwd,
        env: Object.keys(env).length ? env : undefined,
        signal,
        onLog,
      });

      const resolvedModel = model || "default";

      if (result.cancelled || signal.aborted) {
        return {
          status: "cancelled",
          summary: result.stdout.trim().slice(0, 8_000) || "Cancelled",
          model: resolvedModel,
        };
      }

      if (result.code !== 0) {
        const errTail = (result.stderr || result.stdout).trim().slice(-4_000);
        return {
          status: "failed",
          summary: result.stdout.trim().slice(0, 8_000),
          error:
            `Copilot CLI exited with code ${result.code ?? "?"}` + (errTail ? `: ${errTail}` : ""),
          model: resolvedModel,
        };
      }

      const summary = result.stdout.trim().slice(0, 8_000) || "Copilot CLI finished";
      return {
        status: "succeeded",
        summary,
        model: resolvedModel,
      };
    },
  };
}
