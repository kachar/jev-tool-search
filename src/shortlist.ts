import type { Retriever } from "./types";

// Any search run over a lexical shortlist instead of the whole catalog: BM25 narrows to its top K,
// the inner search decides among those. Unlike a judged retriever, nothing from the lexical tail is
// appended, so an inner search that says "none of these fit" still returns nothing.

export function shortlisted({
  id,
  label,
  lexical,
  inner,
  size,
}: {
  id: string;
  label: string;
  lexical: Retriever;
  inner: Retriever;
  size: number;
}): Retriever {
  return {
    id,
    label,
    rank: async (query, catalog) => {
      const lexicalResult = await lexical.rank(query, catalog);
      const keep = new Set(lexicalResult.ranking.slice(0, size));
      const candidates = catalog.filter(({ name }) => keep.has(name));
      if (candidates.length === 0) {
        return lexicalResult;
      }
      const result = await inner.rank(query, candidates);
      return {
        ...result,
        inputTokens: lexicalResult.inputTokens + result.inputTokens,
        costUsd: lexicalResult.costUsd + result.costUsd,
      };
    },
  };
}
