// End-to-end arms: Claude on Vertex AI (Opus 5.5 by default), finding and calling a tool from a
// deferred catalog. Same resumable store and summaries as the retrieval benchmark. The published run
// used --model claude-sonnet-4-5@20250929.
//   pnpm agent --dataset data/<name>/dataset.json --size 199 --limit 20 --run agent-smoke
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { BM25_TUNED, bm25Retriever } from "../src/bm25";
import { CLAUDE_MODELS, claudeAgent, DEFAULT_CLAUDE_MODEL, type ClaudeModel } from "../src/claude-agent";
import { buildCatalog } from "../src/dataset";
import { jevJudge } from "../src/jev";
import { jevSearch } from "../src/jev-search";
import { embeddingRetriever } from "../src/embed";
import { shortlisted } from "../src/shortlist";
import { judgedRetriever } from "../src/judged";
import { resultKey, runBenchmark } from "../src/runner";
import { fileStore } from "../src/store";
import { summarize } from "../src/summary";
import type { Dataset } from "../src/types";
import { vertexClient } from "../src/vertex";

const CATALOG_SEED = 11;
const SHORTLIST = 20;
const EMBED_SHORTLIST = 100;
// gcloud returns its cached token until it expires, so a fresh-looking token can have minutes left.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const RESULTS = new URL("../results/", import.meta.url).pathname;

const { values } = parseArgs({
  options: {
    dataset: { type: "string", default: "data/livemcpbench/dataset.json" },
    run: { type: "string", default: "agent" },
    size: { type: "string" },
    limit: { type: "string" },
    arms: { type: "string" },
    concurrency: { type: "string", default: "4" },
    model: { type: "string", default: DEFAULT_CLAUDE_MODEL },
  },
});

if (!(values.model in CLAUDE_MODELS)) {
  throw new Error(`no list price for ${values.model}; add it to CLAUDE_MODELS in src/claude-agent.ts`);
}
const price = CLAUDE_MODELS[values.model as ClaudeModel];

let token = { value: "", at: 0 };
const getToken = async () => {
  if (Date.now() - token.at > TOKEN_TTL_MS) {
    token = { value: execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim(), at: Date.now() };
  }
  return token.value;
};
const client = vertexClient({
  project: process.env.ANTHROPIC_VERTEX_PROJECT_ID!,
  region: process.env.CLOUD_ML_REGION ?? "us-east5",
  model: values.model,
  getToken,
});

const bm25 = bm25Retriever({ id: "bm25", label: "BM25", options: BM25_TUNED, input: "keywords" });
// The search sees the request plus what Claude searched for, so embed that text.
const embed = embeddingRetriever({ id: "embed", label: "Voyage embeddings", input: "request" });
const arms = [
  claudeAgent({ id: "claude-bm25", label: "Claude + built-in BM25 search", client, price, mode: { kind: "server", variant: "bm25" } }),
  claudeAgent({ id: "claude-regex", label: "Claude + built-in regex search", client, price, mode: { kind: "server", variant: "regex" } }),
  claudeAgent({
    id: "claude-jev",
    label: "Claude + Jev search",
    client,
    price,
    mode: { kind: "custom", search: jevSearch({ id: "jev-search", label: "Jev search" }) },
  }),
  claudeAgent({
    id: "claude-bm25-jev",
    label: `Claude + BM25 top ${SHORTLIST} then Jev`,
    client,
    price,
    mode: {
      kind: "custom",
      search: judgedRetriever({ id: "bm25-jev", label: "BM25 then Jev", lexical: bm25, judge: jevJudge(), shortlist: SHORTLIST }),
    },
  }),
  claudeAgent({
    id: "claude-embed-jev",
    label: `Claude + embeddings top ${EMBED_SHORTLIST} then Jev search`,
    client,
    price,
    mode: {
      kind: "custom",
      search: shortlisted({
        id: "embed-jev-search",
        label: "Embeddings then Jev search",
        lexical: embed,
        inner: jevSearch({ id: "jev-search", label: "Jev search" }),
        size: EMBED_SHORTLIST,
      }),
    },
  }),
  claudeAgent({ id: "claude-all-tools", label: "Claude, every tool loaded", client, price, mode: { kind: "none" } }),
].filter(({ id }) => !values.arms || values.arms.split(",").includes(id));

const dataset = JSON.parse(await readFile(values.dataset, "utf8")) as Dataset;
const size = Number(values.size ?? dataset.tools.length);
const { catalog, queries } = buildCatalog(dataset.tools, dataset.queries, { size, seed: CATALOG_SEED });
const sample = values.limit ? queries.slice(0, Number(values.limit)) : queries;
// Embed the catalog before any timed request, as production would.
await embed.prepare!(catalog);
const store = fileStore(RESULTS);
const stored = await store.load(values.run);
console.log(`${dataset.name}: ${catalog.length} tools, ${sample.length} requests, ${arms.length} arms`);
let count = 0;
await runBenchmark({
  retrievers: arms,
  queries: sample,
  catalog,
  concurrency: Number(values.concurrency),
  done: new Set(stored.map(resultKey)),
  onResult: async (result) => {
    await store.save(values.run, result);
    if (++count % 50 === 0 || result.error) {
      console.log(`  ${count}${result.error ? ` ${result.retrieverId}: ${result.error.slice(0, 160)}` : ""}`);
    }
  },
});
const summary = summarize(await store.load(values.run), arms);
await writeFile(`${RESULTS}${values.run}-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.table(
  summary.map((row) => ({
    arm: row.retrieverId,
    n: row.queries,
    err: row.errors,
    right: row.metrics.hit1.mean.toFixed(3),
    p50ms: Math.round(row.latencyMs.p50),
    p95ms: Math.round(row.latencyMs.p95),
    usdPer1k: row.costPer1kQueriesUsd.toFixed(2),
  }))
);
