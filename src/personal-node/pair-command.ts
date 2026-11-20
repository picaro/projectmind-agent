/**
 * Shell commands the ProjectMind Computers page copies for a personal node.
 * Flags match `parseCli`. The pairing code is the secret. Connector and API tokens are not.
 *
 * Kept identical in ProjectMind (packages/personal-node-contracts) and
 * projectmind-agent (src/personal-node).
 */

export type EngineeringPairCommandInput = {
  server: string;
  sessionId: string;
  code: string;
};

/** npm package that runs the node: `projectmind-agent node <pair|run>`. */
export const PERSONAL_NODE_AGENT_PACKAGE = "projectmind-agent@latest";

/** Legacy single-file download, still served for computers paired before projectmind-agent. */
export const PERSONAL_NODE_AGENT_PATH = "/personal-node/agent.mjs";

const NPX_AGENT = `npx -y ${PERSONAL_NODE_AGENT_PACKAGE}`;

/** Argv that `parseCli` accepts, starting at the subcommand after `node`. */
export function engineeringPairCliArgs(input: EngineeringPairCommandInput): string[] {
  return ["pair", "--server", input.server, "--session-id", input.sessionId, "--code", input.code];
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Command a paired computer runs after {@link formatEngineeringPairCommand}.
 * The server origin, node id, and device credential come from the state file `pair` wrote.
 * `@latest` fetches the current agent, so a restart picks up a newer node runtime.
 * A running `projectmind-agent` also starts this on its own once the computer is paired.
 */
export function formatEngineeringRunCommand(): string {
  return `${NPX_AGENT} node run`;
}

export function formatEngineeringPairCommand(input: EngineeringPairCommandInput): string {
  const origin = input.server.replace(/\/+$/, "");
  return [
    NPX_AGENT,
    "node",
    // Even positions after the subcommand are flag values.
    ...engineeringPairCliArgs({ ...input, server: origin }).map((arg, index) =>
      index > 0 && index % 2 === 0 ? quoteShell(arg) : arg,
    ),
  ].join(" ");
}
