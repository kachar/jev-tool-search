import { METRICS } from "./metrics";
import { bootstrapMean, pairedDifference, percentile } from "./stats";
import type { MetricName, MetricSummary, QueryResult, Retriever, RetrieverSummary } from "./types";

const METRIC_NAMES = Object.keys(METRICS) as MetricName[];
const QUERIES_PER_COST_UNIT = 1000;

const scores = (results: QueryResult[], metric: MetricName) =>
  results.map(({ ranking, relevant }) => METRICS[metric](ranking, relevant));

const byQuery = (results: QueryResult[]) =>
  [...results].sort((a, b) => a.queryId.localeCompare(b.queryId));

/** One row per retriever and catalog size, in the order the retrievers were given. */
export function summarize(results: QueryResult[], retrievers: Retriever[]): RetrieverSummary[] {
  const sizes = [...new Set(results.map(({ catalogSize }) => catalogSize))].sort((a, b) => a - b);
  return sizes.flatMap((catalogSize) =>
    retrievers.flatMap(({ id, label }) => {
      const rows = results.filter((r) => r.retrieverId === id && r.catalogSize === catalogSize);
      if (rows.length === 0) {
        return [];
      }
      const latencies = rows.map(({ latencyMs }) => latencyMs);
      const cost = rows.reduce((sum, { costUsd }) => sum + costUsd, 0);
      return [
        {
          retrieverId: id,
          label,
          catalogSize,
          queries: rows.length,
          errors: rows.filter(({ error }) => error !== undefined).length,
          failedAttempts: rows.reduce(
            (sum, { failures, refusedCalls = 0 }) => sum + failures.length + refusedCalls,
            0
          ),
          metrics: Object.fromEntries(
            METRIC_NAMES.map((metric) => [metric, bootstrapMean(scores(rows, metric))])
          ) as Record<MetricName, MetricSummary>,
          latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
          costPer1kQueriesUsd: (cost / rows.length) * QUERIES_PER_COST_UNIT,
        },
      ];
    })
  );
}

/** Paired difference `a - b` on one metric over the queries both retrievers answered. */
export function compare(
  results: QueryResult[],
  { a, b, metric, catalogSize }: { a: string; b: string; metric: MetricName; catalogSize: number }
): MetricSummary & { queries: number } {
  const pick = (id: string) =>
    byQuery(results.filter((r) => r.retrieverId === id && r.catalogSize === catalogSize));
  const left = pick(a);
  const right = pick(b);
  const shared = new Set(
    left.map(({ queryId }) => queryId).filter((id) => right.some((r) => r.queryId === id))
  );
  const keep = (rows: QueryResult[]) => rows.filter(({ queryId }) => shared.has(queryId));
  return {
    ...pairedDifference(scores(keep(left), metric), scores(keep(right), metric)),
    queries: shared.size,
  };
}
