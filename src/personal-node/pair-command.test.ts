import { describe, expect, it } from "vitest";

import { parseCli } from "./config.ts";
import {
  engineeringPairCliArgs,
  formatEngineeringPairCommand,
  formatEngineeringRunCommand,
} from "./pair-command.ts";

const SESSION = "550e8400-e29b-41d4-a716-446655440011";
const CODE = "ABCD-EFGH";
const SERVER = "https://projectm.dev";

describe("engineering pair command", () => {
  it("is the pair argv the CLI parses, with the server URL and without tunnel secrets", () => {
    const args = engineeringPairCliArgs({ server: SERVER, sessionId: SESSION, code: CODE });
    expect(parseCli(args, {})).toMatchObject({
      command: "pair",
      server: SERVER,
      sessionId: SESSION,
      code: CODE,
    });
    const command = formatEngineeringPairCommand({
      server: `${SERVER}/`,
      sessionId: SESSION,
      code: CODE,
    });
    expect(command).toBe(
      "npx -y projectmind-agent@latest node pair --server 'https://projectm.dev' --session-id '550e8400-e29b-41d4-a716-446655440011' --code 'ABCD-EFGH'",
    );
    expect(command).not.toContain("/tmp/");
    expect(command).not.toContain("curl");
    expect(command).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(command).not.toContain("CLOUDFLARE_TUNNEL_TOKEN");
    expect(command).not.toContain("pnd_");
  });

  it("quotes values so a hostile origin cannot break out of the argument", () => {
    const command = formatEngineeringPairCommand({
      server: "https://x.dev/'; rm -rf ~",
      sessionId: SESSION,
      code: CODE,
    });
    expect(command).toContain("--server 'https://x.dev/'\\''; rm -rf ~'");
  });

  it("copies a run command that uses saved state, no Docker flag, and no Cloudflare tokens", () => {
    const command = formatEngineeringRunCommand();
    expect(command).toBe("npx -y projectmind-agent@latest node run");
    expect(command).not.toContain("--server");
    expect(command).not.toContain("IMEMORY_PERSONAL_NODE_DOCKER");
    expect(command).not.toContain("CLOUDFLARE_TUNNEL_TOKEN");
    expect(parseCli(["run"], {})).toMatchObject({ command: "run", server: "" });
  });
});
