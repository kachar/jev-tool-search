# Real-MCP benchmark (runs `mcp`, `mcp-abstain`, `agent-live-v2`, `agent-live-embed`, `agent-live`), 2026-09-25

LiveMCPBench (Apache-2.0): 525 real MCP tools from 69 servers, 94 of 95 tasks (one had no gold tool in the
catalog). Catalogs grown to 1,000 and 2,000 tools with a seeded Neuronto sample (CC-BY-4.0). A task counts as
right when the first result (or Claude's first real tool call) names any tool the task needs. 95% percentile
bootstrap intervals. Calls from Frankfurt: Jev, Voyage and embeddings through Vercel AI Gateway; Claude Sonnet
4.5 on Vertex AI (us-east5).

The earlier MetaTool run (further down this file) is superseded; its numbers are cited in the
post only as an older data point.

## Search only

| Size | Arm | Right first | 95% CI | Top 5 | p50 | p95 | $ / 1k | Refused calls | Errors |
|---|---|---|---|---|---|---|---|---|---|
| 525 | keyword@request | 19% | 12%-28% | 15% | 2 ms | 6 ms | $0.00 | 0 | 0 |
| 525 | keyword@keywords | 39% | 30%-49% | 34% | 2 ms | 2 ms | $0.00 | 0 | 0 |
| 525 | bm25@request | 11% | 5%-17% | 15% | 0 ms | 1 ms | $0.00 | 0 | 0 |
| 525 | bm25@keywords | 32% | 22%-41% | 25% | 0 ms | 0 ms | $0.00 | 0 | 0 |
| 525 | embed@request | 46% | 36%-56% | 50% | 295 ms | 381 ms | $0.01 | 0 | 0 |
| 525 | embed@keywords | 48% | 38%-57% | 43% | 289 ms | 356 ms | $0.00 | 0 | 0 |
| 525 | jev-search | 56% | 46%-67% | 51% | 2.5 s | 11.1 s | $1.03 | 207 | 0 |
| 525 | jev-search-ungated | 50% | 40%-61% | 62% | 2.3 s | 6.7 s | $1.03 | 183 | 0 |
| 525 | bm25-jev-20 | 40% | 30%-51% | 35% | 285 ms | 534 ms | $0.07 | 0 | 0 |
| 525 | bm25-jev-50 | 38% | 29%-49% | 38% | 294 ms | 1.4 s | $0.09 | 6 | 0 |
| 525 | bm25-jev-100 | 40% | 30%-50% | 38% | 311 ms | 1.7 s | $0.12 | 22 | 0 |
| 525 | bm25-jev-200 | 39% | 30%-50% | 39% | 311 ms | 1.6 s | $0.14 | 8 | 0 |
| 525 | embed-jev-search-100 | 52% | 41%-62% | 45% | 1.2 s | 6.1 s | $0.28 | 47 | 0 |
| 525 | bm25-jev-search-100 | 39% | 30%-49% | 30% | 557 ms | 1.6 s | $0.16 | 18 | 0 |
| 525 | bm25-rerank-20 | 45% | 34%-54% | 36% | 319 ms | 410 ms | $0.15 | 0 | 0 |
| 525 | rerank | 60% | 50%-69% | 58% | 787 ms | 1.2 s | $2.23 | 6 | 1 |
| 1000 | keyword@request | 15% | 9%-22% | 14% | 5 ms | 16 ms | $0.00 | 0 | 0 |
| 1000 | keyword@keywords | 34% | 24%-45% | 34% | 5 ms | 5 ms | $0.00 | 0 | 0 |
| 1000 | bm25@request | 6% | 2%-12% | 11% | 1 ms | 2 ms | $0.00 | 0 | 0 |
| 1000 | bm25@keywords | 28% | 19%-36% | 24% | 0 ms | 0 ms | $0.00 | 0 | 0 |
| 1000 | embed@request | 43% | 33%-52% | 46% | 294 ms | 400 ms | $0.01 | 0 | 0 |
| 1000 | embed@keywords | 47% | 36%-57% | 42% | 312 ms | 430 ms | $0.00 | 0 | 0 |
| 1000 | jev-search | 52% | 41%-62% | 51% | 6.5 s | 12.3 s | $2.20 | 682 | 0 |
| 1000 | jev-search-ungated | 44% | 34%-53% | 55% | 7.1 s | 12.1 s | $2.08 | 871 | 3 |
| 1000 | bm25-jev-20 | 37% | 28%-47% | 32% | 291 ms | 605 ms | $0.08 | 15 | 0 |
| 1000 | bm25-jev-50 | 40% | 31%-50% | 37% | 316 ms | 1.4 s | $0.12 | 12 | 0 |
| 1000 | bm25-jev-100 | 36% | 27%-46% | 37% | 450 ms | 3.4 s | $0.20 | 30 | 0 |
| 1000 | bm25-jev-200 | 38% | 29%-48% | 36% | 492 ms | 6.7 s | $0.29 | 64 | 0 |
| 1000 | embed-jev-search-100 | 48% | 37%-59% | 44% | 1.1 s | 4.2 s | $0.30 | 37 | 0 |
| 1000 | bm25-jev-search-100 | 38% | 29%-48% | 28% | 675 ms | 2.0 s | $0.23 | 13 | 0 |
| 1000 | bm25-rerank-20 | 41% | 32%-51% | 33% | 333 ms | 455 ms | $0.17 | 0 | 0 |
| 1000 | rerank | 55% | 46%-65% | 55% | 1.2 s | 1.5 s | $5.12 | 27 | 1 |
| 2000 | keyword@request | 13% | 6%-20% | 11% | 14 ms | 44 ms | $0.00 | 0 | 0 |
| 2000 | keyword@keywords | 31% | 21%-40% | 29% | 13 ms | 14 ms | $0.00 | 0 | 0 |
| 2000 | bm25@request | 6% | 2%-12% | 9% | 3 ms | 5 ms | $0.00 | 0 | 0 |
| 2000 | bm25@keywords | 28% | 19%-36% | 23% | 0 ms | 1 ms | $0.00 | 0 | 0 |
| 2000 | embed@request | 39% | 30%-49% | 41% | 298 ms | 410 ms | $0.01 | 0 | 0 |
| 2000 | embed@keywords | 40% | 31%-51% | 41% | 296 ms | 391 ms | $0.00 | 0 | 0 |
| 2000 | jev-search | 41% | 32%-52% | 44% | 7.0 s | 12.8 s | $4.30 | 1284 | 8 |
| 2000 | jev-search-ungated | 36% | 27%-46% | 54% | 8.3 s | 14.5 s | $4.45 | 1575 | 3 |
| 2000 | bm25-jev-20 | 30% | 20%-39% | 30% | 289 ms | 564 ms | $0.09 | 5 | 0 |
| 2000 | bm25-jev-50 | 34% | 24%-44% | 35% | 311 ms | 1.5 s | $0.15 | 8 | 0 |
| 2000 | bm25-jev-100 | 36% | 27%-47% | 36% | 467 ms | 3.3 s | $0.26 | 34 | 0 |
| 2000 | bm25-jev-200 | 33% | 23%-43% | 36% | 683 ms | 11.5 s | $0.44 | 110 | 1 |
| 2000 | embed-jev-search-100 | 44% | 33%-54% | 43% | 1.1 s | 4.2 s | $0.33 | 45 | 0 |
| 2000 | bm25-jev-search-100 | 37% | 28%-47% | 27% | 755 ms | 3.8 s | $0.27 | 36 | 0 |
| 2000 | bm25-rerank-20 | 38% | 29%-48% | 31% | 330 ms | 481 ms | $0.18 | 1 | 0 |

## Claude Sonnet 4.5 end to end (525 tools)

| Arm | n | Right first | 95% CI | Searches | Claude input tokens | p50 | p95 | $ / 1k |
|---|---|---|---|---|---|---|---|---|
| claude-bm25 | 94 | 52% | 41%-62% | 3.14 | 11,668 | 8.7 s | 26.1 s | $42.54 |
| claude-regex | 94 | 52% | 43%-62% | 3.16 | 12,658 | 9.0 s | 18.3 s | $45.13 |
| claude-jev | 94 | 56% | 47%-66% | 2.01 | 3,354 | 12.8 s | 49.6 s | $16.92 |
| claude-bm25-jev | 94 | 57% | 47%-67% | 2.02 | 4,394 | 7.4 s | 14.5 s | $18.15 |
| claude-embed-jev | 94 | 54% | 45%-64% | 2.16 | 3,390 | 8.6 s | 22.6 s | $15.48 |
| claude-all-tools | 30 | 67% | 50%-83% | 0.00 | 114,044 | 3.9 s | 7.5 s | $344.29 |

On the 30 tasks where every tool was loaded (same runs as the table): all tools 67%, built-in BM25 63%,
BM25 top 20 then Jev 63%, Jev search 53%, embeddings then Jev 53%, regex 53%.

Fit check at 525 tools: tasks with any right tool in the top five 94% ungated vs 82% gated (recall@5, the
share of a task's needed tools in the top five, 62% vs 51%).

## No tool fits (525 tools minus each task's servers)

| Arm | Returned nothing |
|---|---|
| keyword@keywords | 9% |
| bm25@keywords | 7% |
| embed@keywords | 0% |
| jev-search | 29% |
| embed-jev-search-100 | 33% |
| bm25-jev-search-100 | 57% |
| bm25-jev-20 | 7% |

## Paired differences in right-first (a minus b)

| Comparison | Difference | 95% CI |
|---|---|---|
| Claude + Jev vs Claude + BM25 | +4.3 pts | -6.4 to +17.0 |
| Claude + BM25→Jev vs Claude + BM25 | +5.3 pts | -4.3 to +14.9 |
| Claude + embeddings→Jev vs Claude + BM25 | +2.1 pts | -8.5 to +13.8 |
| Jev search vs BM25 (agent query) | +24.5 pts | +11.7 to +37.2 |
| Jev search vs embeddings (request) | +10.6 pts | -2.1 to +23.4 |
| Jev search vs Voyage rerank | -3.2 pts | -14.9 to +7.4 |
| Jev search vs BM25 at 2,000 tools | +13.8 pts | +1.1 to +26.6 |
| BM25 top 100 → Jev vs BM25 alone (525) | +8.5 pts | -3.2 to +19.1 |
| BM25 top 100 → Jev vs Jev search alone (525) | -16.0 pts | -27.7 to -4.3 |
| BM25 top 100 → Jev search vs Jev search alone (525) | -17.0 pts | -27.7 to -7.4 |
| Embeddings top 100 → Jev search vs Jev search alone (525) | -4.3 pts | -11.7 to +3.2 |
| BM25 top 100 → Jev vs BM25 alone (1000) | +8.5 pts | -3.2 to +19.1 |
| BM25 top 100 → Jev vs Jev search alone (1000) | -16.0 pts | -28.7 to -4.3 |
| BM25 top 100 → Jev search vs Jev search alone (1000) | -13.8 pts | -23.4 to -4.3 |
| Embeddings top 100 → Jev search vs Jev search alone (1000) | -4.3 pts | -12.8 to +4.3 |
| BM25 top 100 → Jev vs BM25 alone (2000) | +8.5 pts | -3.2 to +20.2 |
| BM25 top 100 → Jev vs Jev search alone (2000) | -5.3 pts | -18.1 to +7.4 |
| BM25 top 100 → Jev search vs Jev search alone (2000) | -4.3 pts | -14.9 to +6.4 |
| Embeddings top 100 → Jev search vs Jev search alone (2000) | +2.1 pts | -7.4 to +11.7 |

## Shortlist ceilings (share of tasks with a right tool in the top K)

| Source | Size | K=5 | K=20 | K=50 | K=100 | K=200 |
|---|---|---|---|---|---|---|
| bm25 | 525 | 47% | 69% | 72% | 72% | 72% |
| bm25 | 1000 | 45% | 64% | 72% | 72% | 72% |
| bm25 | 2000 | 45% | 63% | 69% | 72% | 72% |
| embeddings | 525 | 76% | 89% | 94% | 96% | 98% |
| embeddings | 1000 | 73% | 89% | 91% | 94% | 96% |
| embeddings | 2000 | 64% | 86% | 91% | 91% | 94% |

## Operational notes

- Jev refusals surfaced as "Service temporarily unavailable"; pinned to the typesafe-ai provider the gateway
  returned HTTP 429 "Provider is at capacity"; the digitalocean route refused every call. Jev's second week.
- AI Gateway's Anthropic-compatible endpoint accepted `tool_search_tool_bm25_20251119` and silently ignored it on
  the anthropic, bedrock and vertexAnthropic routes (Claude answered with text only). Vertex rawPredict ran it.
- Voyage rerank: "The number of documents cannot exceed 1,000." (docs.voyageai.com/docs/reranker).
- Search latency excludes one-off index builds (embedding a catalog), as production would pre-compute them.

---

# Benchmark results (run `main`, 2026-09-25)

MetaTool sample: 199 tools, 398 single-tool and 100 two-tool requests. Catalogs of 50, 100 and 199
tools (seeded samples; smaller catalogs keep only requests they can answer). Calls from Frankfurt
through Vercel AI Gateway.

## Single-tool requests, 199 tools (n = 398)

| Arm | hit@1 | recall@5 | p50 | p95 | $ / 1k |
|---|---|---|---|---|---|
| Keyword match (AI SDK toolSearch), user's words | 27.4% | 42.0% | <1 ms | 1 ms | 0 |
| Keyword match, agent's query | 44.7% | 65.8% | <1 ms | <1 ms | 0 |
| BM25 (Orama defaults), user's words | 15.8% | 36.2% | <1 ms | <1 ms | 0 |
| BM25 (Orama defaults), agent's query | 47.5% | 71.1% | <1 ms | <1 ms | 0 |
| BM25 (tuned), user's words | 15.6% | 37.4% | 2 ms | 4 ms | 0 |
| BM25 (tuned), agent's query | 43.2% | 71.9% | <1 ms | 1 ms | 0 |
| Jev, whole catalog | 74.6% | 89.9% | 473 ms | 845 ms | $0.28 |
| BM25 top 20, then Jev | 70.6% | 79.6% | 282 ms | 578 ms | $0.03 |
| Voyage rerank-2.5, whole catalog | 72.9% | 89.4% | 394 ms | 537 ms | $0.41 |
| BM25 top 20, then Voyage | 69.6% | 79.9% | 298 ms | 421 ms | $0.03 |

Jev's 74.6% counts 6 requests that failed all six attempts as misses; on the 392 it answered, 75.8%.

## Paired differences in hit@1, 199 tools (95% bootstrap interval)

| Comparison | Difference |
|---|---|
| Jev vs tuned BM25 (agent's query) | +31.4 pts [25.9, 36.9] |
| Jev vs Voyage rerank, whole catalog | +1.8 pts [-2.0, 5.5] (not significant) |
| Agent's query vs user's words, tuned BM25 | +27.6 pts [22.9, 32.4] |
| Tuned vs Orama defaults (agent's query) | -4.3 pts [-7.3, -1.5] |
| Jev whole catalog vs BM25 top 20 then Jev | +4.0 pts [0.5, 7.3] |

- BM25 recall@20 (the hybrid ceiling): 86% at 50 tools, 81.5% at 100, 80.2% at 199.
- Head to head at 199: Jev right and BM25 wrong on 144 requests, the reverse on 15, both wrong on 82.
- Jev and Voyage chose the same top tool on 76% of requests.
- Whole-catalog Jev vs the hybrid: 35 requests only the whole-catalog arm got right (27 of them outside BM25's top 20), 19 only the hybrid got right.
- Two-tool requests at 199 (n = 100), hit@1: Jev 81%, tuned BM25 50%, Voyage 60%.
- Repeat run (100 requests, 199 tools): Jev's top tool matched the first run on 95 of 97 answered;
  the 20-option hybrid on 100 of 100.

## Availability

Jev failures surfaced as "Service temporarily unavailable. Please try again shortly." A probe pinned
to the `typesafe-ai` provider returned HTTP 429 "Provider is at capacity"; the `digitalocean` route
refused every call. Share of calls refused, all requests:

| Question size | Refused |
|---|---|
| Jev, 50 options | 7.1% |
| Jev, 100 options | 19% |
| Jev, 199 options | 48.4% |
| Jev, 20 options (hybrid) | 0.4% |
| Voyage, 199 documents | 0.2% (1 malformed gateway response) |

Jev had been on AI Gateway since 2026-09-16; these numbers describe its second week.

## External numbers the post cites, checked at the source

- StackOne, 270 tools, 2,700 test cases, Orama BM25: right tool first 14%, top 5 87%; "Create a Jira
  ticket" returned `ashby_create_candidate`. stackone.com/blog/mcp-tool-search-bm25-tfidf-hybrid
- Anthropic: "Opus 4 improved from 49% to 74%, and Opus 4.5 improved from 79.5% to 88.1% with Tool
  Search Tool enabled"; the post does not say which variant. anthropic.com/engineering/advanced-tool-use
- AI SDK 7 `toolSearch()`: name hit 2, description hit 1, top 5 (read from `ai@7.0.112` source).
- Jev: $0.042 per million input tokens, output free; 64k tokens per request, 32k for state plus
  longest question (ai-gateway.vercel.sh/v1/models, 2026-09-25); up to 255 options per choice
  (docs.typesafe.ai/api.md).
- FastMCP ships an experimental `JevSearchTransform` (PrefectHQ/fastmcp#5170).
