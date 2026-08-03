#!/usr/bin/env node
/**
 * Build script for npm package publication.
 * Bundles src/index.ts into dist/cli.cjs with executable shebang banner.
 */
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(__dirname, "..");
const distDir = resolve(agentRoot, "dist");
const require = createRequire(import.meta.url);

const pkgJson = JSON.parse(await readFile(resolve(agentRoot, "package.json"), "utf8"));
const version = String(pkgJson.version || "0.0.0");
const buildDate = new Date().toISOString();

async function main() {
  console.log(`Building projectmind-agent v${version} for npm…`);
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const esbuild = require("esbuild");
  const outFile = resolve(distDir, "cli.js");

  await esbuild.build({
    entryPoints: [resolve(agentRoot, "src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: outFile,
    banner: {
      js: "#!/usr/bin/env node\n",
    },
    external: ["@cursor/sdk"],
    define: {
      "process.env.IMEMORY_AGENT_EMBEDDED_VERSION": JSON.stringify(version),
      "process.env.IMEMORY_AGENT_EMBEDDED_BUILD_DATE": JSON.stringify(buildDate),
    },
    logLevel: "info",
  });

  await chmod(outFile, 0o755);
  console.log(`Successfully built ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
