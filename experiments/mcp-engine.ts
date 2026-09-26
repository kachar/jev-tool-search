// The engine spike on LiveMCPBench (525 real MCP tools, 94 tasks), interleaved with the arms the
// "Picking the right tool" post measured, so both articles report the same catalog.
//   tsx --env-file=.env.local experiments/mcp-engine.ts [--limit 20]
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { BM25_PLAIN, bm25Retriever } from "../src/bm25";
import { embeddingRetriever } from "../src/embed";
import { detail, jevSearch, summary } from "../src/jev-search";
import { shortlisted } from "../src/shortlist";
import type { BenchQuery, Dataset, Retriever, ToolDoc } from "../src/types";
import { createIndex, search, type IndexConfig } from "./engine";
import { runExperiment, stateFor, type Strategy } from "./lib";

const SHORTLIST = 100;
const { values } = parseArgs({ options: { limit: { type: "string" }, concurrency: { type: "string", default: "4" }, set: { type: "string", default: "first" } } });
const live = JSON.parse(await readFile(new URL("../data/livemcpbench/dataset.json", import.meta.url), "utf8")) as Dataset;
const queries = values.limit ? live.queries.slice(0, Number(values.limit)) : live.queries;

const bm25 = bm25Retriever({ id: "bm25", label: "BM25", options: BM25_PLAIN, input: "keywords" });
const embed = embeddingRetriever({ id: "embed", label: "Voyage embeddings", input: "request" });

/** A benchmark retriever as an experiment strategy (its own retries; ranking only). */
const fromRetriever = (retriever: Retriever, id = retriever.id): Strategy => ({
  id,
  run: async (query, catalog) => ({ ranking: (await retriever.rank(query, catalog)).ranking }),
});

/** The engine over the whole catalog, or over the embeddings top 100; fallback = that order. */
type Texts = { staged?: boolean };
function engineArm(id: string, mode: "catalog" | "shortlist", config: Partial<IndexConfig> = {}, { staged = false }: Texts = {}): Strategy {
  const indexes = new WeakMap<ToolDoc[], ReturnType<typeof createIndex<ToolDoc>>>();
  return {
    id,
    run: async (query: BenchQuery, catalog, ctx) => {
      // Staged: short summaries for the wide rounds, name + description + parameters for the final.
      const index =
        indexes.get(catalog) ??
        createIndex({
          documents: catalog,
          id: (t) => t.name,
          describe: staged ? (t) => summary(t, 160) : (t) => t.description,
          ...(staged && { detail: (t: ToolDoc) => detail(t, 1200) }),
          ...config,
        });
      indexes.set(catalog, index);
      const order = (await (mode === "shortlist" ? embed : bm25).rank(query, catalog)).ranking;
      const result = await search(index, {
        state: stateFor(query),
        limit: 20,
        fallback: [...order, ...catalog.map((t) => t.name).filter((n) => !order.includes(n))],
        ...(mode === "shortlist" && { candidates: order.slice(0, SHORTLIST) }),
      });
      ctx.calls.push(
        ...result.requests.map((r) => ({
          options: r.options,
          questions: 1,
          latencyMs: r.ms,
          inputTokens: r.inputTokens,
          costUsd: 0,
          failures: Array.from({ length: r.failures }, () => "retryable"),
          ...(r.error && { error: r.error }),
        }))
      );
      if (ctx.calls[0]) ctx.calls[0].costUsd = result.costUsd;
      return {
        ranking: result.hits.map((hit) => hit.id),
        extra: { plan: result.plan, partial: result.partial, requests: result.requests.length, ...(result.fellBack && { fellBack: result.fellBack }) },
      };
    },
  };
}

const firstPost = fromRetriever(jevSearch({ id: "jev-search", label: "Jev search (FastMCP two-stage)" }));
const sets: Record<string, Strategy[]> = {
  staged: [
    firstPost,
    engineArm("engine-staged", "catalog", {}, { staged: true }),
    engineArm("engine-staged-4k", "catalog", { requestTokens: 4000 }, { staged: true }),
    engineArm("engine-embed-100-staged", "shortlist", {}, { staged: true }),
  ],
};

await runExperiment({
  experiment: values.set === "first" ? "exp-mcp-engine" : `exp-mcp-${values.set}`,
  catalog: live.tools,
  queries,
  concurrency: Number(values.concurrency),
  strategies: sets[values.set] ?? [
    fromRetriever(jevSearch({ id: "jev-search", label: "Jev search (FastMCP two-stage)" })),
    fromRetriever(
      shortlisted({ id: "embed-jev-search-100", label: "Embeddings top 100, then Jev search", lexical: embed, inner: jevSearch({ id: "jev-search", label: "Jev search" }), size: SHORTLIST })
    ),
    engineArm("engine-catalog", "catalog"),
    engineArm("engine-catalog-160c", "catalog", { optionChars: 160 }),
    engineArm("engine-embed-100", "shortlist"),
  ],
});
