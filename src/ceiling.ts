import { hitAt } from "./metrics";
import type { BenchQuery, Retriever, ToolDoc } from "./types";

// The most a shortlist-then-judge search can ever score: the share of tasks where the lexical top K
// holds at least one right tool. Computed from full, untruncated lexical rankings; no model calls.

export type Ceiling = { catalogSize: number; k: number; hit: number };

export async function lexicalCeilings(
  lexical: Retriever,
  queries: BenchQuery[],
  catalogs: ToolDoc[][],
  ks: number[]
): Promise<Ceiling[]> {
  const rows: Ceiling[] = [];
  for (const catalog of catalogs) {
    const rankings = await Promise.all(queries.map(async (query) => (await lexical.rank(query, catalog)).ranking));
    for (const k of ks) {
      const hits = rankings.map((ranking, index) => hitAt(ranking, queries[index]!.relevant, k));
      rows.push({ catalogSize: catalog.length, k, hit: hits.reduce((sum, hit) => sum + hit, 0) / hits.length });
    }
  }
  return rows;
}
