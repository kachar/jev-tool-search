import type { MetricSummary } from "./types";

// Percentile bootstrap over queries, seeded so a rerun of the same results prints the same
// intervals. Paired: a difference is resampled query by query, so both retrievers see the same draw.

export const BOOTSTRAP_SAMPLES = 2000;
export const CONFIDENCE = 0.95;
const DEFAULT_SEED = 42;

/** mulberry32: a tiny deterministic PRNG in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Nearest-rank percentile, p in [0, 1]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export function bootstrapMean(
  values: number[],
  { samples = BOOTSTRAP_SAMPLES, seed = DEFAULT_SEED } = {}
): MetricSummary {
  const random = seededRandom(seed);
  const means = Array.from({ length: samples }, () =>
    mean(values.map(() => values[Math.floor(random() * values.length)]!))
  );
  const tail = (1 - CONFIDENCE) / 2;
  return { mean: mean(values), low: percentile(means, tail), high: percentile(means, 1 - tail) };
}

/** Paired bootstrap of mean(a - b); both arrays are per-query scores in the same query order. */
export function pairedDifference(a: number[], b: number[], options = {}): MetricSummary {
  if (a.length !== b.length) {
    throw new Error(`paired samples differ in length: ${a.length} vs ${b.length}`);
  }
  return bootstrapMean(
    a.map((value, index) => value - b[index]!),
    options
  );
}
