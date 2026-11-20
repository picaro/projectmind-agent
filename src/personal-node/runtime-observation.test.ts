import { describe, expect, it, vi } from "vitest";
import { assertSafeDockerArgs, inspectDeploymentContainers } from "./docker.js";
import { parseContainerObservation, sanitizeRuntimeObservation } from "./runtime-observation.js";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const CONFIG = `sha256:${"12".repeat(32)}`;
const REFERENCE = `registry.example.test/team/app@sha256:${"34".repeat(32)}`;

describe("owned-container runtime observations", () => {
  it("reports actual config identity separately from the immutable manifest and native health", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: `running|${CONFIG}|${REFERENCE}|healthy\n`,
      stderr: "",
    }));
    expect(await inspectDeploymentContainers({ run }, [ID, "not-an-owned-id"])).toEqual([
      {
        deploymentId: ID,
        status: "running",
        imageReference: REFERENCE,
        imageConfigDigest: CONFIG,
        healthStatus: "healthy",
      },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0] as unknown as [string[]];
    expect(args[0][3]).toBe(`pn-${ID}`);
    expect(args[0][2]).not.toMatch(/\.Env|\.Labels|\.Mounts|json/);
  });

  it("never makes running imply healthy or a mutable tag imply an immutable image", () => {
    for (const image of ["ghcr.io/team/app:latest", CONFIG, "secret-not-a-reference"]) {
      expect(parseContainerObservation(ID, `running|${CONFIG}|${image}|not_configured`)).toEqual({
        deploymentId: ID,
        status: "running",
        healthStatus: "not_configured",
      });
    }
    expect(parseContainerObservation(ID, `running|sha256:bad|${REFERENCE}|surprise`)).toEqual({
      deploymentId: ID,
      status: "running",
      healthStatus: "unknown",
    });
    expect(parseContainerObservation(ID, `exited|${CONFIG}|${REFERENCE}|unhealthy`)).toMatchObject({
      status: "exited",
      healthStatus: "unhealthy",
      imageConfigDigest: CONFIG,
    });
    expect(parseContainerObservation(ID, `exited|${CONFIG}|${REFERENCE}|healthy`)).toMatchObject({
      status: "exited",
      healthStatus: "unknown",
    });
  });

  it("omits malformed or unrecognized runtime data instead of inventing a status", () => {
    expect(sanitizeRuntimeObservation({ deploymentId: ID, status: ["running"] })).toBeNull();
    for (const output of [
      "running",
      "",
      "unknown|||healthy",
      "running|||healthy|extra",
      `running|${CONFIG}|${REFERENCE}|healthy\nsecret=value`,
      "x".repeat(1025),
    ]) {
      expect(parseContainerObservation(ID, output)).toBeNull();
    }
  });

  it("distinguishes missing containers from unreachable Docker and inspects at most 32 IDs", async () => {
    const missing = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: No such object",
    }));
    expect(await inspectDeploymentContainers({ run: missing }, [ID])).toEqual([
      { deploymentId: ID, status: "missing" },
    ]);
    const unavailable = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Cannot connect to Docker: dial unix docker.sock: no such file or directory",
    }));
    expect(await inspectDeploymentContainers({ run: unavailable }, Array(40).fill(ID))).toEqual([]);
    expect(unavailable).toHaveBeenCalledTimes(32);
  });

  it("rejects raw inspect JSON, environment projections, and other container names", () => {
    for (const args of [
      ["inspect", `pn-${ID}`],
      ["inspect", "--format", "{{json .Config.Env}}", `pn-${ID}`],
      ["inspect", "--format", "{{.State.Status}}", "unrelated-service"],
    ]) {
      expect(() => assertSafeDockerArgs(args)).toThrow("inspection projection");
    }
  });
});
