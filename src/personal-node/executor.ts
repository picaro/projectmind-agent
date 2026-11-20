import { redactSecrets } from "./redact.ts";
import type { AgentCommand, ApplyResult, CommandExecutor, NodeArch } from "./types.ts";
import { PayloadRejected, validateCommand } from "./validate.ts";

export const APPLIED_WITHOUT_CONTAINER =
  "Declarative payload accepted. No container was started. No public URL was published.";

export function failureResult(error: unknown, secrets: readonly string[] = []): ApplyResult {
  if (error instanceof PayloadRejected) {
    return {
      outcome: "failed",
      publicUrl: null,
      code: error.code,
      log: redactSecrets(error.message, secrets),
    };
  }
  const message = error instanceof Error ? error.message : "Command failed.";
  return {
    outcome: "failed",
    publicUrl: null,
    code: "apply_failed",
    log: redactSecrets(message, secrets),
  };
}

/** Validates the payload again. Does not start a container and does not report a URL. */
export function createValidatingExecutor(arch: NodeArch): CommandExecutor {
  return {
    async apply(command: AgentCommand): Promise<ApplyResult> {
      try {
        validateCommand(command, arch);
      } catch (error) {
        return failureResult(error);
      }
      if (command.type === "apply_route" || command.type === "stop_route") {
        return failureResult(
          new PayloadRejected(
            "tunnel_not_configured",
            "No Cloudflare tunnel connector token was configured for this executor. No listener was opened.",
          ),
        );
      }
      return {
        outcome: "applied",
        publicUrl: null,
        log: APPLIED_WITHOUT_CONTAINER,
      };
    },
  };
}
