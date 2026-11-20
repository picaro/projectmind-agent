import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { PayloadRejected } from "./validate.ts";

export type NodeInstall = { runner: string[]; install: string };
const reject = (message: string): never => {
  throw new PayloadRejected("invalid_input", message);
};

/** Resolve only declared, frozen inputs; never generate a dependency lock during deployment. */
export async function nodeBuildInputs(context: string, files: string[]): Promise<NodeInstall> {
  const manifestPath = path.join(context, "package.json");
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.size > 262144) reject("Use a regular package.json under 256 KiB.");
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    manifest = parsed as Record<string, unknown>;
  } catch {
    return reject("Generated Node builds require a valid package.json.");
  }
  let graph = manifest.workspaces !== undefined;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reject("Dependency fields in package.json must be objects.");
    }
    graph ||= Object.keys(value as object).length > 0;
  }
  const locks = [
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ].filter(([file]) => files.includes(file!));
  const managers = new Set(locks.map(([, manager]) => manager));
  if (managers.size > 1) reject("Found multiple package-manager lockfiles; keep one manager.");
  for (const [file] of locks) {
    const lock = await lstat(path.join(context, file!));
    if (!lock.isFile() || lock.size === 0) reject("Use a nonempty regular dependency lockfile.");
  }
  const declaration = manifest.packageManager;
  const exact =
    typeof declaration === "string"
      ? /^(npm|pnpm|yarn)@([0-9]+)\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+sha224\.[a-f0-9]{56})?$/.exec(
          declaration,
        )
      : null;
  if (declaration !== undefined && !exact)
    reject("packageManager must declare an exact npm, pnpm, or Yarn version.");
  const locked = locks[0]?.[1];
  if (exact && locked && exact[1] !== locked)
    reject("packageManager must match the dependency lockfile.");
  const manager = exact?.[1] ?? locked ?? "npm";
  if (!exact && (manager !== "npm" || manifest.devEngines !== undefined)) {
    reject("Declare an exact packageManager version for this generated build.");
  }
  if (!locked && (graph || manager !== "npm"))
    reject("Commit a matching dependency lockfile before deploying.");
  const runner = exact ? ["corepack", declaration as string] : ["npm"];
  const flags =
    manager === "npm"
      ? locked
        ? "ci"
        : "install"
      : manager === "pnpm" || exact?.[2] === "1"
        ? "install --frozen-lockfile"
        : "install --immutable";
  return { runner, install: `${runner.join(" ")} ${flags}` };
}
