import type { PersonalBuildSpec } from "./git-build.ts";
export type PersonalBuildReport = Omit<PersonalBuildSpec, "kind" | "source" | "artifact"> & {
  kind: "personal-docker-build-report";
  source: Pick<PersonalBuildSpec["source"], "resolvedCommit" | "contextDirectory">;
  artifact: { localImageConfigDigest: string; ociManifestReference: null };
};
function object(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k)) ? r : null;
}
const text = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const names = (v: unknown) =>
  Array.isArray(v) && v.length <= 64 && v.every((n) => text(n, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/));
/** Only bounded metadata survives the outbox. Invalid diagnostics never invalidate a command receipt. */
export function parseBuildReport(value: unknown): PersonalBuildReport | null {
  const r = object(value, [
    "schemaVersion",
    "kind",
    "source",
    "builder",
    "target",
    "inputs",
    "artifact",
    "logs",
  ]);
  if (!r || r.schemaVersion !== 1 || r.kind !== "personal-docker-build-report") return null;
  const s = object(r.source, ["resolvedCommit", "contextDirectory"]);
  const b = object(r.builder, [
    "requestedStrategy",
    "actualStrategy",
    "dockerfile",
    "dockerfileSha256",
  ]);
  const t = object(r.target, ["platform", "runtimePort"]);
  const i = object(r.inputs, ["permittedBuildArgumentNames", "buildSecretNames", "privateSource"]);
  const a = object(r.artifact, ["localImageConfigDigest", "ociManifestReference"]);
  const l = object(r.logs, ["commandId"]);
  if (
    !s ||
    !b ||
    !t ||
    !i ||
    !a ||
    !l ||
    !(s.resolvedCommit === null || text(s.resolvedCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)) ||
    !text(s.contextDirectory, /^(?:\.|[A-Za-z0-9._/-]{1,128})$/) ||
    (s.contextDirectory as string).includes("..") ||
    !["nixpacks", "railpack", "static", "dockerfile"].includes(b.requestedStrategy as string) ||
    !text(b.dockerfileSha256, /^[a-f0-9]{64}$/) ||
    !(
      (b.actualStrategy === "repository_dockerfile" &&
        typeof b.dockerfile === "string" &&
        b.dockerfile.toLowerCase() === "dockerfile") ||
      (b.actualStrategy === "generated_dockerfile" &&
        b.dockerfile === "pm.Dockerfile" &&
        b.requestedStrategy !== "dockerfile")
    ) ||
    !["linux/arm64", "linux/amd64"].includes(t.platform as string) ||
    typeof t.runtimePort !== "number" ||
    !Number.isInteger(t.runtimePort) ||
    t.runtimePort < 1 ||
    t.runtimePort > 65535 ||
    !names(i.permittedBuildArgumentNames) ||
    !names(i.buildSecretNames) ||
    typeof i.privateSource !== "boolean" ||
    !text(a.localImageConfigDigest, /^sha256:[a-f0-9]{64}$/) ||
    a.ociManifestReference !== null ||
    !text(l.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  )
    return null;
  if (new TextEncoder().encode(JSON.stringify(r)).length > 12000) return null;
  return structuredClone(r) as PersonalBuildReport;
}
export function buildReportFromSpec(spec: PersonalBuildSpec): PersonalBuildReport | null {
  return parseBuildReport({
    schemaVersion: spec.schemaVersion,
    kind: "personal-docker-build-report",
    source: {
      resolvedCommit: spec.source.resolvedCommit,
      contextDirectory: spec.source.contextDirectory,
    },
    builder: spec.builder,
    target: spec.target,
    inputs: spec.inputs,
    artifact: spec.artifact,
    logs: spec.logs,
  });
}
