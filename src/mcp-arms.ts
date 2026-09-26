import { BM25_PLAIN, bm25Retriever } from "./bm25";
import { embeddingRetriever } from "./embed";
import { jevJudge } from "./jev";
import { jevSearch } from "./jev-search";
import { judgedRetriever } from "./judged";
import { keywordRetriever } from "./keyword";
import { rerankJudge, RERANK_MAX_DOCUMENTS } from "./rerank";
import { shortlisted } from "./shortlist";
import type { Retriever } from "./types";

// The arms for the real-MCP benchmark. Lexical and dense arms search twice (user's words, agent's
// query). Jev reads the user's request. A catalog over Jev's 255-option cap needs the chunked
// search; the single-question Jev arm only runs on a shortlist.

export const MCP_SHORTLIST = 20;
/** BM25 shortlist sizes handed to a single Jev choice question (it takes at most 255 options). */
export const COMBINED_SHORTLISTS = [50, 100, 200];
/** BM25 shortlist handed to the full Jev search, fit check included. */
export const COMBINED_SEARCH_SHORTLIST = 100;

export function createMcpArms(catalogSize: number): Retriever[] {
  const bm25 = bm25Retriever({ id: "bm25", label: "BM25", options: BM25_PLAIN, input: "keywords" });
  const embedRequest = embeddingRetriever({ id: "embed", label: "Voyage embeddings", input: "request" });
  const arms: Retriever[] = [
    keywordRetriever("request"),
    keywordRetriever("keywords"),
    bm25Retriever({ id: "bm25", label: "BM25", options: BM25_PLAIN, input: "request" }),
    bm25,
    embedRequest,
    embeddingRetriever({ id: "embed", label: "Voyage embeddings", input: "keywords" }),
    jevSearch({ id: "jev-search", label: "Jev search (two-stage)" }),
    jevSearch({ id: "jev-search-ungated", label: "Jev search, no fit check", options: { gate: false } }),
    judgedRetriever({
      id: `bm25-jev-${MCP_SHORTLIST}`,
      label: `BM25 top ${MCP_SHORTLIST}, then Jev`,
      lexical: bm25,
      judge: jevJudge(),
      shortlist: MCP_SHORTLIST,
    }),
    // Orama BM25 + Jev, the combination at every shortlist size one Jev question can hold.
    ...COMBINED_SHORTLISTS.map((size) =>
      judgedRetriever({
        id: `bm25-jev-${size}`,
        label: `BM25 top ${size}, then Jev`,
        lexical: bm25,
        judge: jevJudge(),
        shortlist: size,
      })
    ),
    // The same shortlist from a dense index: does a search that reads meaning keep Jev's wins?
    shortlisted({
      id: `embed-jev-search-${COMBINED_SEARCH_SHORTLIST}`,
      label: `Embeddings top ${COMBINED_SEARCH_SHORTLIST}, then Jev search`,
      lexical: embedRequest,
      inner: jevSearch({ id: "jev-search", label: "Jev search" }),
      size: COMBINED_SEARCH_SHORTLIST,
    }),
    shortlisted({
      id: `bm25-jev-search-${COMBINED_SEARCH_SHORTLIST}`,
      label: `BM25 top ${COMBINED_SEARCH_SHORTLIST}, then Jev search`,
      lexical: bm25,
      inner: jevSearch({ id: "jev-search", label: "Jev search" }),
      size: COMBINED_SEARCH_SHORTLIST,
    }),
    judgedRetriever({
      id: `bm25-rerank-${MCP_SHORTLIST}`,
      label: `BM25 top ${MCP_SHORTLIST}, then Voyage rerank`,
      lexical: bm25,
      judge: rerankJudge(),
      shortlist: MCP_SHORTLIST,
    }),
  ];
  // Voyage's reranker takes at most 1,000 documents per request.
  return catalogSize <= RERANK_MAX_DOCUMENTS
    ? [...arms, judgedRetriever({ id: "rerank", label: "Voyage rerank, whole catalog", lexical: bm25, judge: rerankJudge() })]
    : arms;
}
