import { describe, expect, it } from "vitest";
import { cursorSdkCreateOptions } from "./cursor.js";

describe("cursorSdkCreateOptions", () => {
  it("omits mcpServers when delegation MCP is not provided", () => {
    const options = cursorSdkCreateOptions({
      apiKey: "cursor-key",
      model: "composer-2.5",
      cwd: "/tmp/ws",
    });
    expect(options.mcpServers).toBeUndefined();
    expect(options.local).toEqual({ cwd: "/tmp/ws" });
  });

  it("passes ProjectMind HTTP MCP when delegation is allowed", () => {
    const options = cursorSdkCreateOptions({
      apiKey: "cursor-key",
      model: "composer-2.5",
      cwd: "/tmp/ws",
      mcp: { url: "https://projectm.dev/api/mcp", apiKey: "imk_test" },
    });
    expect(options.mcpServers).toEqual({
      projectmind: {
        type: "http",
        url: "https://projectm.dev/api/mcp",
        headers: { Authorization: "Bearer imk_test" },
      },
    });
  });
});
