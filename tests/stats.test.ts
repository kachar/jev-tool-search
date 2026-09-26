import { describe, expect, it } from "vitest";
import { bootstrapMean, mean, pairedDifference, percentile, seededRandom } from "../src/stats";

describe("stats", () => {
  it("seeded random is deterministic and in [0, 1)", () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    const values = Array.from({ length: 100 }, () => a());
    expect(values).toEqual(Array.from({ length: 100 }, () => b()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("mean of nothing is 0", () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("percentile uses nearest rank and handles empty input", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 1)).toBe(5);
  });

  it("bootstrap interval brackets the mean and is reproducible", () => {
    const values = Array.from({ length: 200 }, (_, index) => (index % 4 === 0 ? 1 : 0));
    const summary = bootstrapMean(values, { samples: 500 });
    expect(summary.mean).toBe(0.25);
    expect(summary.low).toBeLessThan(0.25);
    expect(summary.high).toBeGreaterThan(0.25);
    expect(bootstrapMean(values, { samples: 500 })).toEqual(summary);
  });

  it("a constant sample has a zero-width interval", () => {
    expect(bootstrapMean([1, 1, 1])).toEqual({ mean: 1, low: 1, high: 1 });
  });

  it("paired difference resamples per query", () => {
    expect(pairedDifference([1, 1, 0], [0, 1, 0]).mean).toBeCloseTo(1 / 3);
    expect(() => pairedDifference([1], [1, 0])).toThrow("differ in length");
  });
});
