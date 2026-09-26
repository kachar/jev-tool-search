// Vendors the MetaTool (ToolE) tool-selection benchmark into data/metatool: all 199 tools, a seeded
// sample of single-tool and multi-tool queries, and the search query an agent would write for each.
// Pinned to one upstream commit so the sample is reproducible. Run once: `pnpm prepare:metatool`.
import { mkdir, writeFile } from "node:fs/promises";
import { writeSearchQuery } from "../src/agent-keywords";
import { parseCsv, samplePerTool, shuffle } from "../src/dataset";
import { mapConcurrent } from "../src/runner";
import type { BenchQuery, Dataset } from "../src/types";

const COMMIT = "35e81bb7576826e980c80fed8f8c0a2b4a1e6fbb";
const RAW = `https://raw.githubusercontent.com/HowieHwong/MetaTool/${COMMIT}`;
const OUT = new URL("../data/metatool/", import.meta.url);
const SEED = 7;
const SINGLE_PER_TOOL = 2;
const MULTI_QUERIES = 100;
const CONCURRENCY = 8;

const fetchText = async (path: string) => {
  const response = await fetch(`${RAW}/${path}`);
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.text();
};

const descriptions = JSON.parse(await fetchText("dataset/plugin_des.json")) as Record<
  string,
  string
>;
const single = parseCsv(await fetchText("dataset/data/all_clean_data.csv")).map((row) => ({
  request: row.Query!,
  tool: row.Tool!,
}));
const multi = JSON.parse(await fetchText("dataset/data/multi_tool_query_golden.json")) as {
  query: string;
  tool: string[];
}[];

const drafts: Omit<BenchQuery, "keywords">[] = [
  ...samplePerTool(single, SINGLE_PER_TOOL, SEED).map(({ request, tool }, index) => ({
    id: `single-${String(index + 1).padStart(3, "0")}`,
    request,
    relevant: [tool],
  })),
  ...shuffle(multi, SEED)
    .slice(0, MULTI_QUERIES)
    .map(({ query, tool }, index) => ({
      id: `multi-${String(index + 1).padStart(3, "0")}`,
      request: query,
      relevant: tool,
    })),
];

const queries = await mapConcurrent(drafts, CONCURRENCY, async (draft) => ({
  ...draft,
  keywords: await writeSearchQuery(draft.request),
}));

const dataset: Dataset = {
  name: "MetaTool (ToolE)",
  source: `https://github.com/HowieHwong/MetaTool/tree/${COMMIT}/dataset`,
  license: "MIT",
  tools: Object.entries(descriptions).map(([name, description]) => ({ name, description })),
  queries,
};

await mkdir(OUT, { recursive: true });
await writeFile(new URL("dataset.json", OUT), `${JSON.stringify(dataset, null, 2)}\n`);
await writeFile(new URL("LICENSE", OUT), await fetchText("LICENSE"));
console.log(`${dataset.tools.length} tools, ${queries.length} queries → ${OUT.pathname}`);
