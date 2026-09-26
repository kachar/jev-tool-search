import { withoutServers } from "./dataset";
import { mapConcurrent, resultKey, runQuery, DEFAULT_CONCURRENCY } from "./runner";
import type { BenchQuery, QueryResult, Retriever, ToolDoc } from "./types";

// "No tool fits": each query runs against the catalog minus every server that could serve it. A
// retriever that returns nothing got it right; one that returns something handed the agent a tool
// that cannot do the job. Results are filed under the full catalog's size so a run groups cleanly.

export async function runAbstain({
  retrievers,
  queries,
  catalog,
  concurrency = DEFAULT_CONCURRENCY,
  done = new Set(),
  onResult,
}: {
  retrievers: Retriever[];
  queries: BenchQuery[];
  catalog: ToolDoc[];
  concurrency?: number;
  done?: Set<string>;
  onResult?: (result: QueryResult) => void | Promise<void>;
}): Promise<QueryResult[]> {
  const pending = retrievers
    .flatMap((retriever) => queries.map((query) => ({ retriever, query })))
    .filter(
      ({ retriever, query }) =>
        !done.has(resultKey({ retrieverId: retriever.id, queryId: query.id, catalogSize: catalog.length }))
    );
  return mapConcurrent(pending, concurrency, async ({ retriever, query }) => {
    const result = {
      ...(await runQuery(retriever, query, withoutServers(catalog, query))),
      catalogSize: catalog.length,
    };
    await onResult?.(result);
    return result;
  });
}

/** Share of queries a retriever answered with nothing, the right answer when no tool fits. */
export function abstainRate(results: QueryResult[], retrieverId: string): { rate: number; queries: number } {
  const rows = results.filter((row) => row.retrieverId === retrieverId && row.error === undefined);
  return { rate: rows.filter(({ ranking }) => ranking.length === 0).length / rows.length, queries: rows.length };
}
