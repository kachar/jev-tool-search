# jev-tool-search

A benchmark for picking the right tool for an LLM agent, comparing BM25, embeddings, rerankers and
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) (TypeSafe AI's decision model),
plus an experimental Jev search engine: an "Orama for Jev".

It backs two articles:

- [Picking the right tool for an LLM is a decision. Jev makes it.](https://kachar.dev/blog/picking-the-right-tool-for-an-llm-is-a-decision)
  Jev vs BM25, embeddings and rerankers on 525 real MCP tools, plus Claude end to end.
- [BM25 got Orama. Jev still needs one.](https://kachar.dev/blog/an-orama-for-jev)
  What a Jev search library has to decide for you, and why its defaults don't transfer between catalogs.

## Headline results

LiveMCPBench: 525 real MCP tools from 69 servers, 94 human-annotated tasks. "Right tool first" means
the first result is a tool the task needs. Measured 2026-09-25/26 from Frankfurt through Vercel AI
Gateway, in Jev's second week on the gateway.

| Search | Right tool first | Cost per 1,000 searches |
|---|---|---|
| BM25 on the agent's query (what Claude's built-in tool search uses) | 32% | $0 |
| Voyage embeddings | 46% | $0.01 |
| FastMCP-style two-stage Jev search | 56% | $1.03 |
| Voyage rerank-2.5 over the whole catalog | 60% | $2.23 |
| Embeddings top 100, then the experimental engine* | 59%, with 92% in the top 5 | $0.26 |

\* Measured in a later interleaved run in which the FastMCP-style search scored 54% (83% in the top
5). Compare rows from different runs with care. With 94 tasks, differences under about 10 points are within the noise. Full tables, confidence
intervals, the 1,000- and 2,000-tool runs, the "no tool fits" run and the Claude end-to-end run are in
[`research/00-benchmark-results.md`](research/00-benchmark-results.md). The engine experiments,
including the MetaTool runs, are in [`research/20-experiments.md`](research/20-experiments.md).

## What's inside

```
src/            benchmark: datasets, BM25 (Orama), embeddings, rerankers, Jev search, Claude agent, metrics, stats
scripts/        runners: MetaTool, LiveMCPBench, "no tool fits", Claude end to end, reports
experiments/    the experimental engine (engine.ts) and the experiments that shaped it
tests/          vitest, including the engine against the AI SDK's mock evaluation model
data/           vendored datasets (licenses below)
research/       results, experiment logs, research notes and the library plan
```

## Running it

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env.local        # add AI_GATEWAY_API_KEY (or a VERCEL_OIDC_TOKEN)
pnpm test                         # unit tests, no network
pnpm mcp --sizes 525 --limit 10   # a small LiveMCPBench run, resumable
pnpm report:mcp mcp               # summary table from stored results, no model calls
```

Jev, Voyage embeddings and the reranker go through Vercel AI Gateway. The Claude end-to-end arms
(`pnpm agent`) run on Google Vertex AI (`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, and
`gcloud auth`), because the gateway's Anthropic endpoint ignored the server-side tool-search tool when
this was written.

Other runners:

```bash
pnpm mcp                          # search-only arms at 525 / 1,000 / 2,000 tools
pnpm mcp --abstain --run mcp-abstain   # "no tool fits": each task with its servers removed
pnpm agent --run agent-live       # Claude end to end
pnpm bench                        # the older MetaTool run (199 tools)
npx tsx --env-file=.env.local experiments/mcp-engine.ts --set staged   # the engine on LiveMCPBench
```

Results land as JSONL in `results/` (git-ignored), one row per arm, task and catalog size, with the
ranking, latency, tokens, list-price cost and every failed attempt. A full LiveMCPBench search-only
run costs a few dollars at list price. Jev's input price is $0.042 per million tokens.

## The experimental engine

`experiments/engine.ts` is a prototype of a search library whose ranking is a Jev decision. It has
Orama's shape (`createIndex`, `insert`, `search`) around a planner:

```ts
import { createIndex, search } from "./experiments/engine";

const index = createIndex({
  documents: tools,
  id: (tool) => tool.name,
  describe: (tool) => summary(tool), // short text the wide rounds read
  detail: (tool) => fullText(tool), // description + parameters for the deciding question
});

const { hits, plan } = await search(index, { state: `User request: ${request}`, limit: 5 });
// plan: "direct" | "tournament" | "fallback"; every hit carries its probability and stage
```

It asks the whole pool in one hedged question when it fits. Otherwise it runs parallel chunk
requests, narrows the field to 8 finalists on short text and decides on full text. It retries only
retryable errors and returns the fallback ranking instead of throwing on capacity errors.

It is **experimental and not published to npm**. Its defaults come from two catalogs (MetaTool and
LiveMCPBench), and the MetaTool defaults lost by 19 points on real MCP tools before they were fixed.
Measure it on your own catalog before you trust it. `research/30-library-plan.md` lists what a real
library would still need: a built-in lexical fallback, an account-wide rate limiter, requests that
need several tools, more catalogs.

## Method notes

- hit@1 (any tool the task needs), recall@5, MRR@20, nDCG@5. 95% percentile bootstrap intervals,
  paired bootstrap for differences between arms on the same tasks.
- Compare arms only within one run, or interleave them. Jev's capacity errors varied between runs
  on the same day, and cross-run comparisons of failure-sensitive arms are confounded with time.
- A task that never gets an answer counts as a miss. Latency is the successful attempt's and excludes
  one-off index builds. Cost is the gateway's list price (`marketCost`), not what an account was billed.
- The FastMCP-style search is a TypeScript port of FastMCP's
  [JevSearchTransform](https://github.com/PrefectHQ/fastmcp/pull/5170): chunks of 150 tools on
  one-line summaries keep their top 8, then a close read over full details with a per-candidate fit
  check (threshold 0.3).

## Data and licenses

Code is MIT (see `LICENSE`). The vendored datasets keep their own licenses:

- `data/livemcpbench/`: [LiveMCPBench](https://github.com/icip-cas/LiveMCPBench), Apache-2.0,
  pinned commit and Hugging Face revision.
- `data/neuronto-distractors/`: a seeded sample of 1,500 tools from
  [Neuronto Verified MCP Tools](https://huggingface.co/datasets/AgenticResourceDiscovery/verified-mcp-tools),
  CC-BY-4.0. Attribution: "Neuronto Agentic Resource Discovery (ARD) Index, neuronto.com".
- `data/metatool/`: a sample of [MetaTool](https://github.com/HowieHwong/MetaTool), MIT (see its
  `LICENSE`).

Every task also carries the query Claude Haiku 4.5 wrote when handed the AI SDK's `toolSearch()`
tool, which is what a lexical index sees in an agent loop.

The research notes in `research/1*.md` were written by research agents and fact-checked by a second
agent against primary sources (see each note's verification log). Treat them as sourced notes, not
as settled facts.
