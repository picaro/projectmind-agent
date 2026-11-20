#!/usr/bin/env node
/**
 * Standalone ESM bundle of the personal-node runtime (`node personal-node.mjs run`).
 * ProjectMind serves this file at /personal-node/agent.mjs for computers paired
 * before the node moved into projectmind-agent.
 *
 * `personalNodeBuildStamp()` is also used by build-npm.mjs so both bundles report
 * the same version to the control plane.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(agentRoot, "src/personal-node");
const require = createRequire(import.meta.url);

/** `<package version>+<8 hex of the node sources>`; changes only when the node code does. */
export function personalNodeBuildStamp() {
  const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8"));
  const hash = createHash("sha256");
  const files = readdirSync(sourceDir)
    .filter((name) => !name.endsWith(".test.ts"))
    .sort();
  for (const name of files) {
    hash.update(name).update("\0").update(readFileSync(join(sourceDir, name))).update("\0");
  }
  return `${String(pkg.version || "0.0.0")}+${hash.digest("hex").slice(0, 8)}`;
}

export async function buildPersonalNodeBundle(outfile = join(agentRoot, "dist/personal-node.mjs")) {
  const esbuild = require("esbuild");
  await esbuild.build({
    entryPoints: [join(sourceDir, "bin.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    legalComments: "none",
    banner: {
      js: "// projectmind-agent personal-node runtime (pair, heartbeat, run). Built by scripts/build-personal-node.mjs",
    },
    define: { __PERSONAL_NODE_AGENT_BUILD__: JSON.stringify(personalNodeBuildStamp()) },
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf("--outfile");
  const outfile = flag >= 0 ? resolve(process.argv[flag + 1]) : undefined;
  const written = await buildPersonalNodeBundle(outfile);
  console.log(`Built ${written} (${personalNodeBuildStamp()})`);
}
