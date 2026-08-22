import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProjectMindMcpConfig = {
  url: string;
  apiKey: string;
};

export type CursorSdkMcpServers = {
  projectmind: {
    type: "http";
    url: string;
    headers: { Authorization: string };
  };
};

export function buildCursorSdkMcpServers(config: ProjectMindMcpConfig): CursorSdkMcpServers {
  return {
    projectmind: {
      type: "http",
      url: config.url,
      headers: { Authorization: `Bearer ${config.apiKey}` },
    },
  };
}

export function buildCliMcpConfigFileContents(config: ProjectMindMcpConfig): string {
  return JSON.stringify(
    {
      mcpServers: {
        projectmind: {
          type: "http",
          url: config.url,
          headers: { Authorization: `Bearer ${config.apiKey}` },
        },
      },
    },
    null,
    2,
  );
}

export function mcpConfigCliArgs(configPath: string): string[] {
  return ["--mcp-config", configPath];
}

export function writeTempMcpConfigFile(config: ProjectMindMcpConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, buildCliMcpConfigFileContents(config), { encoding: "utf8", mode: 0o600 });
  return path;
}

export function appendCliMcpArgs(args: string[], mcp?: ProjectMindMcpConfig | null): string[] {
  if (!mcp?.url || !mcp.apiKey) return args;
  return [...args, ...mcpConfigCliArgs(writeTempMcpConfigFile(mcp))];
}
