import { describe, expect, it } from "vitest";
import {
  buildCliMcpConfigFileContents,
  buildCursorSdkMcpServers,
  mcpConfigCliArgs,
  appendCliMcpArgs,
} from "./projectmind-mcp.js";

describe("projectmind-mcp", () => {
  it("builds Cursor SDK HTTP MCP servers with a bearer header", () => {
    const servers = buildCursorSdkMcpServers({
      url: "https://projectm.dev/api/mcp",
      apiKey: "imk_test",
    });
    expect(servers.projectmind.type).toBe("http");
    expect(servers.projectmind.url).toBe("https://projectm.dev/api/mcp");
    expect(servers.projectmind.headers.Authorization).toBe("Bearer imk_test");
  });

  it("writes a CLI mcp-config JSON document", () => {
    const json = JSON.parse(
      buildCliMcpConfigFileContents({
        url: "http://localhost:8080/api/mcp",
        apiKey: "imk_test",
      }),
    );
    expect(json.mcpServers.projectmind.url).toBe("http://localhost:8080/api/mcp");
    expect(mcpConfigCliArgs("/tmp/mcp.json")).toEqual(["--mcp-config", "/tmp/mcp.json"]);
  });

  it("appends a temp --mcp-config file for CLI runners", () => {
    const args = appendCliMcpArgs(["-p"], {
      url: "http://localhost:8080/api/mcp",
      apiKey: "imk_test",
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("--mcp-config");
    expect(args[2]).toMatch(/mcp\.json$/);
  });
});
