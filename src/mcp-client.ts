import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAgentVersion } from "./agent-version.js";

export async function connectMcpClient(mcpUrl: URL, apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });

  const client = new Client({
    name: "projectmind-agent",
    version: getAgentVersion(),
  });

  await client.connect(transport);
  return client;
}

export function toolText(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): string {
  return (
    result.content
      ?.map((part) => ("text" in part && part.text ? part.text : JSON.stringify(part)))
      .join("\n") || ""
  );
}

export function parseToolJson<T>(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): T {
  if ("isError" in result && result.isError) {
    throw new Error(toolText(result) || "MCP tool returned an error");
  }
  const text = toolText(result);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from MCP tool, got: ${text.slice(0, 400)}`);
  }
}

export async function callToolJson<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  return parseToolJson<T>(
    result as { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  );
}
