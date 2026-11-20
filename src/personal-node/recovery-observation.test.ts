import { describe, expect, it, vi } from "vitest";
import fixture from "../../test-fixtures/hosting/docker-recovery-v1.json";
import { buildHeartbeat } from "./heartbeat.ts";
import { assertSafeDockerArgs, inspectDeploymentContainers } from "./docker.ts";
import {
  parseRecoveryContainerObservation as parse,
  RECOVERY_CONTAINER_OBSERVATION_FORMAT as format,
  sanitizeRecoveryObservation as sanitize,
} from "./runtime-observation.ts";
const id = fixture.receiptCommandId,
  config = `sha256:${"cd".repeat(32)}`,
  image = `registry.example.test/team/app@sha256:${"ab".repeat(32)}`;
const now = new Date(fixture.inspectedAt);
const projection = {
  status: "running",
  imageConfigDigest: config,
  imageReference: image,
  healthStatus: "healthy",
  recovery: fixture,
};
describe("fixed native recovery observations", () => {
  it("uses the typed container field names so docker never falls back to raw JSON", () => {
    // `.Id` is the JSON key, not the typed field. Docker retries the template against raw
    // JSON, where a container without a healthcheck has no `.State.Health` key and the
    // inspect fails. The agent then drops it, so no container status ever reaches the server.
    expect(format).toContain("{{json .ID}}");
    expect(format).not.toMatch(/\{\{[^}]*\.Id\b/);
  });
  it("matches the shared server fixture and preserves inspection time during heartbeat sanitization", () => {
    expect(sanitize(fixture)).toEqual(fixture);
    const report = parse(id, JSON.stringify(projection), now)!;
    expect(report.recovery).toEqual(fixture);
    const heartbeat = buildHeartbeat({
      dockerEnabled: true,
      socketReachable: true,
      arch: "amd64",
      interfaces: null,
      containers: [report],
    });
    expect(heartbeat.containers?.[0]?.recovery).toEqual(fixture);
    expect(heartbeat.capabilities.nativeRecoveryObservations).toBe(true);
    expect(
      buildHeartbeat({
        dockerEnabled: false,
        socketReachable: false,
        arch: "amd64",
        containers: [report],
      }).containers,
    ).toBeUndefined();
  });
  it("permits only the fixed projection and the one required command receipt label", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(projection),
      stderr: "",
    }));
    expect(
      (await inspectDeploymentContainers({ run }, [id], { recovery: true }))[0]?.recovery
        ?.restartPolicy,
    ).toBe("no");
    expect(run).toHaveBeenCalledWith(["inspect", "--format", format, `pn-${id}`]);
    expect(() => assertSafeDockerArgs(["inspect", "--format", format, `pn-${id}`])).not.toThrow();
    for (const forbidden of [
      "{{json .Config.Env}}",
      "{{json .Config.Labels}}",
      "{{json .Mounts}}",
      format.replace("io.projectmind.deploy-command", "secret-label"),
    ])
      expect(() => assertSafeDockerArgs(["inspect", "--format", forbidden, `pn-${id}`])).toThrow();
  });
  it.each([
    { restartPolicy: "unknown" },
    { restartCount: -1 },
    { maximumRetryCount: 3 },
    { receiptCommandId: "missing" },
    { inspectedAt: "yesterday" },
    { token: "private" },
  ])("does not infer no policy from malformed metadata %j", (patch) =>
    expect(sanitize({ ...fixture, ...patch })).toBeNull(),
  );
  it("keeps base evidence but drops unknown or secret-bearing recovery fields", () => {
    const report = parse(
      id,
      JSON.stringify({
        ...projection,
        recovery: { ...fixture, token: "private-value" },
        environment: "private-value",
      }),
      now,
    )!;
    expect(report).toMatchObject({ imageReference: image, healthStatus: "healthy" });
    expect(report.recovery).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("private-value");
  });
  it.each(["always", "unless-stopped", "on-failure"] as const)(
    "preserves provider-owned %s policy",
    (restartPolicy) =>
      expect(sanitize({ ...fixture, restartPolicy })?.restartPolicy).toBe(restartPolicy),
  );
  it("does not trust restart metadata from transitional lifecycle or mutable images", () => {
    for (const status of ["created", "paused", "restarting", "removing", "dead"])
      expect(parse(id, JSON.stringify({ ...projection, status }), now)?.recovery).toBeUndefined();
    expect(
      parse(id, JSON.stringify({ ...projection, imageReference: "app:latest" }), now)?.recovery,
    ).toBeUndefined();
    expect(parse(id, JSON.stringify(projection), new Date("invalid"))?.recovery).toBeUndefined();
  });
  it("retains the legacy projection path and rejects oversized or malformed JSON", () => {
    expect(parse(id, `running|${config}|${image}|healthy`, now)).toMatchObject({
      imageReference: image,
    });
    for (const output of ["{", "{" + "x".repeat(2048), "[]"])
      expect(parse(id, output, now)).toBeNull();
  });
});
