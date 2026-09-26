import type { ProviderMetadata } from "ai";
import type { RankResult, Retriever, ToolDoc } from "./types";

// A retriever in two stages: a lexical ranking, then a model that re-orders either the whole catalog
// or the lexical top-N. The lexical ranking also breaks the model's ties and fills the tail, so every
// arm returns a complete ranking and every metric reads the same way.

/** A model that orders `candidates` for a user request; `tieBreak` is the lexical order. */
export type Judge = {
  maxCandidates: number;
  rank: (request: string, candidates: ToolDoc[], tieBreak: string[]) => Promise<RankResult>;
};

/**
 * The list price AI Gateway reports on a response. `marketCost` rather than `cost`: an account on a
 * promotion is billed 0, and a reader pays the market rate.
 */
export function gatewayCostUsd(metadata: ProviderMetadata | undefined): number | undefined {
  const cost = metadata?.gateway?.marketCost ?? metadata?.gateway?.cost;
  return typeof cost === "string" || typeof cost === "number" ? Number(cost) : undefined;
}

type JudgedRetrieverOptions = {
  id: string;
  label: string;
  lexical: Retriever;
  judge: Judge;
  /** Judge only the lexical top-N instead of the whole catalog. */
  shortlist?: number;
};

export function judgedRetriever({
  id,
  label,
  lexical,
  judge,
  shortlist,
}: JudgedRetrieverOptions): Retriever {
  return {
    id,
    label,
    rank: async (query, catalog) => {
      const lexicalResult = await lexical.rank(query, catalog);
      const candidates = shortlist
        ? lexicalResult.ranking
            .slice(0, shortlist)
            .map((name) => catalog.find((tool) => tool.name === name)!)
        : catalog;
      if (candidates.length === 0) {
        return lexicalResult;
      }
      if (candidates.length > judge.maxCandidates) {
        throw new Error(
          `${candidates.length} candidates exceed the judge's limit of ${judge.maxCandidates}`
        );
      }
      // The judge reads what the user asked, not the agent's keywords: that is the point of a model.
      const judged = await judge.rank(query.request, candidates, lexicalResult.ranking);
      return {
        ranking: [
          ...judged.ranking,
          ...lexicalResult.ranking.filter((name) => !judged.ranking.includes(name)),
        ],
        inputTokens: lexicalResult.inputTokens + judged.inputTokens,
        costUsd: lexicalResult.costUsd + judged.costUsd,
        ...(judged.refusedCalls ? { refusedCalls: judged.refusedCalls } : {}),
      };
    },
  };
}
