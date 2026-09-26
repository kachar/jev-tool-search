import { describe, expect, it } from "vitest";
import { hitAt, METRICS, ndcgAt, recallAt, reciprocalRank } from "../src/metrics";

describe("metrics", () => {
  const ranking = ["a", "b", "c", "d", "e", "f"];

  it("hit@k is 1 only when a relevant tool is in the top k", () => {
    expect(hitAt(ranking, ["b"], 1)).toBe(0);
    expect(hitAt(ranking, ["b"], 2)).toBe(1);
  });

  it("recall@k counts distinct relevant tools found", () => {
    expect(recallAt(ranking, ["a", "f"], 5)).toBe(0.5);
    expect(recallAt(["a", "a"], ["a", "z"], 5)).toBe(0.5);
  });

  it("reciprocal rank is 1/position of the first hit, 0 when missing", () => {
    expect(reciprocalRank(ranking, ["c", "e"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(ranking, ["z"])).toBe(0);
  });

  it("nDCG@k is 1 for a perfect ranking and discounts lower hits", () => {
    expect(ndcgAt(ranking, ["a", "b"], 5)).toBe(1);
    expect(ndcgAt(ranking, ["b"], 5)).toBeCloseTo(1 / Math.log2(3));
    expect(ndcgAt(ranking, ["z"], 5)).toBe(0);
  });

  it("MRR is cut at depth 20", () => {
    const deep = Array.from({ length: 30 }, (_, index) => `t${index}`);
    expect(METRICS.mrr(deep, ["t19"])).toBeCloseTo(1 / 20);
    expect(METRICS.mrr(deep, ["t20"])).toBe(0);
  });

  it("exposes hit@1, recall@5 and nDCG@5", () => {
    expect(METRICS.hit1(ranking, ["a"])).toBe(1);
    expect(METRICS.recall5(ranking, ["f"])).toBe(0);
    expect(METRICS.ndcg5(ranking, ["a"])).toBe(1);
  });
});
