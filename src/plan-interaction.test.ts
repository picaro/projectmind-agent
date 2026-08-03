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
});
