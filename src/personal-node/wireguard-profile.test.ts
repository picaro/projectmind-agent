import { describe, expect, it } from "vitest";
import { createDockerExecutor, planApplyStack, type DockerClient } from "./docker.ts";
import { formatEnvFile } from "./env-file.ts";
import { assertApplyStack } from "./stack.ts";
import { PayloadRejected } from "./validate.ts";
import {
  WIREGUARD_EASY_DIGESTS,
  WIREGUARD_UDP_PUBLISH,
  parseVpnEndpoint,
  wireguardImageReference,
  wireguardRuntimeEnv,
} from "./wireguard-profile.ts";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";
const ARM = WIREGUARD_EASY_DIGESTS["linux/arm64"];
const PASSWORD_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0u0123456789ABCDEFGHIJKLMNOPQRSTU";

function wireguardPayload(overrides: Record<string, unknown> = {}) {
  return {
    installationId: INSTALLATION,
    networkName: `pn-net-${INSTALLATION}`,
    declaredPlatform: "linux/arm64",
    environmentSecretRef: "hosting-env:550e8400-e29b-41d4-a716-446655440000:runtime",
    vpnEndpoint: "192.168.1.20",
    passwordHash: PASSWORD_HASH,
    containers: [
      {
        role: "primary",
        imageDigest: ARM,
        containerPort: 51821,
        publishLoopback: true,
        runtimeProfile: "wireguard-endpoint",
        volumeSpecs: [{ name: "wg-easy", mountPath: "/etc/wireguard" }],
      },
    ],
    ...overrides,
  };
}

describe("wireguard endpoint profile", () => {
  it("accepts a LAN address and rejects loopback", () => {
    expect(parseVpnEndpoint("192.168.1.20")).toBe("192.168.1.20");
    expect(parseVpnEndpoint("vpn.home")).toBe("vpn.home");
    expect(parseVpnEndpoint("127.0.0.1")).toBeNull();
    expect(parseVpnEndpoint("localhost")).toBeNull();
    expect(parseVpnEndpoint("192.168.1.20:51820")).toBeNull();
  });

  it("publishes UDP 51820 and keeps the admin UI on loopback", () => {
    const steps = planApplyStack({
      installationId: INSTALLATION,
      payload: wireguardPayload(),
    });
    const run = steps.find((args) => args[0] === "run");
    expect(run).toBeTruthy();
    expect(run).toContain(WIREGUARD_UDP_PUBLISH);
    expect(run).toContain("127.0.0.1:51821:51821");
    expect(run).toContain("NET_ADMIN");
    expect(run).toContain("/dev/net/tun");
    expect(run?.join(" ")).toContain("destination=/etc/wireguard");
    expect(run).not.toContain("--privileged");
    expect(run?.[run.indexOf("--network") + 1]).not.toBe("host");
    expect(run?.at(-1)).toBe(ARM);
    expect(
      steps.some((args) => args[0] === "pull" && args[1] === wireguardImageReference(ARM)),
    ).toBe(true);
    const envLine = formatEnvFile(wireguardRuntimeEnv("192.168.1.20", PASSWORD_HASH));
    expect(envLine).toContain(`PASSWORD_HASH=${PASSWORD_HASH}`);
    expect(envLine).not.toContain(`"${PASSWORD_HASH}"`);
  });

  it("applies the profile through the executor, including the second safety check", async () => {
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push(args);
        if (args[0] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "No such container" };
        }
        if (args[0] === "manifest") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              manifests: [{ platform: { architecture: "arm64", os: "linux" } }],
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await createDockerExecutor({ client, arch: "arm64" }).apply({
      id: "cmd-wg",
      deploymentId: INSTALLATION,
      type: "apply_stack",
      payload: wireguardPayload(),
    });
    expect(result.outcome).toBe("applied");
    expect(result.log).not.toContain(PASSWORD_HASH);
    const run = calls.find((args) => args[0] === "run");
    expect(run).toContain(WIREGUARD_UDP_PUBLISH);
    expect(calls.some((args) => args[0] === "pull")).toBe(true);
  });

  it("keeps going when the stack network is already there", async () => {
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push(args);
        if (args[0] === "network") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `Error response from daemon: network with name ${args[2]} already exists\n`,
          };
        }
        if (args[0] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "No such container" };
        }
        if (args[0] === "manifest") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              manifests: [{ platform: { architecture: "arm64", os: "linux" } }],
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await createDockerExecutor({ client, arch: "arm64" }).apply({
      id: "cmd-wg-retry",
      deploymentId: INSTALLATION,
      type: "apply_stack",
      payload: wireguardPayload(),
    });
    expect(result.outcome).toBe("applied");
    expect(calls.some((args) => args[0] === "run")).toBe(true);
  });

  it("rejects an unpinned image and a host-network field", () => {
    expect(() =>
      assertApplyStack(
        wireguardPayload({
          containers: [
            {
              ...(wireguardPayload().containers[0] as object),
              imageDigest: `sha256:${"ab".repeat(32)}`,
            },
          ],
        }),
      ),
    ).toThrow(PayloadRejected);
    expect(() => assertApplyStack(wireguardPayload({ networkMode: "host" }))).toThrow(
      PayloadRejected,
    );
    expect(() => assertApplyStack(wireguardPayload({ vpnEndpoint: "127.0.0.1" }))).toThrow(
      PayloadRejected,
    );
  });
});
