import { describe, expect, it } from "vitest";
import { parseToolJson, toolText } from "./mcp-client.js";

describe("toolText", () => {
  it("joins text parts and stringifies non-text parts", () => {
    expect(
      toolText({
        content: [
          { type: "text", text: "hello" },
          { type: "image" },
          { type: "text", text: "" },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe('hello\n{"type":"image"}\n{"type":"text","text":""}\nworld');
  });

  it("returns an empty string when content is missing or empty", () => {
    expect(toolText({})).toBe("");
    expect(toolText({ content: [] })).toBe("");
  });
});

describe("parseToolJson", () => {
  it("parses a JSON payload", () => {
    expect(parseToolJson({ content: [{ type: "text", text: '{"ok":true}' }] })).toEqual({
      ok: true,
    });
  });

  it("throws the tool text when isError is set", () => {
    expect(() =>
      parseToolJson({ isError: true, content: [{ type: "text", text: "nope" }] }),
    ).toThrow("nope");
  });

  it("uses a fallback message when an error result has no text", () => {
    expect(() => parseToolJson({ isError: true, content: [] })).toThrow(
      "MCP tool returned an error",
    );
  });

  it("rejects non-JSON and keeps at most 400 characters of the body", () => {
    const text = `not-json ${"x".repeat(500)}`;
    expect(() => parseToolJson({ content: [{ type: "text", text }] })).toThrow(
      /Expected JSON from MCP tool/,
    );
    try {
      parseToolJson({ content: [{ type: "text", text }] });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.length).toBeLessThanOrEqual("Expected JSON from MCP tool, got: ".length + 400);
      expect((err as Error).message.endsWith("x".repeat(500))).toBe(false);
    }
  });
});
