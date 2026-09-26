// Runs the tool-search benchmark: every arm × every query × every catalog size, resumable.
//   pnpm bench                                  # everything, run id "main"
//   pnpm bench --arms jev,bm25-tuned@keywords --sizes 199 --limit 20 --run smoke
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createArms } from "../src/arms";
import { buildCatalog } from "../src/dataset";
import { resultKey, runBenchmark } from "../src/runner";
import { fileStore } from "../src/store";
import { summarize } from "../src/summary";
import type { Dataset, QueryResult } from "../src/types";

const CATALOG_SEED = 11;
const RESULTS = new URL("../results/", import.meta.url).pathname;

const { values } = parseArgs({
  options: {
    run: { type: "string", default: "main" },
    arms: { type: "string" },
    sizes: { type: "string", default: "50,100,199" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "8" },
  },
});

const dataset = JSON.parse(
  await readFile(new URL("../data/metatool/dataset.json", import.meta.url), "utf8")
) as Dataset;
const wanted = values.arms?.split(",");
const arms = createArms().filter(({ id }) => !wanted || wanted.includes(id));
const store = fileStore(RESULTS);
const stored = await store.load(values.run);
const done = new Set(stored.map(resultKey));
const all: QueryResult[] = [...stored];

for (const size of values.sizes.split(",").map(Number)) {
  const { catalog, queries } = buildCatalog(dataset.tools, dataset.queries, {
    size,
    seed: CATALOG_SEED,
  });
  const sample = values.limit ? queries.slice(0, Number(values.limit)) : queries;
  console.log(`catalog ${catalog.length} tools, ${sample.length} queries, ${arms.length} arms`);
  let count = 0;
  const fresh = await runBenchmark({
    retrievers: arms,
    queries: sample,
    catalog,
    concurrency: Number(values.concurrency),
    done,
    onResult: async (result) => {
      await store.save(values.run, result);
      if (++count % 200 === 0 || result.error) {
        console.log(`  ${count} done${result.error ? ` — ${result.retrieverId}: ${result.error}` : ""}`);
      }
    },
  });
  all.push(...fresh);
}

const splits = { single: "single-", multi: "multi-" };
const summary = Object.fromEntries(
  Object.entries(splits).map(([split, prefix]) => [
    split,
    summarize(
      all.filter(({ queryId }) => queryId.startsWith(prefix)),
      arms
    ),
  ])
);
await writeFile(`${RESULTS}${values.run}-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.table(
  summary.single!.map((row) => ({
    arm: row.retrieverId,
    size: row.catalogSize,
    n: row.queries,
    err: row.errors,
    retried: row.failedAttempts,
    hit1: row.metrics.hit1.mean.toFixed(3),
    recall5: row.metrics.recall5.mean.toFixed(3),
    mrr20: row.metrics.mrr.mean.toFixed(3),
    p50ms: Math.round(row.latencyMs.p50),
    p95ms: Math.round(row.latencyMs.p95),
    usdPer1k: row.costPer1kQueriesUsd.toFixed(4),
  }))
);
