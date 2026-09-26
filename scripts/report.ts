// Prints a run's summary tables from stored results without calling any model.
//   pnpm report main
import { createArms } from "../src/arms";
import { fileStore } from "../src/store";
import { summarize } from "../src/summary";

const runId = process.argv[2] ?? "main";
const results = await fileStore(new URL("../results/", import.meta.url).pathname).load(runId);
for (const [split, prefix] of [
  ["single", "single-"],
  ["multi", "multi-"],
] as const) {
  console.log(split);
  console.table(
    summarize(
      results.filter(({ queryId }) => queryId.startsWith(prefix)),
      createArms()
    ).map((row) => ({
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
      usdPer1k: row.costPer1kQueriesUsd.toFixed(3),
    }))
  );
}
