/**
 * Plan for a future HTTP relay child. start() does not spawn a process unless
 * a test passes allowSpawn. The CLI and the Cloudflare tunnel supervisor do
 * not call this.
 */
export type RelaySpawn = (argv: readonly string[]) => void;

export function createHttpRelaySupervisor(options: { spawn?: RelaySpawn; allowSpawn?: boolean }) {
  return {
    start(input: { enabled: boolean; argv?: readonly string[] }): {
      started: boolean;
      reason: "disabled" | "spawn_not_allowed" | "started";
    } {
      if (!input.enabled) return { started: false, reason: "disabled" };
      if (options.allowSpawn !== true || !options.spawn) {
        return { started: false, reason: "spawn_not_allowed" };
      }
      options.spawn(input.argv ?? []);
      return { started: true, reason: "started" };
    },
  };
}
