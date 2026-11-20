import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CONTAINER_INSTANCE_FORMAT,
  assertSafeDockerArgs,
  containerNameFor,
  createDockerExecutor,
  createProcessDockerClient,
  findDocker,
  manifestMatchesArch,
  planDeploy,
  planRemove,
  planRun,
  selectExecutor,
  type DockerClient,
} from "./docker.js";
import { parseEnvFile } from "./env-file.js";
import { PayloadRejected } from "./validate.js";
import { buildHeartbeat } from "./heartbeat.js";
import { DEPLOY_RECEIPT_FORMAT } from "./deploy-replay.js";
import {
  WIREGUARD_CAP,
  WIREGUARD_CONFIG_MOUNT,
  WIREGUARD_DEVICE,
  WIREGUARD_EASY_DIGESTS,
  WIREGUARD_ENDPOINT_PROFILE,
  WIREGUARD_SYSCTLS,
  WIREGUARD_UDP_PUBLISH,
} from "./wireguard-profile.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const DEPLOYMENT = "550e8400-e29b-41d4-a716-446655440000";

function deployPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageDigest: DIGEST,
    declaredPlatform: "linux/amd64",
    containerPort: 8080,
    environmentSecretRef: "hosting-env:550e8400-e29b-41d4-a716-446655440000:runtime",
    volumeSpecs: [{ name: "data" }],
    ...overrides,
  };
}

describe("planRemove", () => {
  it("does not delete volumes when deleteVolumes is false", () => {
    const planned = planRemove({
      containerName: "pn-app",
      deleteVolumes: false,
      volumeNames: ["data"],
    });
    expect(planned).toEqual([["rm", "-f", "pn-app"]]);
    expect(planned.flat()).not.toContain("-v");
    expect(planned.flat()).not.toContain("volume");
  });

  it("removes named volumes only when deleteVolumes is true", () => {
    const planned = planRemove({
      containerName: "pn-app",
      deleteVolumes: true,
      volumeNames: ["data"],
    });
    expect(planned).toEqual([
      ["rm", "-f", "pn-app"],
      ["volume", "rm", "data"],
    ]);
    expect(planned[0]).not.toContain("-v");
  });
});

describe("docker executor", () => {
  it("does not send a volume-delete flag when the payload omits deleteVolumes", async () => {
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await createDockerExecutor({ client, arch: "amd64" }).apply({
      id: "cmd-rm",
      deploymentId: DEPLOYMENT,
      type: "remove",
      payload: { preserveVolumes: true, volumeNames: ["data"] },
    });
    expect(result.outcome).toBe("applied");
    expect(result.publicUrl).toBeNull();
    expect(calls).toEqual([["rm", "-f", containerNameFor(DEPLOYMENT)]]);
    expect(calls.flat().join(" ")).not.toMatch(/\s-v\b|\bvolume\b/);
  });

  it("removes a named volume only for an explicit delete", async () => {
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await createDockerExecutor({ client, arch: "amd64" }).apply({
      id: "cmd-rm",
      deploymentId: DEPLOYMENT,
      type: "remove",
      payload: { preserveVolumes: false, deleteVolumes: true, volumeNames: ["data"] },
    });
    expect(calls[1]).toEqual(["volume", "rm", "data"]);
  });

  it("returns stderr from fetch_logs, because that is where a crash trace is", async () => {
    const client: DockerClient = {
      async run() {
        return {
          exitCode: 0,
          stdout: "> app@1.0.0 start\n",
          stderr: "Error: DATABASE_URL is not set\n",
        };
      },
    };
    const result = await createDockerExecutor({ client, arch: "amd64" }).apply({
      id: "cmd-logs",
      deploymentId: DEPLOYMENT,
      type: "fetch_logs",
      payload: { tailLines: 200 },
    });
    expect(result.outcome).toBe("applied");
    expect(result.log).toContain("> app@1.0.0 start");
    expect(result.log).toContain("DATABASE_URL is not set");
  });

  it("keeps the end of a long fetch_logs, not the start", async () => {
    const client: DockerClient = {
      async run() {
        return { exitCode: 0, stdout: `${"early line\n".repeat(600)}last line\n`, stderr: "" };
      },
    };
    const result = await createDockerExecutor({ client, arch: "amd64" }).apply({
      id: "cmd-logs-long",
      deploymentId: DEPLOYMENT,
      type: "fetch_logs",
      payload: { tailLines: 200 },
    });
    expect(result.log.length).toBeLessThanOrEqual(4000);
    expect(result.log).toContain("last line");
  });

  it("does not call docker for a privileged or tag payload", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const executor = createDockerExecutor({ client: { run }, arch: "amd64" });
    const privileged = await executor.apply({
      id: "cmd-1",
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload: deployPayload({ privileged: true }),
    });
    const tagged = await executor.apply({
      id: "cmd-2",
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload: deployPayload({ imageDigest: "nginx:latest" }),
    });
    expect(privileged.outcome).toBe("failed");
    expect(tagged.outcome).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("plans a digest run without privileged, host network, docker.sock, or a shell", () => {
    const args = planRun({
      containerName: containerNameFor(DEPLOYMENT),
      payload: deployPayload(),
    });
    expect(args).not.toContain("--privileged");
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args.at(-1)).toBe(DIGEST);
    expect(args[args.indexOf("--pull") + 1]).toBe("never");
    expect(args[args.indexOf("--publish") + 1]).toBe("127.0.0.1:8080:8080");
    const split = planRun({
      containerName: containerNameFor(DEPLOYMENT),
      payload: deployPayload({ hostPort: 21000 }),
    });
    expect(split[split.indexOf("--publish") + 1]).toBe("127.0.0.1:21000:8080");
    expect(args.join(" ")).not.toContain("0.0.0.0");
    expect(args.some((arg) => arg === "sh" || arg === "bash" || arg.includes("sh -c"))).toBe(false);
    expect(() => assertSafeDockerArgs(["run", "--privileged", DIGEST])).toThrow(PayloadRejected);
    expect(() =>
      assertSafeDockerArgs(["run", "--pull", "never", "--publish", "0.0.0.0:8080:8080", DIGEST]),
    ).toThrow(PayloadRejected);
    expect(() =>
      assertSafeDockerArgs(["run", "-v", "/var/run/docker.sock:/var/run/docker.sock", DIGEST]),
    ).toThrow(PayloadRejected);
  });

  it("keeps the validating executor when docker is off", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const executor = selectExecutor({
      dockerEnabled: false,
      socketReachable: true,
      arch: "amd64",
      docker: { run },
    });
    const result = await executor.apply({
      id: "cmd-1",
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload: deployPayload(),
    });
    expect(result.outcome).toBe("applied");
    expect(result.publicUrl).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

const COMPATIBLE_MANIFEST = JSON.stringify({
  manifests: [
    { platform: { architecture: "arm64", os: "linux" } },
    { platform: { architecture: "amd64", os: "linux" } },
  ],
});

function deployCommand(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    deploymentId: DEPLOYMENT,
    type: "deploy",
    payload: deployPayload({ commandId: id, deploymentId: DEPLOYMENT, ...overrides }),
  };
}

function recordingDocker(manifest = COMPATIBLE_MANIFEST) {
  const calls: string[][] = [];
  const client: DockerClient = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "inspect" && args[2] === CONTAINER_INSTANCE_FORMAT)
        return { exitCode: 0, stdout: "ab".repeat(32), stderr: "" };
      if (args[0] === "inspect" && args[2] === DEPLOY_RECEIPT_FORMAT) {
        return { exitCode: 1, stdout: "", stderr: "Error: No such object" };
      }
      if (args[0] === "rm") {
        return { exitCode: 1, stdout: "", stderr: "Error: No such container: pn-test" };
      }
      return {
        exitCode: 0,
        stdout: args[0] === "manifest" ? manifest : "",
        stderr: "",
      };
    },
  };
  return { calls, client };
}

describe("digest-pinned localhost container", () => {
  it("advertises manifest protocol support without claiming a running runtime", () => {
    const report = buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "amd64" });
    expect(report.capabilities.pinnedImageReferences).toBe(true);
    expect(report.capabilities.idempotentPinnedDeploys).toBe(true);
    expect(report.runtimeStatus).toBe("unavailable");
    expect(report.tunnelStatus).toBe("unavailable");
  });
  it.each(["running", "exited", "restarting", ""])(
    "executes the exact manifest address and observes post-start state %j",
    async (status) => {
      const pinned = `registry.example.test/team/app@${DIGEST}`;
      const { calls, client } = recordingDocker();
      const base = client.run.bind(client);
      client.run = async (args, options) => {
        const result = await base(args, options);
        return args[0] === "inspect" &&
          args[2] !== DEPLOY_RECEIPT_FORMAT &&
          args[2] !== CONTAINER_INSTANCE_FORMAT
          ? { ...result, stdout: status }
          : result;
      };
      const result = await createDockerExecutor({
        client,
        arch: "amd64",
        redeemEnv: async () => ({}),
      }).apply(deployCommand("550e8400-e29b-41d4-a716-446655440001", { imageDigest: pinned }));
      expect(calls[0]).toEqual([
        "inspect",
        "--format",
        DEPLOY_RECEIPT_FORMAT,
        containerNameFor(DEPLOYMENT),
      ]);
      expect(calls[1]).toEqual(["manifest", "inspect", "--verbose", pinned]);
      expect(calls).toContainEqual(["pull", pinned]);
      const run = calls.find((args) => args[0] === "run")!;
      expect(run.at(-1)).toBe(pinned);
      expect(run[run.indexOf("--pull") + 1]).toBe("never");
      expect(calls.at(-1)).toEqual([
        "inspect",
        "--format",
        "{{.State.Status}}",
        containerNameFor(DEPLOYMENT),
      ]);
      expect(result.outcome).toBe(status === "running" ? "applied" : "failed");
      if (status !== "running") expect(result.code).toBe("container_not_running");
      expect(result.publicUrl).toBeNull();
      expect(calls.flat()).not.toContain("-v");
      expect(calls.flat()).not.toContain("--privileged");
    },
  );

  it("does not pull or replace a container when a pinned manifest has the wrong platform", async () => {
    const { calls, client } = recordingDocker(
      JSON.stringify({ platform: { os: "linux", architecture: "arm64" } }),
    );
    const result = await createDockerExecutor({ client, arch: "amd64" }).apply(
      deployCommand("550e8400-e29b-41d4-a716-446655440001", {
        imageDigest: `registry.example.test/team/app@${DIGEST}`,
      }),
    );
    expect(result.code).toBe("image_arch_mismatch");
    expect(calls.map((args) => args[0])).toEqual(["inspect", "manifest"]);
  });

  it("requires a sha256 digest and does not run a tag or a shell", async () => {
    const { calls, client } = recordingDocker();
    const executor = createDockerExecutor({ client, arch: "amd64" });
    const tagged = await executor.apply(deployCommand("cmd-tag", { imageDigest: "nginx:latest" }));
    const otherHash = await executor.apply(
      deployCommand("cmd-sha512", { imageDigest: `sha512:${"ab".repeat(32)}` }),
    );
    const shell = await executor.apply(deployCommand("cmd-shell", { command: "sh -c id" }));
    expect(tagged.code).toBe("image_digest_required");
    expect(otherHash.code).toBe("image_digest_required");
    expect(shell.code).toBe("forbidden_command_field");
    expect(calls).toEqual([]);
  });

  it("rejects privileged mode and a host bind before docker is called", async () => {
    const { calls, client } = recordingDocker();
    const executor = createDockerExecutor({ client, arch: "amd64" });
    const privileged = await executor.apply(deployCommand("cmd-priv", { privileged: true }));
    const hostBind = await executor.apply(
      deployCommand("cmd-bind", { volumeSpecs: [{ name: "data", source: "/Users/mini/app" }] }),
    );
    const hostNet = await executor.apply(deployCommand("cmd-net", { networkMode: "host" }));
    expect(privileged.code).toBe("forbidden_command_field");
    expect(hostBind.code).toBe("forbidden_command_field");
    expect(hostNet.code).toBe("forbidden_command_field");
    expect(calls).toEqual([]);
  });

  it("publishes 127.0.0.1 only and keeps the named volume across a new revision", async () => {
    const { calls, client } = recordingDocker();
    const executor = createDockerExecutor({ client, arch: "amd64" });
    const first = await executor.apply(
      deployCommand("cmd-rev-1", {
        resourceLimits: { cpu: 0.5, memoryMb: 256 },
        healthCheck: { path: "/health" },
      }),
    );
    const second = await executor.apply(deployCommand("cmd-rev-2"));
    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("applied");
    expect(first.publicUrl).toBeNull();
    expect(first.log).not.toMatch(/\bLIVE\b/);
    const runs = calls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.[runs[0].indexOf("--publish") + 1]).toBe("127.0.0.1:8080:8080");
    expect(runs[0]?.[runs[0].indexOf("--cpus") + 1]).toBe("0.500");
    expect(runs[0]?.[runs[0].indexOf("--memory") + 1]).toBe("256m");
    expect(calls.flat()).not.toContain("0.0.0.0");
    expect(calls.flat()).not.toContain("--privileged");
    expect(calls.flat()).not.toContain("-e");
    expect(calls.flat()).not.toContain("--env");
    expect(calls.flat()).not.toContain("/health");
    expect(calls.flat().join(" ")).not.toContain("hosting-env");
    expect(calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(calls.filter((args) => args[0] === "rm").every((args) => !args.includes("-v"))).toBe(
      true,
    );
    expect(calls.filter((args) => args[0] === "volume" && args[1] === "create").length).toBe(2);
    const stopped = await executor.apply({
      id: "cmd-stop",
      deploymentId: DEPLOYMENT,
      type: "stop",
      payload: {},
    });
    expect(stopped.outcome).toBe("applied");
    expect(calls.at(-1)).toEqual(["stop", containerNameFor(DEPLOYMENT)]);
    const started = await executor.apply({
      id: "cmd-start",
      deploymentId: DEPLOYMENT,
      type: "start",
      payload: {},
    });
    expect(started.outcome).toBe("applied");
    expect(calls.at(-1)).toEqual(["start", containerNameFor(DEPLOYMENT)]);
    expect(calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  });

  it("does not start a second container for the same command id", async () => {
    const { calls, client } = recordingDocker();
    const executor = createDockerExecutor({ client, arch: "amd64" });
    const command = deployCommand("cmd-same");
    await executor.apply(command);
    await executor.apply(command);
    expect(calls.filter((args) => args[0] === "run")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "pull")).toHaveLength(1);
  });

  it("does not pull when the injected manifest has no matching architecture", async () => {
    expect(manifestMatchesArch(COMPATIBLE_MANIFEST, "amd64")).toBe(true);
    const armOnly = JSON.stringify({
      manifests: [{ platform: { architecture: "arm64", os: "linux" } }],
    });
    expect(manifestMatchesArch(armOnly, "amd64")).toBe(false);
    const { calls, client } = recordingDocker(armOnly);
    const result = await createDockerExecutor({ client, arch: "amd64" }).apply(
      deployCommand("cmd-arch"),
    );
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("image_arch_mismatch");
    expect(result.publicUrl).toBeNull();
    expect(calls.map((args) => args[0])).toEqual(["manifest"]);
  });

  it("returns container_runtime_not_installed and does not install docker", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const missing = await createDockerExecutor({
      client: { run },
      arch: "amd64",
      lookup: async () => null,
    }).apply(deployCommand("cmd-missing"));
    expect(missing.code).toBe("container_runtime_not_installed");
    expect(missing.log).toMatch(/does not download Docker/);
    expect(missing.publicUrl).toBeNull();
    expect(run).not.toHaveBeenCalled();

    const absent = await createDockerExecutor({
      arch: "amd64",
      client: createProcessDockerClient({
        socketPath: "/tmp/personal-node-missing.sock",
        bin: "/tmp/personal-node-docker-not-installed",
      }),
    }).apply(deployCommand("cmd-enoent"));
    expect(absent.code).toBe("container_runtime_not_installed");
    expect(absent.log).toMatch(/does not download Docker/);
  });

  it("spawns a fake docker executable and records argv without a daemon", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pna-docker-"));
    try {
      const record = path.join(dir, "argv.json");
      const bin = path.join(dir, "docker");
      await writeFile(
        bin,
        `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const record = ${JSON.stringify(record)};
const argv = process.argv.slice(2);
const calls = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : [];
calls.push(argv);
writeFileSync(record, JSON.stringify(calls));
if (argv[0] === "manifest") {
  process.stdout.write(${JSON.stringify(COMPATIBLE_MANIFEST)});
}
if (argv[0] === "rm") {
  process.stderr.write("Error: No such container: pn-test");
  process.exit(1);
}
process.exit(0);
`,
        "utf8",
      );
      await chmod(bin, 0o755);
      expect(await findDocker({ PATH: dir })).toBe(bin);
      const payload = deployPayload({ healthCheck: { path: "/health" } });
      const result = await createDockerExecutor({
        arch: "amd64",
        lookup: async () => bin,
        client: createProcessDockerClient({
          socketPath: "/tmp/personal-node-fake.sock",
          bin,
        }),
      }).apply({
        id: "cmd-fake",
        deploymentId: DEPLOYMENT,
        type: "deploy",
        payload,
      });
      expect(result.outcome).toBe("applied");
      expect(result.publicUrl).toBeNull();
      expect(result.log).toMatch(/127\.0\.0\.1:8080/);
      const recorded = JSON.parse(await readFile(record, "utf8")) as string[][];
      expect(recorded).toEqual(
        planDeploy({ containerName: containerNameFor(DEPLOYMENT), payload }),
      );
      expect(recorded.flat()).not.toContain("0.0.0.0");
      expect(recorded.flat()).not.toContain("--privileged");
      expect(recorded.flat()).not.toContain("-v");
      expect(recorded.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
      expect(manifestMatchesArch(COMPATIBLE_MANIFEST, "arm64")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the redeemed env file for docker run and deletes it", async () => {
    const secret = "super-secret-value";
    const apiToken = "cf-api-token-value";
    const envMap = { APP_TOKEN: secret, CLOUDFLARE_API_TOKEN: apiToken };
    const root = await mkdtemp(path.join(tmpdir(), "pna-env-"));
    let existedAtRun = false;
    let mode = 0;
    let ownerMatches = false;
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "run") {
          const file = args[args.indexOf("--env-file") + 1] ?? "";
          const info = await stat(file);
          existedAtRun = true;
          mode = info.mode & 0o777;
          ownerMatches = info.uid === process.getuid?.();
          expect(parseEnvFile(await readFile(file, "utf8"))).toEqual(envMap);
          expect(file.startsWith(root)).toBe(true);
          expect(file).not.toContain("..");
        }
        if (args[0] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "Error: No such container: pn-test" };
        }
        return {
          exitCode: 0,
          stdout: args[0] === "manifest" ? COMPATIBLE_MANIFEST : "",
          stderr: "",
        };
      },
    };
    const payload = deployPayload();
    const result = await createDockerExecutor({
      client,
      arch: "amd64",
      envFileRoot: root,
      redeemEnv: async () => envMap,
    }).apply({
      id: "cmd-env",
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload,
    });
    expect(result.outcome).toBe("applied");
    expect(existedAtRun).toBe(true);
    expect(mode).toBe(0o600);
    expect(ownerMatches).toBe(true);
    const run = calls.find((args) => args[0] === "run");
    expect(run).toContain("--env-file");
    expect(run).not.toContain("-e");
    expect(run).not.toContain("--env");
    const flat = calls.flat().join(" ");
    expect(flat).not.toContain(secret);
    expect(flat).not.toContain(apiToken);
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(result.log).not.toContain(secret);
    expect(result.log).not.toContain(apiToken);
    const file = run?.[run.indexOf("--env-file") + 1] ?? "";
    await expect(stat(file)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it("starts with no env file when the reference is missing", async () => {
    const { calls, client } = recordingDocker();
    const redeemEnv = vi.fn(async () => ({ APP_TOKEN: "super-secret-value" }));
    const payload = deployPayload();
    delete payload.environmentSecretRef;
    const result = await createDockerExecutor({
      client,
      arch: "amd64",
      redeemEnv,
    }).apply({
      id: "cmd-noref",
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload,
    });
    expect(result.outcome).toBe("applied");
    expect(redeemEnv).not.toHaveBeenCalled();
    expect(calls.flat()).not.toContain("--env-file");
    expect(calls.flat()).not.toContain("-e");
    expect(calls.flat()).not.toContain("--env");
    expect(result.log).toMatch(/No environment file was attached/);
  });

  it("still rejects -e, --env, and an env file outside the agent temp dir", () => {
    expect(() => assertSafeDockerArgs(["run", "-e", "APP_TOKEN=super-secret-value"])).toThrow(
      PayloadRejected,
    );
    expect(() => assertSafeDockerArgs(["run", "--env", "APP_TOKEN=super-secret-value"])).toThrow(
      PayloadRejected,
    );
    expect(() =>
      assertSafeDockerArgs(["run", "--env-file", "/tmp/../etc/passwd"], {
        envFileRoot: "/tmp/imemory-personal-node-env",
      }),
    ).toThrow(PayloadRejected);
  });
});

describe("local git build", () => {
  const COMMAND_ID = "660e8400-e29b-41d4-a716-446655440001";
  const BUILT = `sha256:${"cd".repeat(32)}`;
  const INSPECT = JSON.stringify([{ Id: BUILT, Os: "linux", Architecture: "amd64" }]);

  function gitPayload(gitSecretRef?: string): Record<string, unknown> {
    return {
      declaredPlatform: "linux/amd64",
      containerPort: 3000,
      environmentSecretRef: "hosting-env:550e8400-e29b-41d4-a716-446655440000:runtime",
      volumeSpecs: [{ name: "data" }],
      gitBuild: {
        repositoryUrl: "https://github.com/acme/demo",
        ref: "a".repeat(40),
        buildPack: "nixpacks",
        baseDirectory: ".",
        ...(gitSecretRef ? { gitSecretRef } : {}),
      },
    };
  }

  it("ignores a Coolify local tag and runs the digest the build produced", async () => {
    const localImage = "ndps8jrcoxv49lfiirvwcorq:50d2881";
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "cp")
          await writeFile(
            path.join(args[2] ?? "", "package.json"),
            '{"scripts":{"start":"node server.js"}}',
          );
        if (args[0] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "Error: No such container: pn-test" };
        }
        if (args[0] === "image" && args[1] === "inspect") {
          return { exitCode: 0, stdout: INSPECT, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await createDockerExecutor({ client, arch: "amd64" }).apply({
      id: COMMAND_ID,
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload: { ...gitPayload(), imageDigest: localImage },
    });
    expect(result.outcome).toBe("applied");
    expect(result.log).toContain(BUILT);
    expect(result.log).not.toContain(localImage);
    expect(calls.some((args) => args[0] === "pull")).toBe(false);
    expect(calls.flat()).not.toContain(localImage);
    const run = calls.find((args) => args[0] === "run");
    expect(run?.at(-1)).toBe(BUILT);
    expect(run?.[run.indexOf("--publish") + 1]).toBe("127.0.0.1:3000:3000");
  });

  it("builds from git with docker and runs the digest that build produced", async () => {
    const calls: string[][] = [];
    const client: DockerClient = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "cp")
          await writeFile(
            path.join(args[2] ?? "", "package.json"),
            '{"scripts":{"start":"node server.js"}}',
          );
        if (args[0] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "Error: No such container: pn-test" };
        }
        if (args[0] === "image" && args[1] === "inspect") {
          return { exitCode: 0, stdout: INSPECT, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const phases: string[] = [];
    const result = await createDockerExecutor({
      client,
      arch: "amd64",
      redeemEnv: async () => ({ APP_TOKEN: "runtime-secret-value" }),
    }).apply(
      {
        id: COMMAND_ID,
        deploymentId: DEPLOYMENT,
        type: "deploy",
        payload: gitPayload(),
      },
      {
        onPhase: (phase) => {
          phases.push(phase);
        },
      },
    );
    expect(result.outcome).toBe("applied");
    expect(result.publicUrl).toBeNull();
    expect(result.log).toContain(BUILT);
    expect(result.log).toContain("Build spec v1: requested=nixpacks; actual=generated_dockerfile");
    expect(result.log).toContain("expected platform=linux/amd64; runtime port=3000");
    expect(result.log).toContain(`local image config ID=${BUILT}`);
    expect(result.log).toContain("OCI manifest=not published");
    expect(result.log).toContain(`log command=${COMMAND_ID}`);
    expect(result.log).not.toContain("github.com");
    expect(result.log).not.toContain("runtime-secret-value");
    expect(calls.filter((args) => args[0] === "build")).toHaveLength(2);
    expect(calls.some((args) => args[0] === "cp")).toBe(true);
    expect(calls.some((args) => args[0] === "pull")).toBe(false);
    expect(phases).toEqual(["cloning", "building", "starting"]);
    expect(
      calls.some((args) => args[0] === "volume" && args[1] === "create" && args[2] === "data"),
    ).toBe(true);
    const run = calls.find((args) => args[0] === "run");
    expect(run?.at(-1)).toBe(BUILT);
    expect(run?.[run.indexOf("--pull") + 1]).toBe("never");
    expect(run?.[run.indexOf("--publish") + 1]).toBe("127.0.0.1:3000:3000");
    expect(run).toContain("--env-file");
    expect(calls.flat().join(" ")).not.toContain("runtime-secret-value");
    expect(calls.flat()).not.toContain("--secret");
  });

  it("redeems a private clone credential into a 0600 file and does not put it on argv", async () => {
    const token = "super-secret-token-value";
    const calls: string[][] = [];
    let credMode = 0;
    let credText = "";
    const client: DockerClient = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "cp")
          await writeFile(
            path.join(args[2] ?? "", "package.json"),
            '{"scripts":{"start":"node server.js"}}',
          );
        if (args.includes("--secret")) {
          const spec = args[args.indexOf("--secret") + 1] ?? "";
          const file = spec.slice("id=gitcred,src=".length);
          const info = await stat(file);
          credMode = info.mode & 0o777;
          credText = await readFile(file, "utf8");
        }
        if (args[0] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "Error: No such container: pn-test" };
        }
        if (args[0] === "image" && args[1] === "inspect") {
          return { exitCode: 0, stdout: INSPECT, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await createDockerExecutor({
      client,
      arch: "amd64",
      redeemGit: async () => ({ username: "x-access-token", token }),
    }).apply({
      id: "660e8400-e29b-41d4-a716-446655440002",
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload: gitPayload("hosting-git:550e8400-e29b-41d4-a716-446655440000:clone"),
    });
    expect(result.outcome).toBe("applied");
    expect(result.log).toContain(BUILT);
    expect(result.log).not.toContain(token);
    expect(credText).toBe(`x-access-token\n${token}\n`);
    expect(credMode).toBe(0o600);
    expect(calls.flat().join(" ")).not.toContain(token);
    const secretArg = calls.flat().find((arg) => arg.startsWith("id=gitcred,src=")) ?? "";
    const file = secretArg.slice("id=gitcred,src=".length);
    await expect(stat(file)).rejects.toThrow();
    const run = calls.find((args) => args[0] === "run");
    expect(run?.at(-1)).toBe(BUILT);
    expect(calls.some((args) => args[0] === "pull")).toBe(false);
  });

  it.each([
    ["pom.xml", /unsupported.*Dockerfile/],
    ["requirements.txt", /Python.*Dockerfile/],
    ["package.json", /lockfile/],
    ["composer.json", /composer.lock/],
    ["Gemfile", /Gemfile.lock/],
    ["Cargo.toml", /Cargo.lock/],
  ] as const)(
    "rejects incomplete %s before an app build or runtime mutation",
    async (marker, message) => {
      const calls: string[][] = [],
        phases: string[] = [];
      let workspace = "";
      const client: DockerClient = {
        async run(args) {
          calls.push([...args]);
          if (args[0] === "cp") {
            workspace = args[2] ?? "";
            await writeFile(
              path.join(workspace, marker),
              marker === "package.json"
                ? JSON.stringify({ dependencies: { example: "1.0.0" } })
                : ["composer.json", "Gemfile", "Cargo.toml"].includes(marker)
                  ? "{}"
                  : "",
            );
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
      const result = await createDockerExecutor({ client, arch: "amd64" }).apply(
        {
          id: COMMAND_ID,
          deploymentId: DEPLOYMENT,
          type: "deploy",
          payload: gitPayload(),
        },
        {
          onPhase: (phase) => {
            phases.push(phase);
          },
        },
      );
      expect(result.outcome).toBe("failed");
      expect(result.log).toMatch(message);
      expect(phases).toEqual(["cloning"]);
      expect(calls.filter((args) => args[0] === "build")).toHaveLength(1); // clone only
      expect(calls.some((args) => ["run", "volume", "stop"].includes(args[0] ?? ""))).toBe(false);
      expect(calls.some((args) => args[0] === "rm" && args[2]?.startsWith("pn-fetch-"))).toBe(true);
      await expect(stat(workspace)).rejects.toThrow();
    },
  );

  it("passes a Dockerfile secret and build arg from the redeemed env and not on the run argv", async () => {
    const token = "npm-token-value-not-argv";
    const calls: string[][] = [];
    let secretMode = 0;
    const client: DockerClient = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "cp") {
          const dest = args[2] ?? "";
          await writeFile(
            path.join(dest, "Dockerfile"),
            "ARG VITE_SUPABASE_URL\nRUN --mount=type=secret,id=NPM_TOKEN,target=/run/secrets/NPM_TOKEN echo ok\n",
          );
        }
        if (args[0] === "build" && args.includes("--secret")) {
          const spec = args[args.indexOf("--secret") + 1] ?? "";
          if (spec.startsWith("id=NPM_TOKEN,src=")) {
            secretMode = (await stat(spec.slice("id=NPM_TOKEN,src=".length))).mode & 0o777;
          }
        }
        if (args[0] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "Error: No such container: pn-test" };
        }
        if (args[0] === "image" && args[1] === "inspect") {
          return { exitCode: 0, stdout: INSPECT, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await createDockerExecutor({
      client,
      arch: "amd64",
      redeemEnv: async () => ({
        NPM_TOKEN: token,
        VITE_SUPABASE_URL: "https://example.supabase.co",
      }),
    }).apply({
      id: "660e8400-e29b-41d4-a716-446655440003",
      deploymentId: DEPLOYMENT,
      type: "deploy",
      payload: {
        ...gitPayload(),
        gitBuild: {
          repositoryUrl: "https://github.com/acme/demo",
          ref: "a".repeat(40),
          buildPack: "dockerfile",
          baseDirectory: ".",
        },
      },
    });
    expect(result.outcome).toBe("applied");
    expect(result.log).not.toContain(token);
    expect(secretMode).toBe(0o600);
    const appBuild = calls.filter((args) => args[0] === "build").at(-1) ?? [];
    expect(appBuild).toContain("VITE_SUPABASE_URL=https://example.supabase.co");
    expect(appBuild.join(" ")).not.toContain(token);
    expect(appBuild.some((arg) => arg.startsWith("id=NPM_TOKEN,src="))).toBe(true);
    const run = calls.find((args) => args[0] === "run");
    expect(run?.join(" ")).not.toContain(token);
  });
});

describe("wireguard docker argument validation", () => {
  const digest = WIREGUARD_EASY_DIGESTS["linux/arm64"];
  const profile = { runtimeProfile: WIREGUARD_ENDPOINT_PROFILE } as const;

  function wireguardRun(overrides?: {
    cap?: string;
    device?: string;
    mount?: string;
    trailing?: string;
  }): string[] {
    const args = [
      "run",
      "--pull",
      "never",
      "--publish",
      "127.0.0.1:51821:51821",
      "--publish",
      WIREGUARD_UDP_PUBLISH,
      "--cap-add",
      WIREGUARD_CAP,
      "--device",
      WIREGUARD_DEVICE,
      ...WIREGUARD_SYSCTLS.flatMap((sysctl) => ["--sysctl", sysctl]),
      "--mount",
      `type=volume,source=wg-easy,destination=${WIREGUARD_CONFIG_MOUNT}`,
      digest,
    ];
    if (overrides?.cap) {
      const at = args.indexOf("--cap-add");
      args.splice(at, 2, overrides.cap);
    }
    if (overrides?.device) {
      const at = args.indexOf("--device");
      args.splice(at, 2, overrides.device);
    }
    if (overrides?.mount) {
      const at = args.indexOf("--mount");
      args[at + 1] = overrides.mount;
    }
    if (overrides?.trailing) args.push(overrides.trailing);
    return args;
  }

  it("accepts separate and inline WireGuard capability and device flags", () => {
    expect(() => assertSafeDockerArgs(wireguardRun(), profile)).not.toThrow();
    expect(() =>
      assertSafeDockerArgs(
        wireguardRun({
          cap: `--cap-add=${WIREGUARD_CAP}`,
          device: `--device=${WIREGUARD_DEVICE}`,
        }),
        profile,
      ),
    ).not.toThrow();
    const inlineSysctl = wireguardRun().flatMap((arg, index, all) => {
      if (arg === "--sysctl") return [`--sysctl=${all[index + 1] ?? ""}`];
      if (all[index - 1] === "--sysctl") return [];
      return [arg];
    });
    expect(() => assertSafeDockerArgs(inlineSysctl, profile)).not.toThrow();
  });

  it("rejects a missing capability value and any capability other than NET_ADMIN", () => {
    expect(() => assertSafeDockerArgs(["--cap-add"], profile)).toThrow(/added capability/);
    expect(() => assertSafeDockerArgs(["--device"], profile)).toThrow(/host device/);
    expect(() => assertSafeDockerArgs(wireguardRun({ trailing: "--cap-add" }), profile)).toThrow(
      PayloadRejected,
    );
    expect(() =>
      assertSafeDockerArgs(wireguardRun({ cap: "--cap-add=SYS_ADMIN" }), profile),
    ).toThrow(/added capability/);
    expect(() =>
      assertSafeDockerArgs(wireguardRun({ device: "--device=/dev/sda" }), profile),
    ).toThrow(/host device/);
    expect(() => assertSafeDockerArgs(wireguardRun({ cap: `--cap-add=${WIREGUARD_CAP}` }))).toThrow(
      /added capability/,
    );
  });

  it("allows a WireGuard config mount only at /etc/wireguard", () => {
    expect(() =>
      assertSafeDockerArgs(
        wireguardRun({
          mount: `type=volume,source=wg-easy,target=${WIREGUARD_CONFIG_MOUNT}`,
        }),
        profile,
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeDockerArgs(
        wireguardRun({
          mount: `type=volume,source=wg-easy,dst=${WIREGUARD_CONFIG_MOUNT}`,
        }),
        profile,
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeDockerArgs(
        wireguardRun({ mount: "type=volume,source=wg-easy,destination=/etc/passwd" }),
        profile,
      ),
    ).toThrow(/host mount/);
    expect(() =>
      assertSafeDockerArgs(
        wireguardRun({ mount: "type=volume,source=wg-easy,target=/etc/passwd" }),
        profile,
      ),
    ).toThrow(/host mount/);
    expect(() =>
      assertSafeDockerArgs(
        wireguardRun({
          mount: `type=volume,source=wg-easy,destination=${WIREGUARD_CONFIG_MOUNT},target=/etc/passwd`,
        }),
        profile,
      ),
    ).toThrow(/host mount/);
    expect(() =>
      assertSafeDockerArgs(
        wireguardRun({
          mount: `type=volume,source=wg-easy,destination=${WIREGUARD_CONFIG_MOUNT}`,
        }),
      ),
    ).toThrow(/host mount/);
  });

  it("lets the process client run WireGuard only when told the profile", async () => {
    const client = createProcessDockerClient({
      socketPath: "/var/run/docker.sock",
      bin: "/usr/bin/true",
    });
    const args = wireguardRun();
    await expect(client.run(args)).rejects.toThrow(/Docker arguments rejected/);
    await expect(
      client.run(args, { runtimeProfile: WIREGUARD_ENDPOINT_PROFILE }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});
