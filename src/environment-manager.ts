/**
 * EnvironmentManager — the PREPARING_ENVIRONMENT step between a ready workspace
 * and the runner invocation.
 *
 * First implementation on purpose stays minimal and read-only: it detects the
 * project type for logging/future use and does not install dependencies, does
 * not run any repository script, and does not touch Docker. Nothing here can
 * make an otherwise-passing job fail — detection failures are swallowed into
 * `detail`, matching the same "never block on best-effort diagnostics" pattern
 * used throughout jobs.ts (git meta, visual capture, etc.).
 *
 * Future scope (not implemented here): installing/restoring dependency caches,
 * preparing env vars from an explicit project configuration, checking Docker
 * availability, starting required services. Any of that must be driven by an
 * explicit, safe project configuration — never by executing arbitrary scripts
 * found in the repository.
 */
import fs from "node:fs";
import path from "node:path";

export type ProjectRuntimeKind = "node" | "python" | "rust" | "go" | "ruby" | "unknown";

export type PreparedEnvironment = {
  ok: true;
  detectedKinds: ProjectRuntimeKind[];
  detail: string;
};

export type PrepareEnvironmentInput = {
  cwd: string;
  onLog?: (line: string) => void;
};

function detectProjectKinds(cwd: string): ProjectRuntimeKind[] {
  const markers: Array<[string, ProjectRuntimeKind]> = [
    ["package.json", "node"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["Gemfile", "ruby"],
  ];
  const found: ProjectRuntimeKind[] = [];
  for (const [file, kind] of markers) {
    try {
      if (fs.existsSync(path.join(cwd, file)) && !found.includes(kind)) {
        found.push(kind);
      }
    } catch {
      // Best-effort detection only — an unreadable marker is not a failure.
    }
  }
  return found.length > 0 ? found : ["unknown"];
}

/**
 * Always succeeds today (there is nothing here yet that can fail a job) but
 * returns a result type, not void, so a future check (e.g. "Docker required
 * but unavailable") can fail the attempt without changing every call site.
 */
export async function prepareEnvironment(
  input: PrepareEnvironmentInput,
): Promise<PreparedEnvironment> {
  const detectedKinds = detectProjectKinds(input.cwd);
  const detail = `Detected project type(s): ${detectedKinds.join(", ")}`;
  input.onLog?.(detail);
  return { ok: true, detectedKinds, detail };
}
