import { queryText, type QueryInput, type Retriever, type ToolDoc } from "./types";

// A faithful port of the AI SDK 7 `toolSearch()` ranking (ai/src/tool-search/prepare-tool-search.ts):
// split camelCase, lowercase, keep letter/number runs; a query term found in the tool name scores 2,
// in the description 1; tools that score 0 are dropped. The SDK returns the top five; we keep the
// whole ranking so every metric can read past five.

const NAME_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

export function tokenize(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function keywordScores(query: string, catalog: ToolDoc[]) {
  const terms = [...new Set(tokenize(query))];
  return catalog
    .map(({ name, description }) => {
      const nameTerms = new Set(tokenize(name));
      const descriptionTerms = new Set(tokenize(description));
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (nameTerms.has(term) ? NAME_WEIGHT : 0) +
          (descriptionTerms.has(term) ? DESCRIPTION_WEIGHT : 0),
        0
      );
      return { name, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
}

export function keywordRetriever(input: QueryInput): Retriever {
  return {
    id: `keyword@${input}`,
    label: "Keyword match (AI SDK toolSearch)",
    rank: async (query, catalog) => ({
      ranking: keywordScores(queryText(query, input), catalog).map(({ name }) => name),
      inputTokens: 0,
      costUsd: 0,
    }),
  };
}
