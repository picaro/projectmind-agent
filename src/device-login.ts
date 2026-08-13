/**
 * Device-code login: open browser, poll for API key, write IMEMORY_API_KEY to .env.
 */
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { normalizeMcpBaseUrl } from "./machine.js";

const PRODUCTION_APP_ORIGIN = "https://projectm.dev";
const DEFAULT_MCP_URL = "https://projectm.dev/api/mcp";

export type DeviceLoginResult = {
  success: boolean;
  apiKey?: string;
  projectSlug?: string | null;
  envPath: string;
};

function openBrowser(url: string) {
  const platform = process.platform;
  if (platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  else if (platform === "win32")
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

function originFromMcpUrl(mcpUrl: string): string {
  return new URL(normalizeMcpBaseUrl(mcpUrl)).origin;
}

function upsertEnvVar(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  const trimmed = content.replace(/\s*$/, "");
  return `${trimmed}${trimmed ? "\n" : ""}${line}\n`;
}

async function readEnvFile(envPath: string): Promise<string> {
  try {
    await access(envPath, fsConstants.F_OK);
    return await readFile(envPath, "utf8");
  } catch {
    return "";
  }
}

export async function runDeviceLogin(input: {
  envPath: string;
  mcpUrl?: string;
  appOrigin?: string;
  timeoutMs?: number;
}): Promise<DeviceLoginResult> {
  const mcpUrl = normalizeMcpBaseUrl(input.mcpUrl?.trim() || DEFAULT_MCP_URL);
  const appOrigin = (input.appOrigin?.trim() || originFromMcpUrl(mcpUrl)).replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║       ProjectMind Agent - Browser Login                  ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  const startRes = await fetch(`${appOrigin}/api/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: "mac_agent" }),
  });
  const startBody = (await startRes.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!startRes.ok || !startBody.device_code || !startBody.user_code) {
    console.error(
      `\n❌ ${startBody.error_description || startBody.error || "Failed to start device login"}`,
    );
    return { success: false, envPath: input.envPath };
  }

  const verifyUrl =
    startBody.verification_uri_complete ||
    `${startBody.verification_uri}?user_code=${encodeURIComponent(startBody.user_code)}`;

  console.log(`Your code:  ${startBody.user_code}`);
  console.log(`Open:       ${verifyUrl}\n`);
  openBrowser(verifyUrl);

  const deadline = Date.now() + timeoutMs;
  let intervalMs = Math.max(2, startBody.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tokenRes = await fetch(`${appOrigin}/api/oauth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: startBody.device_code,
      }),
    });
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      project_slug?: string | null;
      error?: string;
      interval?: number;
      error_description?: string;
    };

    if (tokenRes.ok && tokenBody.access_token) {
      let content = await readEnvFile(input.envPath);
      content = upsertEnvVar(content, "IMEMORY_API_KEY", tokenBody.access_token);
      content = upsertEnvVar(content, "IMEMORY_MCP_URL", mcpUrl);
      if (tokenBody.project_slug) {
        content = upsertEnvVar(content, "IMEMORY_PROJECT_SLUG", tokenBody.project_slug);
      }
      if (!content.includes("IMEMORY_WORKSPACE_ALLOWLIST=")) {
        content = upsertEnvVar(content, "IMEMORY_WORKSPACE_ALLOWLIST", process.cwd());
      }
      await writeFile(input.envPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");

      console.log(`\n✓ Logged in. Wrote API key to ${input.envPath}`);
      if (tokenBody.project_slug) console.log(`  Project: ${tokenBody.project_slug}`);
      console.log("  Run 'projectmind-agent setup' if you still need to configure runners.\n");
      return {
        success: true,
        apiKey: tokenBody.access_token,
        projectSlug: tokenBody.project_slug ?? null,
        envPath: input.envPath,
      };
    }

    if (tokenBody.error === "slow_down" && tokenBody.interval) {
      intervalMs = Math.max(intervalMs, tokenBody.interval * 1000);
      continue;
    }
    if (tokenBody.error === "authorization_pending") continue;
    if (tokenBody.error === "access_denied") {
      console.error("\n❌ Authorization denied in the browser.\n");
      return { success: false, envPath: input.envPath };
    }
    if (tokenBody.error === "expired_token") {
      console.error("\n❌ Device code expired. Run login again.\n");
      return { success: false, envPath: input.envPath };
    }
    console.error(
      `\n❌ ${tokenBody.error_description || tokenBody.error || "Login failed"}\n`,
    );
    return { success: false, envPath: input.envPath };
  }

  console.error("\n❌ Login timed out.\n");
  return { success: false, envPath: input.envPath };
}

export { PRODUCTION_APP_ORIGIN };
