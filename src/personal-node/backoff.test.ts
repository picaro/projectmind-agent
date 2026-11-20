import { describe, expect, it } from "vitest";

import { backoffDelayMs } from "./loop.js";

describe("backoffDelayMs", () => {
  it("stays within a bounded delay and adds jitter", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(1000);
    expect(backoffDelayMs(1, () => 0.999)).toBe(1249);
    expect(backoffDelayMs(2, () => 0)).toBe(2000);
    expect(backoffDelayMs(20, () => 1)).toBe(30_000);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect(backoffDelayMs(attempt, () => 0.5)).toBeLessThanOrEqual(30_000);
      expect(backoffDelayMs(attempt, () => 0)).toBeGreaterThan(0);
    }
  });
});
