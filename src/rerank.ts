import { rerank, type RerankingModel } from "ai";
import { gatewayCostUsd, type Judge } from "./judged";

// A dedicated reranking model as the judge, so the benchmark can tell "Jev beats BM25" apart from
// "any second-stage model beats BM25". Each tool is one document: its name, then its description.

export const RERANK_MODEL = "voyage/rerank-2.5";
/** Voyage accepts up to 1,000 documents per rerank request. */
export const RERANK_MAX_DOCUMENTS = 1000;

export function rerankJudge(model: RerankingModel = RERANK_MODEL): Judge {
  return {
    maxCandidates: RERANK_MAX_DOCUMENTS,
    rank: async (request, candidates) => {
      const { ranking, providerMetadata } = await rerank({
        model,
        maxRetries: 0,
        query: request,
        documents: candidates.map((tool) => `${tool.name}: ${tool.description}`),
      });
      return {
        ranking: ranking.map(({ originalIndex }) => candidates[originalIndex]!.name),
        inputTokens: 0,
        costUsd: gatewayCostUsd(providerMetadata) ?? 0,
      };
    },
  };
}
