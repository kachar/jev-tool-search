// Vendors two recent, real-MCP datasets, pinned:
// - LiveMCPBench (ICIP-CAS, Apache-2.0; arXiv 2508.01780 v2, 2026): 525 tools from 69 real MCP
//   servers with their schemas, and 95 human-annotated tasks naming the tools each one needs.
// - Neuronto Verified MCP Tools (CC-BY-4.0, 2026-09-01): tools read from live servers' tools/list,
//   sampled as distractors to grow the catalog to 1,000 and 2,000 tools.
// Each task also gets the query an agent writes for a search tool. Run once: `pnpm prepare:mcp`.
import { mkdir, writeFile } from "node:fs/promises";
import { writeSearchQuery } from "../src/agent-keywords";
import { shuffle } from "../src/dataset";
import { mapConcurrent } from "../src/runner";
import type { Dataset, ToolDoc } from "../src/types";

const LIVE_COMMIT = "36a51a1065dda49c1e503b87edf33a1e0b331a74";
const LIVE_HF_REVISION = "ddea2d24196638bc4026c4cb891f679d0357bfd0";
const NEURONTO_REVISION = "8356c9079b9ac3229ff7acc0b02287644109afc2";
const LIVE_TOOLS = `https://raw.githubusercontent.com/icip-cas/LiveMCPBench/${LIVE_COMMIT}/tools/LiveMCPTool/tools.json`;
const LIVE_TASKS = `https://huggingface.co/datasets/ICIP/LiveMCPBench/resolve/${LIVE_HF_REVISION}/tasks/tasks.json`;
const NEURONTO = `https://huggingface.co/datasets/AgenticResourceDiscovery/verified-mcp-tools/resolve/${NEURONTO_REVISION}/tools.jsonl`;
const OUT = new URL("../data/", import.meta.url);
const SEED = 7;
const DISTRACTORS = 1500;
const MIN_DESCRIPTION = 20;
const CONCURRENCY = 8;

type LiveServer = {
  name: string;
  tools: Record<string, { tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }>;
};
type LiveTask = { task_id: string; Question: string; "Annotator Metadata": { Tools: string } };
type NeurontoTool = {
  tool_name: string;
  tool_description?: string;
  input_schema?: Record<string, unknown>;
  server_name?: string;
  introspection_status?: string;
};

const fetchText = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
};
const words = (name: string) => name.replace(/[_-]+/g, " ");
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// LiveMCPBench catalog: one tool per (server, tool); the server prefix keeps same-named tools apart.
const servers = JSON.parse(await fetchText(LIVE_TOOLS)) as LiveServer[];
const byFullName = new Map<string, ToolDoc>();
for (const server of servers) {
  for (const [serverKey, { tools }] of Object.entries(server.tools)) {
    for (const tool of tools) {
      const name = `${serverKey}__${tool.name}`;
      byFullName.set(name, {
        name,
        description: tool.description?.trim() || words(tool.name),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      });
    }
  }
}
const tools = [...byFullName.values()];
const byBareName = new Map<string, string[]>();
for (const { name } of tools) {
  const bare = name.slice(name.indexOf("__") + 2);
  byBareName.set(bare, [...(byBareName.get(bare) ?? []), name]);
}

// Tasks: every annotated tool that exists in the catalog is a right answer (on any server that has it).
const tasks = JSON.parse(await fetchText(LIVE_TASKS)) as LiveTask[];
const drafts = tasks
  .map((task) => ({
    request: task.Question.trim(),
    relevant: [
      ...new Set(
        task["Annotator Metadata"].Tools.split("\n")
          .map((line) => line.replace(/^\s*\d+\.\s*/, "").trim())
          .flatMap((bare) => byBareName.get(bare) ?? [])
      ),
    ],
  }))
  .filter(({ relevant }) => relevant.length > 0)
  .map((draft, index) => ({ id: `task-${String(index + 1).padStart(3, "0")}`, ...draft }));

const queries = await mapConcurrent(drafts, CONCURRENCY, async (draft) => ({
  ...draft,
  keywords: await writeSearchQuery(draft.request),
}));

const live: Dataset = {
  name: "LiveMCPBench",
  source: `https://github.com/icip-cas/LiveMCPBench/tree/${LIVE_COMMIT} + https://huggingface.co/datasets/ICIP/LiveMCPBench/tree/${LIVE_HF_REVISION}`,
  license: "Apache-2.0",
  tools,
  queries,
};

// Distractors: real tools from servers LiveMCPBench does not include, with usable descriptions.
const liveServers = new Set(servers.flatMap((server) => [slug(server.name), ...Object.keys(server.tools).map(slug)]));
const seen = new Set<string>();
const pool: ToolDoc[] = [];
for (const line of (await fetchText(NEURONTO)).split("\n")) {
  if (!line.trim()) {
    continue;
  }
  const row = JSON.parse(line) as NeurontoTool;
  const server = slug(row.server_name ?? "");
  const description = row.tool_description?.trim() ?? "";
  const name = `${server}__${row.tool_name}`;
  if (
    row.introspection_status !== "ok" ||
    !server ||
    liveServers.has(server) ||
    description.length < MIN_DESCRIPTION ||
    seen.has(name)
  ) {
    continue;
  }
  seen.add(name);
  pool.push({ name, description, ...(row.input_schema ? { inputSchema: row.input_schema } : {}) });
}
const distractors = shuffle(pool, SEED).slice(0, DISTRACTORS);

await mkdir(new URL("livemcpbench/", OUT), { recursive: true });
await mkdir(new URL("neuronto-distractors/", OUT), { recursive: true });
await writeFile(new URL("livemcpbench/dataset.json", OUT), `${JSON.stringify(live, null, 1)}\n`);
await writeFile(
  new URL("neuronto-distractors/tools.json", OUT),
  `${JSON.stringify({ name: "Neuronto Verified MCP Tools (sample)", source: `https://huggingface.co/datasets/AgenticResourceDiscovery/verified-mcp-tools/tree/${NEURONTO_REVISION}`, license: "CC-BY-4.0", attribution: "Neuronto Agentic Resource Discovery (ARD) Index, neuronto.com", tools: distractors }, null, 1)}\n`
);
console.log(`${tools.length} tools, ${queries.length} tasks; ${distractors.length} distractors from ${pool.length}`);
