import type { MetricName } from "./types";

// Binary-relevance IR metrics over one ranked list. `relevant` is the set of tool names that answer
// the query; a ranking that misses them all scores 0 everywhere.

export const CUTOFF = 5;
/** How deep a stored ranking goes; MRR is cut here, so it reads as MRR@20. */
export const RANK_DEPTH = 20;

export function hitAt(ranking: string[], relevant: string[], k: number): number {
  return ranking.slice(0, k).some((name) => relevant.includes(name)) ? 1 : 0;
}

export function recallAt(ranking: string[], relevant: string[], k: number): number {
  const found = ranking.slice(0, k).filter((name) => relevant.includes(name));
  return new Set(found).size / relevant.length;
}

export function reciprocalRank(ranking: string[], relevant: string[]): number {
  const index = ranking.findIndex((name) => relevant.includes(name));
  return index === -1 ? 0 : 1 / (index + 1);
}

const discount = (index: number) => 1 / Math.log2(index + 2);

export function ndcgAt(ranking: string[], relevant: string[], k: number): number {
  const dcg = ranking
    .slice(0, k)
    .reduce((sum, name, index) => sum + (relevant.includes(name) ? discount(index) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, relevant.length) }, (_, index) =>
    discount(index)
  ).reduce((sum, value) => sum + value, 0);
  return dcg / ideal;
}

export const METRICS: Record<MetricName, (ranking: string[], relevant: string[]) => number> = {
  hit1: (ranking, relevant) => hitAt(ranking, relevant, 1),
  recall5: (ranking, relevant) => recallAt(ranking, relevant, CUTOFF),
  mrr: (ranking, relevant) => reciprocalRank(ranking.slice(0, RANK_DEPTH), relevant),
  ndcg5: (ranking, relevant) => ndcgAt(ranking, relevant, CUTOFF),
};
