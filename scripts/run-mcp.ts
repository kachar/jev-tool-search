// The real-MCP retrieval benchmark: LiveMCPBench's 525 tools, grown to 1,000 and 2,000 with real
// distractors, plus the "no tool fits" run. Resumable, like the MetaTool run.
//   pnpm mcp --sizes 525,1000,2000 --run mcp
//   pnpm mcp --abstain --run mcp-abstain
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { abstainRate, runAbstain } from "../src/abstain";
import { withDistractors } from "../src/dataset";
import { createMcpArms } from "../src/mcp-arms";
import { resultKey, runBenchmark } from "../src/runner";
import { fileStore } from "../src/store";
import { summarize } from "../src/summary";
import type { Dataset, ToolDoc } from "../src/types";

const SEED = 11;
const RESULTS = new URL("../results/", import.meta.url).pathname;
const read = async <T>(path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as T;

const { values } = parseArgs({
  options: {
    run: { type: "string", default: "mcp" },
    sizes: { type: "string", default: "525,1000,2000" },
    arms: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "6" },
    abstain: { type: "boolean", default: false },
  },
});

const live = await read<Dataset>("../data/livemcpbench/dataset.json");
const { tools: pool } = await read<{ tools: ToolDoc[] }>("../data/neuronto-distractors/tools.json");
const queries = values.limit ? live.queries.slice(0, Number(values.limit)) : live.queries;
const store = fileStore(RESULTS);
const done = new Set((await store.load(values.run)).map(resultKey));
const pick = (size: number) =>
  createMcpArms(size).filter(({ id }) => !values.arms || values.arms.split(",").includes(id));
let count = 0;
const onResult = async (result: Parameters<typeof store.save>[1]) => {
  await store.save(values.run, result);
  if (++count % 100 === 0 || result.error) {
    console.log(`  ${count}${result.error ? ` ${result.retrieverId}: ${result.error.slice(0, 140)}` : ""}`);
  }
};

if (values.abstain) {
  const arms = pick(live.tools.length);
  console.log(`no-tool-fits: ${live.tools.length} tools minus each task's servers, ${queries.length} tasks`);
  await runAbstain({ retrievers: arms, queries, catalog: live.tools, concurrency: Number(values.concurrency), done, onResult });
  const results = await store.load(values.run);
  console.table(arms.map(({ id }) => ({ arm: id, ...abstainRate(results, id) })));
} else {
  for (const size of values.sizes.split(",").map(Number)) {
    const catalog = withDistractors(live.tools, pool, { size, seed: SEED });
    const arms = pick(size);
    console.log(`catalog ${catalog.length} tools, ${queries.length} tasks, ${arms.length} arms`);
    await runBenchmark({ retrievers: arms, queries, catalog, concurrency: Number(values.concurrency), done, onResult });
  }
  const summary = summarize(await store.load(values.run), createMcpArms(0));
  await writeFile(`${RESULTS}${values.run}-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.table(
    summary.map((row) => ({
      arm: row.retrieverId,
      size: row.catalogSize,
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
}
