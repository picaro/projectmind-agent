import { describe, expect, it } from "vitest";
import { isClaudeUsageClose, parseClaudeUsageText } from "./claude-usage.js";

describe("claude-usage", () => {
  it("parses session and week usage percentages and reset times", () => {
    const raw =
      "You are currently using your subscription to power your Claude Code usage\n\n" +
      "Current session: 30% used · resets Jul 27 at 11pm (America/New_York)\n" +
      "Current week (all models): 4% used · resets Aug 1 at 5pm (America/New_York)\n\n" +
      "What's contributing to your limits usage?";

    const snapshot = parseClaudeUsageText(raw);

    expect(snapshot.sessionPercent).toBe(30);
    expect(snapshot.sessionResetsAt).toBe("Jul 27 at 11pm (America/New_York)");
    expect(snapshot.weekPercent).toBe(4);
    expect(snapshot.weekResetsAt).toBe("Aug 1 at 5pm (America/New_York)");
    expect(snapshot.note).toBe(
      "Session: 30% used (resets Jul 27 at 11pm (America/New_York)) · " +
        "Week: 4% used (resets Aug 1 at 5pm (America/New_York))",
    );
  });

  it("falls back to a truncated raw note when the shape is unrecognized", () => {
    const snapshot = parseClaudeUsageText("Some unexpected usage output");
    expect(snapshot.sessionPercent).toBeNull();
    expect(snapshot.weekPercent).toBeNull();
    expect(snapshot.note).toBe("Some unexpected usage output");
  });

  it("flags usage as close when either session or week crosses the threshold", () => {
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 95, sessionResetsAt: null, weekPercent: 10, weekResetsAt: null },
        90,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 10, sessionResetsAt: null, weekPercent: 95, weekResetsAt: null },
        90,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 10, sessionResetsAt: null, weekPercent: 20, weekResetsAt: null },
        90,
      ),
    ).toBe(false);
    expect(isClaudeUsageClose(null, 90)).toBe(false);
  });
});
