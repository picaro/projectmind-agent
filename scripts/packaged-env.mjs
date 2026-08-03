/**
 * Sample .env shipped inside desktop agent download zips.
 * Points at the production ProjectMind app URL with placeholder credentials.
 */
import { copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PACKAGE_ENV_SOURCE = ".env.package";
export const PRODUCTION_MCP_URL = "https://projectm.dev/api/mcp";

/**
 * Copy the package sample env into a release stage as both `.env` and `.env.example`.
 * Download users can edit `.env` immediately; `.env.example` remains as a backup template.
 */
export async function writePackagedEnvFiles(stageDir, agentRoot) {
  const src = resolve(agentRoot, PACKAGE_ENV_SOURCE);
  const body = await readFile(src, "utf8");
  if (!body.includes(PRODUCTION_MCP_URL)) {
    throw new Error(`${PACKAGE_ENV_SOURCE} must set IMEMORY_MCP_URL to ${PRODUCTION_MCP_URL}`);
  }
  if (!body.includes("IMEMORY_API_KEY=")) {
    throw new Error(`${PACKAGE_ENV_SOURCE} must include sample IMEMORY_API_KEY`);
  }
  await copyFile(src, join(stageDir, ".env"));
  await copyFile(src, join(stageDir, ".env.example"));
  return body;
}
