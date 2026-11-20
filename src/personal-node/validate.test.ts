import { describe, expect, it } from "vitest";

import { createValidatingExecutor } from "./executor.js";
import { PayloadRejected, validateCommand } from "./validate.js";
import { isPinnedManifestReference } from "./image-reference.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;

function deploy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageDigest: DIGEST,
    declaredPlatform: "linux/amd64",
    containerPort: 8080,
    environmentSecretRef: "hosting-env:550e8400-e29b-41d4-a716-446655440000:runtime",
    volumeSpecs: [{ name: "data" }],
    ...overrides,
  };
}

describe("validateCommand", () => {
  it("accepts a complete pinned registry address without allowing a second git source", () => {
    const pinned = `registry.example.test/team/app@${DIGEST}`;
    expect(isPinnedManifestReference(pinned)).toBe(true);
    expect(() =>
      validateCommand({ type: "deploy", payload: deploy({ imageDigest: pinned }) }, "amd64"),
    ).not.toThrow();
    expect(() =>
      validateCommand(
        {
          type: "deploy",
          payload: deploy({
            imageDigest: pinned,
            gitBuild: {
              repositoryUrl: "https://github.com/acme/app",
              ref: "main",
              buildPack: "dockerfile",
              baseDirectory: ".",
            },
          }),
        },
        "amd64",
      ),
    ).toThrow(/git build does not include an image digest/);
  });

  it.each([
    "registry.example.test/team/app:latest",
    `https://registry.example.test/team/app@${DIGEST}`,
    `user:secret@registry.example.test/team/app@${DIGEST}`,
    `127.0.0.1/team/app@${DIGEST}`,
    `0x7f.0.0.1/team/app@${DIGEST}`,
    `host.localhost/team/app@${DIGEST}`,
    `registry.example.test:65536/team/app@${DIGEST}`,
    `registry.example.test/team/app@${DIGEST};id`,
  ])("rejects an unsafe or mutable registry execution reference: %s", (reference) => {
    expect(isPinnedManifestReference(reference)).toBe(false);
    expect(() =>
      validateCommand({ type: "deploy", payload: deploy({ imageDigest: reference }) }, "amd64"),
    ).toThrow();
  });

  it("accepts a git build and ignores a Coolify local tag", () => {
    const localImage = "ndps8jrcoxv49lfiirvwcorq:50d2881";
    expect(() =>
      validateCommand(
        {
          type: "deploy",
          payload: deploy({
            imageDigest: localImage,
            gitBuild: {
              repositoryUrl: "https://github.com/acme/demo",
              ref: "50d2881",
              buildPack: "nixpacks",
              baseDirectory: ".",
            },
          }),
        },
        "amd64",
      ),
    ).not.toThrow();
    expect(() =>
      validateCommand(
        {
          type: "deploy",
          payload: deploy({
            imageDigest: DIGEST,
            gitBuild: {
              repositoryUrl: "https://github.com/acme/demo",
              ref: "50d2881",
              buildPack: "nixpacks",
              baseDirectory: ".",
            },
          }),
        },
        "amd64",
      ),
    ).toThrow(/does not include an image digest/);
  });

  it("rejects a tag reference", () => {
    expect(() =>
      validateCommand(
        { type: "deploy", payload: deploy({ imageDigest: "nginx:latest" }) },
        "amd64",
      ),
    ).toThrow(PayloadRejected);
    expect(() =>
      validateCommand(
        { type: "deploy", payload: deploy({ imageDigest: "ghcr.io/org/app:latest" }) },
        "amd64",
      ),
    ).toThrow(/sha256 digest/);
  });

  it("accepts a deploy with no environment reference", () => {
    const payload = deploy();
    delete payload.environmentSecretRef;
    expect(() => validateCommand({ type: "deploy", payload }, "amd64")).not.toThrow();
  });

  it("rejects privileged", () => {
    expect(() =>
      validateCommand({ type: "deploy", payload: deploy({ privileged: true }) }, "amd64"),
    ).toThrow(/not allowed/);
  });

  it("rejects a host mount", () => {
    expect(() =>
      validateCommand({ type: "deploy", payload: deploy({ hostPath: "/var/lib/app" }) }, "amd64"),
    ).toThrow(/not allowed/);
    expect(() =>
      validateCommand(
        { type: "deploy", payload: deploy({ volumeSpecs: [{ name: "data", source: "/tmp" }] }) },
        "amd64",
      ),
    ).toThrow(/named volumes/);
  });

  it("rejects docker.sock", () => {
    expect(() =>
      validateCommand(
        { type: "deploy", payload: deploy({ note: "/var/run/docker.sock" }) },
        "amd64",
      ),
    ).toThrow(/docker\.sock/);
  });

  it("accepts a sha256 digest whose declared platform matches the node", () => {
    expect(() => validateCommand({ type: "deploy", payload: deploy() }, "amd64")).not.toThrow();
  });

  it("rejects an architecture mismatch and a shell string", () => {
    expect(() =>
      validateCommand(
        { type: "deploy", payload: deploy({ declaredPlatform: "linux/arm64" }) },
        "amd64",
      ),
    ).toThrow(/arch_mismatch|needs linux\/amd64/);
    expect(() =>
      validateCommand({ type: "deploy", payload: deploy({ command: "sh -c id" }) }, "amd64"),
    ).toThrow(/not allowed/);
  });
});

describe("createValidatingExecutor", () => {
  it("rejects a malicious outbound route payload and accepts loopback only", async () => {
    const good = {
      commandId: "00000000-0000-4000-8000-0000000000c1",
      deploymentId: "00000000-0000-4000-8000-0000000000e1",
      revision: "rev-1",
      hostname: "owner-a-00000000.apps-hosting.test",
      containerPort: 3000,
      ingress: {
        mode: "outbound",
        provider: "local_dev",
        localAddress: "127.0.0.1",
        localPort: 3000,
        tunnelRef: null,
      },
    };
    expect(() => validateCommand({ type: "apply_route", payload: good }, "arm64")).not.toThrow();
    expect(() =>
      validateCommand(
        {
          type: "apply_route",
          payload: {
            ...good,
            containerPort: 3000,
            hostPort: 21000,
            ingress: { ...good.ingress, localPort: 21000 },
          },
        },
        "arm64",
      ),
    ).not.toThrow();
    expect(() =>
      validateCommand(
        {
          type: "apply_route",
          payload: {
            ...good,
            hostPort: 21000,
            ingress: { ...good.ingress, localPort: 3000 },
          },
        },
        "arm64",
      ),
    ).toThrow(/hostPort/);
    const result = await createValidatingExecutor("arm64").apply({
      id: good.commandId,
      deploymentId: good.deploymentId,
      type: "apply_route",
      payload: good,
    });
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("tunnel_not_configured");
    expect(result.publicUrl).toBeNull();
    expect(result.log).toMatch(/No listener was opened/);
    expect(() =>
      validateCommand(
        { type: "apply_route", payload: { ...good, hostHeader: "evil.example" } },
        "arm64",
      ),
    ).toThrow(/not allowed/);
    expect(() =>
      validateCommand(
        {
          type: "apply_route",
          payload: {
            ...good,
            ingress: { ...good.ingress, mode: "inbound" },
          },
        },
        "arm64",
      ),
    ).toThrow(/outbound/);
    expect(() =>
      validateCommand(
        {
          type: "apply_route",
          payload: { ...good, containerPort: "80\nHost: evil.example" },
        },
        "arm64",
      ),
    ).toThrow(/host-header|integer|not allowed/i);
  });

  it("returns applied without a public URL and does not claim a container started live", async () => {
    const result = await createValidatingExecutor("amd64").apply({
      id: "cmd-1",
      deploymentId: "550e8400-e29b-41d4-a716-446655440000",
      type: "deploy",
      payload: deploy(),
    });
    expect(result.outcome).toBe("applied");
    expect(result.publicUrl).toBeNull();
    expect(result.log).not.toMatch(/https?:\/\//);
    expect(result.log).not.toMatch(/\bLIVE\b/);
  });
});
