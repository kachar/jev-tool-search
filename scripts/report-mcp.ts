// Prints the real-MCP retrieval summary from stored results, no model calls.
//   pnpm report:mcp [run] [arm,arm,...]
import { createMcpArms } from "../src/mcp-arms";
import { fileStore } from "../src/store";
import { summarize } from "../src/summary";

const [runId = "mcp", filter] = process.argv.slice(2);
const wanted = filter?.split(",");
const rows = await fileStore(new URL("../results/", import.meta.url).pathname).load(runId);
console.table(
  summarize(rows, createMcpArms(0))
    .filter(({ retrieverId }) => !wanted || wanted.includes(retrieverId))
    .map((row) => ({
      size: row.catalogSize,
      arm: row.retrieverId,
      n: row.queries,
      err: row.errors,
      refused: row.failedAttempts,
      first: row.metrics.hit1.mean.toFixed(3),
      top5: row.metrics.recall5.mean.toFixed(3),
      p50ms: Math.round(row.latencyMs.p50),
      p95ms: Math.round(row.latencyMs.p95),
      usdPer1k: row.costPer1kQueriesUsd.toFixed(3),
    }))
);
