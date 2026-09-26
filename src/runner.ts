import { RANK_DEPTH } from "./metrics";
import type { BenchQuery, QueryResult, Retriever, ToolDoc } from "./types";

// Runs every retriever over every query against one catalog, a bounded number of calls at a time.
// A failed call is recorded with an empty ranking — a retriever that errors has not found the tool
// — so error rates stay visible in the summary instead of silently shrinking the sample.

export const DEFAULT_CONCURRENCY = 8;

/** A result's identity: one retriever, one query, one catalog size. */
export const resultKey = ({
  retrieverId,
  queryId,
  catalogSize,
}: Pick<QueryResult, "retrieverId" | "queryId" | "catalogSize">) =>
  `${retrieverId}|${catalogSize}|${queryId}`;

/** Calls per query before a failure counts; every failed attempt is kept on the result. */
export const MAX_ATTEMPTS = 6;
export const RETRY_DELAY_MS = 1000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runQuery(
  retriever: Retriever,
  query: BenchQuery,
  catalog: ToolDoc[],
  { retryDelayMs = RETRY_DELAY_MS } = {}
): Promise<QueryResult> {
  const base = {
    retrieverId: retriever.id,
    queryId: query.id,
    catalogSize: catalog.length,
    relevant: query.relevant,
  };
  const failures: string[] = [];
  for (let attempt = 1; ; attempt++) {
    // Latency is the successful attempt's: what one call costs, not what a retry policy costs.
    const started = performance.now();
    try {
      const { ranking, inputTokens, costUsd, refusedCalls, details } = await retriever.rank(query, catalog);
      const latencyMs = performance.now() - started;
      return {
        ...base,
        ranking: ranking.slice(0, RANK_DEPTH),
        inputTokens,
        costUsd,
        latencyMs,
        failures,
        ...(refusedCalls ? { refusedCalls } : {}),
        ...(details ? { details } : {}),
      };
    } catch (error) {
      failures.push(errorMessage(error));
      if (attempt === MAX_ATTEMPTS) {
        return {
          ...base,
          ranking: [],
          inputTokens: 0,
          costUsd: 0,
          latencyMs: performance.now() - started,
          failures,
          error: errorMessage(error),
        };
      }
      // Exponential backoff: a provider at capacity needs seconds, not milliseconds.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
    }
  }
}

/** Run `tasks` with at most `limit` in flight; results keep the input order. */
export async function mapConcurrent<ITEM, RESULT>(
  items: ITEM[],
  limit: number,
  task: (item: ITEM) => Promise<RESULT>
): Promise<RESULT[]> {
  const results: RESULT[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type RunOptions = {
  retrievers: Retriever[];
  queries: BenchQuery[];
  catalog: ToolDoc[];
  concurrency?: number;
  /** Results already stored; their keys are skipped so a run can resume. */
  done?: Set<string>;
  onResult?: (result: QueryResult) => void | Promise<void>;
};

export async function runBenchmark({
  retrievers,
  queries,
  catalog,
  concurrency = DEFAULT_CONCURRENCY,
  done = new Set(),
  onResult,
}: RunOptions): Promise<QueryResult[]> {
  const pending = retrievers
    .flatMap((retriever) => queries.map((query) => ({ retriever, query })))
    .filter(
      ({ retriever, query }) =>
        !done.has(
          resultKey({ retrieverId: retriever.id, queryId: query.id, catalogSize: catalog.length })
        )
    );
  // Untimed setup first, so no query's latency pays for building an index.
  await Promise.all(retrievers.map((retriever) => retriever.prepare?.(catalog)));
  return mapConcurrent(pending, concurrency, async ({ retriever, query }) => {
    const result = await runQuery(retriever, query, catalog);
    await onResult?.(result);
    return result;
  });
}
