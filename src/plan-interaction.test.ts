import { describe, expect, it } from "vitest";
import { extractInteractionFromText } from "./plan-interaction.js";

describe("extractInteractionFromText", () => {
  it("parses plan JSON", () => {
    expect(
      extractInteractionFromText(
        '```json\n{"type":"plan","summary":"Add UI","steps":["edit agents"]}\n```',
      ),
    ).toEqual({
      type: "plan",
      summary: "Add UI",
      steps: ["edit agents"],
    });
  });

  it("falls back to prose plan", () => {
    const text = "First update the job status enum, then add Agents page approval cards for plans.";
    const parsed = extractInteractionFromText(text);
    expect(parsed?.type).toBe("plan");
  });

  it("returns null for blank text, short prose, and unusable JSON", () => {
    expect(extractInteractionFromText("")).toBeNull();
    expect(extractInteractionFromText("   ")).toBeNull();
    expect(extractInteractionFromText("x".repeat(39))).toBeNull();
    expect(extractInteractionFromText("[]")).toBeNull();
    expect(extractInteractionFromText('{"type":"other"}')).toBeNull();
    expect(extractInteractionFromText('{"type":"plan","summary":"","steps":[]}')).toBeNull();
    expect(extractInteractionFromText('{"type":"questions","questions":[]}')).toBeNull();
  });

  it("treats prose of exactly 40 characters as a plan fallback", () => {
    const text = "x".repeat(40);
    expect(extractInteractionFromText(text)).toEqual({
      type: "plan",
      summary: text,
      steps: [text],
    });
  });

  it("parses questions, fills ids, and drops blank prompts and options", () => {
    expect(
      extractInteractionFromText(
        JSON.stringify({
          type: "questions",
          questions: [
            { text: "  Ship it?  ", options: [" yes ", "", 1] },
            { prompt: "   " },
            "nope",
          ],
        }),
      ),
    ).toEqual({
      type: "questions",
      questions: [{ id: "q1", prompt: "Ship it?", options: ["yes"] }],
    });
  });

  it("keeps a plan that has only a summary or only steps", () => {
    expect(extractInteractionFromText('{"type":"plan","summary":"Add UI","steps":[1,"  "]}')).toEqual({
      type: "plan",
      summary: "Add UI",
      steps: [],
    });
    expect(extractInteractionFromText('{"type":"plan","steps":[" first "]}')).toEqual({
      type: "plan",
      summary: "first",
      steps: ["first"],
    });
  });

  it("uses a later JSON object when the fenced block does not parse", () => {
    const text = '```json\nnot json\n```\n{"type":"plan","summary":"From braces","steps":["go"]}';
    expect(extractInteractionFromText(text)?.type).toBe("plan");
    expect(extractInteractionFromText(text)).toMatchObject({ summary: "From braces" });
  });

  it("prefers the first fenced payload when it parses", () => {
    const text =
      '```json\n{"type":"plan","summary":"First","steps":["a"]}\n```\n{"type":"plan","summary":"Second","steps":["b"]}';
    expect(extractInteractionFromText(text)).toMatchObject({ summary: "First" });
  });
});
