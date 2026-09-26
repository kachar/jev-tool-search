import { BM25_PLAIN, BM25_TUNED, bm25Retriever } from "./bm25";
import { jevJudge } from "./jev";
import { judgedRetriever } from "./judged";
import { keywordRetriever } from "./keyword";
import { rerankJudge } from "./rerank";
import type { Retriever } from "./types";

// Every arm the benchmark runs. Lexical arms search twice — with the user's words and with the query
// an agent wrote — because production sees the second. Model arms read the user's words and use the
// tuned BM25 on the agent's query to shortlist and to break ties.

/** How many lexical hits a hybrid hands to the second-stage model. */
export const SHORTLIST = 20;

export function createArms(): Retriever[] {
  const bm25 = bm25Retriever({
    id: "bm25-tuned",
    label: "BM25, tuned",
    options: BM25_TUNED,
    input: "keywords",
  });
  return [
    keywordRetriever("request"),
    keywordRetriever("keywords"),
    bm25Retriever({ id: "bm25-plain", label: "BM25, Orama defaults", options: BM25_PLAIN, input: "request" }),
    bm25Retriever({ id: "bm25-plain", label: "BM25, Orama defaults", options: BM25_PLAIN, input: "keywords" }),
    bm25Retriever({
      id: "bm25-tuned",
      label: "BM25, tuned",
      options: BM25_TUNED,
      input: "request",
    }),
    bm25,
    judgedRetriever({ id: "jev", label: "Jev, whole catalog", lexical: bm25, judge: jevJudge() }),
    judgedRetriever({
      id: `bm25-jev-${SHORTLIST}`,
      label: `BM25 top ${SHORTLIST}, then Jev`,
      lexical: bm25,
      judge: jevJudge(),
      shortlist: SHORTLIST,
    }),
    judgedRetriever({
      id: "rerank",
      label: "Voyage rerank-2.5, whole catalog",
      lexical: bm25,
      judge: rerankJudge(),
    }),
    judgedRetriever({
      id: `bm25-rerank-${SHORTLIST}`,
      label: `BM25 top ${SHORTLIST}, then Voyage rerank-2.5`,
      lexical: bm25,
      judge: rerankJudge(),
      shortlist: SHORTLIST,
    }),
  ];
}
