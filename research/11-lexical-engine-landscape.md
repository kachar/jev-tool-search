# Lexical engine landscape: what a packaged search primitive needs

Research date: 2026-09-25. Scope: "BM25 as a library" (Orama and its peers) and the tool-search packages built on top of it, read for what a Jev search library would have to copy or avoid. This note does not repeat 03 (Jev and `experimental_evaluate`) or 04 (Anthropic/OpenAI tool search, StackOne/Stacklok/Arcade numbers, FastMCP `JevSearchTransform`). Numbers are quoted from the linked page or measured here. Where they came from my own run, the note says "measured". Anything not checked at a primary source is marked UNVERIFIED.

## TL;DR

- **Orama is not a BM25 library. It is a small document database with a typed schema, and BM25 is its default scorer.** The API is `create({ schema }) → insert/insertMultiple → search(db, { term, properties, boost, tolerance, threshold, relevance: { k, b, d } })`. BM25 can be swapped for two in-house scorers (QPS, PT15) through plugins, and hybrid/vector search uses the same `search()` call with `mode: 'hybrid'`. The part worth copying is one call shape with pluggable scoring behind it.
- **Orama's project has split.** The founder left on 2026-02-27. The original engineering team forked it in July 2026 as **ZBSearch** (`zbsearch`, 4.0.0), which reached 491,017 downloads in the week of 2026-09-07. `@orama/orama` has published nothing since 3.1.18 on 2025-12-19, and it still had 825,562 downloads in the week of 2026-09-15..21. The commercial side (Orama Cloud, OramaCore) is a Rust rewrite under AGPL-3.0, sold as a hosted "context server". **Any tool-search stack that pins `@orama/orama`, ours included, depends on a package with no releases in nine months.**
- **The "less than 2kb" claim is false for real use.** Measured here with esbuild min+gzip, importing `create/insert/search`: Orama 3.1.18 is 21,695 B and zbsearch 4.0.0 is 25,777 B. Against MiniSearch 5,887 B, Lunr 8,857 B, wink-bm25 3,525 B, FlexSearch 17,230 B and okapibm25 754 B.
- **Defaults matter more than the choice of library.** On our 199-tool MetaTool catalog, raw user requests (398 single-tool queries), each library's default hit@1 (measured) was: Orama 15.1%, FlexSearch 15.6%, MiniSearch 32.2%, wink-bm25 38.4%, Lunr 47.2%, okapibm25 47.5%. Orama with English stemming plus stopwords rose to 31.2%. Our earlier "BM25 = 15.8% on raw words" number describes Orama's defaults and tuning, not BM25 in general. The blog post should say so, and the benchmark should add a well-configured BM25 arm.
- **Latency is not where libraries compete at tool-catalog scale.** For 199 tools, every library builds its index in under 10 ms and answers in about 20–120 µs p50 (measured). The only exception is okapibm25, which rescans the corpus on every query (~0.9 ms). A Jev call costs 70–500 ms by the vendor's claim, so it is 3–4 orders of magnitude slower. The value a library adds is quality, fallback and caching, not speed.
- **Tool-search packages converge on one shape:** register tools once, expose `search(query, { topK, minScore })`, and return tool objects rather than document ids. Examples: AI SDK `toolSearch()` (no arguments, word matching, at most 5), Mastra `ToolSearchProcessor` (its own BM25, `topK` 5, `minScore`, `autoLoad`, `filter`), StackOne `@stackone/ai` (`search: 'auto' | 'semantic' | 'local'`, where auto tries the cloud first and falls back to local Orama BM25 + TF-IDF with alpha 0.2), and FastMCP transforms (in 04). **None of the TypeScript ones lets you plug in a scorer.** That gap is where a Jev library fits.
- **Reranker wrappers already exist as generic primitives, not as tool search.** The AI SDK's `rerank({ model, documents, query, topN })` works over strings or JSON objects and returns `ranking[{ originalIndex, score, document }]`. Python's `rerankers` (AnswerDotAI, 1,634 stars) is one `Reranker(...).rank(query, docs)` over cross-encoders and the Cohere/Jina/Pinecone APIs. qmd (tobi/qmd, 30,021 stars) packages BM25 + vector → RRF → LLM rerank locally, with a `rerank: false` switch and `candidateLimit` 40. I found no package that wraps a reranker specifically for tool selection.
- **Design patterns to copy:** a typed schema up front, index once/search many, serializable indexes, a scorer or backend behind a flag, a cheap local fallback when the remote call fails, a score floor (`minScore`/`threshold`) that allows empty results, and field boosts. The pattern nobody ships is an evaluation harness in the package. Libraries compete on speed benchmarks (FlexSearch, bm25s, Tantivy), not relevance. StackOne keeps a `scripts/benchmark-search.ts`, but it is not part of the API.

## Detailed findings

### 1. Orama: positioning, API, and what is actually open source

**Positioning.** The repo description and docs: "A complete search engine and RAG pipeline in your browser, server or edge network with support for full-text, vector, and hybrid search in less than 2kb" (https://github.com/oramasearch/orama, https://docs.orama.com/docs/orama-js). The docs say it is "entirely written in TypeScript, with zero dependencies", and that "A JavaScript runtime is the **only** requirement". `npm view @orama/orama dependencies` returns none.

**API shape** (README, https://github.com/oramasearch/orama):
- `create({ schema: { name: 'string', price: 'number', embedding: 'vector[1536]', meta: { rating: 'number' } } })`. There are 10 types: `string`, `number`, `boolean`, `enum`, `geopoint`, the four array forms, and `vector[<size>]`.
- `insert(db, doc)`, `insertMultiple`, `remove`, `update`. Search: `search(db, { term, properties, ... })` returns `{ elapsed: { raw, formatted }, hits: [{ id, score, document }], count }`.
- **BM25 parameters** via `relevance`: `k` default 1.2, `b` default 0.75, and `d` ("Frequency normalization lower bound", default 0.5) (https://docs.orama.com/docs/orama-js/search/bm25; raw source in https://docs.orama.com/llms-full.txt). The same defaults are hard-coded in `dist/esm/methods/search-fulltext.js` of 3.1.18. The docs frame `d` as BM25+, but the code is not textbook BM25+: `components/algorithms.js` computes `idf * (d + tf * (k + 1)) / (tf + k * (1 - b + b * fieldLength / averageFieldLength))`. BM25+ adds δ outside the fraction, so the floor does not shrink with document length. In Orama, `d` sits in the numerator and is divided by the length-normalized denominator (checked in the installed `@orama/orama` 3.1.18 package).
- **Threshold** defaults to `1`: "all the documents containing **either** the `"slim"` keyword **or** the `"fit"` keyword" are returned, so matching is OR (https://docs.orama.com/docs/orama-js/search/threshold). The 3.1.18 source agrees (`params.threshold ... : 1` in `search-fulltext.js`). Do not mix this up with OramaCore/Cloud, whose docs in the same llms-full.txt define the opposite scale: "threshold: 0 (default) - Returns all documents matching ANY search term", "threshold: 1 - Returns only documents matching ALL search terms".
- **Hybrid** uses the same `search()` with `mode: 'hybrid'`, `term` plus `vector: { value, property }`, `similarity` (default 0.8) and `hybridWeights`. The docs say "you can only search through one vector property at a time" (https://docs.orama.com/docs/orama-js/search/hybrid-search).
- **Pluggable scorer:** "Since version `3.0.0`, Orama allows you to change the default search algorithm (**BM25**) with two new plugins: **QPS** (Quantum Proximity Scoring) and **PT15** (Positional Token 15)", installed as `plugins: [pluginQPS()]` (https://docs.orama.com/docs/orama-js/search/changing-default-search-algorithm). The same page recommends "testing each one with your dataset and queries". Orama ships no harness for doing that.
- **Plugins** are objects with a `name` and hook functions such as `beforeSearch`, and async hooks are allowed (https://docs.orama.com/docs/orama-js/plugins/writing-your-own-plugins). Official plugins include Data Persistence (serialize/restore an index), Embeddings (TensorFlow.js, 512-dim, generated at insert and search time), Secure Proxy, Analytics, and Match Highlight (https://docs.orama.com/llms.txt).
- **A precedent for a remote model call inside a local engine:** Secure Proxy "allows you to perform vector and hybrid search securely on your browser by masking OpenAI … API keys when generating embeddings", and it needs "a free Orama Cloud account" (https://docs.orama.com/docs/orama-js/plugins/plugin-secure-proxy). The local library calls a hosted model to embed the query. That is structurally what a Jev scorer plugin would be.
- Language support: "Orama supports 33 languages out of the box in 8 different alphabets" (llms.txt). Stemming is off by default, and non-English stemmers come from `@orama/stemmers` (https://docs.orama.com/docs/orama-js/text-analysis/stemming).

**How OSS relates to Cloud and Core.** Per the Orama Cloud docs: "Orama 3.0 introduced answer engine and RAG capabilities… The current version of Orama, **Orama 4.0**, is a complete rewrite of the engine in Rust, which we called OramaCore. It's still open source, and now powers the cloud version of Orama" (https://docs.orama.com/docs/cloud). OramaCore is AGPL-3.0 with 261 stars and was last pushed 2026-04-14 (`gh api repos/oramasearch/oramacore`). Orama Cloud is described as a "context server" bundling full-text, vector, an embedding engine and an "Inference Engine" (https://docs.orama.com/docs/cloud/what-is-orama-cloud), and every Cloud project exposes an MCP server (https://docs.orama.com/docs/cloud/mcp-server). The JS library (`@orama/orama`, Apache-2.0 per the repo LICENSE) is the free funnel. The Rust engine is the product.

**Governance split.** Michele Riva, co-founder and CTO ("ex Co-Founder, CTO" in the ZBSearch README), published "My Last Day at Orama" on 2026-02-27: "We're approaching 500,000 weekly downloads on npm, and 10,200 GitHub stars… I hereby request that the Orama project be released back to the community… I cannot guarantee that the Orama project will remain public" (https://www.micheleriva.dev/writings/my-last-day-at-orama). ZBSearch's README: "a zero-bs fork of Orama maintained by **the original Orama team**… After Michele's departure, the entire engineering team left Orama". Riva himself is first on its list of eight maintainers, and the repo lives under his account (https://github.com/micheleriva/zbsearch; GitHub fork of oramasearch/orama, created 2026-07-08, 296 stars). npm: zbsearch was first published 2026-07-07, its latest is 4.0.0, and weekly downloads went from 332 (week of 07-06) to 491,017 (week of 09-07) (https://api.npmjs.org/downloads/range/2026-06-01:2026-09-21/zbsearch). `@orama/orama` latest is still 3.1.18, published 2025-12-19 (`npm view @orama/orama time`). The last commits on `oramasearch/orama` main are dated 2026-07-03. I did not identify which dependent drove the zbsearch jump (UNVERIFIED).

**Orama and agents/tool search.** I found no Orama blog post or doc about tool search for agents. orama.com/blog returned 404 on 2026-09-25, and the docs index (https://docs.orama.com/llms.txt) has no tool-search page. Orama's agent-facing surface is the Cloud MCP server and "answer engine". Orama shows up in tool search only through other people's code: StackOne's `@stackone/ai` depends on `@orama/orama`, and our own benchmark package pins `@orama/orama` 3.1.18.

### 2. Peer libraries

Adoption was pulled on 2026-09-25. npm is last-week downloads for 2026-09-15..21 (https://api.npmjs.org/downloads/point/last-week/<pkg>), PyPI is last week from https://pypistats.org/api/packages/<pkg>/recent, and stars come from `gh api repos/<repo>`. Bundle size was measured here with esbuild 0.25.10 (`--bundle --minify --format=esm`, then `gzip -9`), importing only the main entry.

| Library | Lang | Scoring | Deps | Weekly DL | Stars | Last release | min+gz (measured) |
|---|---|---|---|---|---|---|---|
| `@orama/orama` 3.1.18 | TS | BM25(+d), QPS/PT15 plugins, vector, hybrid | 0 | 825,562 | 10,563 | 2025-12-19 | 21,695 B |
| `zbsearch` 4.0.0 (Orama fork) | TS | same lineage | 0 | 491,017 (wk of 09-07) | 296 | 2026-08-11 | 25,777 B |
| `minisearch` 7.2.0 | JS | BM25+ ("[breaking change] Use the BM25+ algorithm", CHANGELOG) | 0 | 2,029,753 | 6,149 | 2025-09-16 | 5,887 B |
| `flexsearch` 0.8.212 | JS | its own contextual/positional index (not BM25) | 0 | 904,274 | 13,798 | 2025-09 | 17,230 B |
| `lunr` 2.3.9 | JS | BM25-style TF-IDF, stemmer + stopwords by default | 0 | 5,415,874 | 9,202 | 2023 (repo pushed 2024-07) | 8,857 B |
| `wink-bm25-text-search` 3.1.2 | JS | BM25 (`k1` 1.2, `b` 0.75, `k` 1), field weights | 4 | 21,799 | 74 | 2022-11-21 | 3,525 B |
| `okapibm25` 1.4.1 | TS | plain Okapi BM25 function over a string array | 0 | 32,042 | n/a | 2024-09-09 | 754 B |
| `fuse.js` 7.5.0 (for reference: fuzzy, not BM25) | JS | Bitap fuzzy | 0 | 9,848,576 | 20,494 | 2026-08 | 9,553 B |
| `bm25s` | Python | BM25 variants, eager sparse scoring (NumPy/Numba) | NumPy | 337,106 | 1,792 | pushed 2026-09-18 | n/a |
| `rank-bm25` | Python | Okapi/BM25L/BM25+ | NumPy | 2,262,915 | 1,395 | pushed 2026-05 | n/a |
| `tantivy` (py bindings) / tantivy (Rust) | Rust | BM25 "the same as Lucene" | n/a | 570,784 (PyPI) | 16,142 (Rust), 427 (py) | pushed 2026-09-24 | n/a |

API shapes, from the READMEs:
- **MiniSearch:** `new MiniSearch({ fields, storeFields })`, `addAll(docs)`, `search(q, { boost, fuzzy, prefix, combineWith, bm25 })`, `autoSuggest`. "Terms are downcased by default. No stemming is performed, and no stop-word list is applied" (https://github.com/lucaong/minisearch). It is serializable: the README does not describe this, but `src/MiniSearch.ts` defines `toJSON ()` and `static loadJSON (json, options)` (https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.ts).
- **FlexSearch:** `new Index()` / `new Document({ document: { id, index: [...] } })`, then `add`, `search(q, { limit, suggest })`, plus export/import and "Fast-Boot Serialization". The README claims "FlexSearch performs queries up to 1,000,000 times faster compared to other libraries". Its own table, which it says is "measured in terms per seconds", lists 50,955,718 in the "Query: Single" column for flexsearch against 29,445 for Orama and 30,589 for MiniSearch (https://github.com/nextapps-de/flexsearch). The benchmark is the vendor's own, on "Gulliver's Travels". Note that FlexSearch defaults to AND-like matching: I got 0% hit@1 until I set `suggest: true`.
- **Lunr:** a builder closure `lunr(function () { this.ref('id'); this.field('name'); this.add(doc) })` that produces an immutable index. `search(queryString)` uses a query syntax where `:`, `~`, `^`, `+` and `-` are operators, so raw user text must be escaped (https://github.com/olivernn/lunr.js). The index is immutable after build and serializable.
- **wink-bm25:** `defineConfig({ fldWeights, bm25Params })`, `definePrepTasks([...])` (you bring the tokenizer), `addDoc`, `consolidate()`, `search(text, limit, filter)`, `exportJSON`/`importJSON`. "JSON exported after consolidation is only good for search operation" (https://github.com/winkjs/wink-bm25-text-search).
- **bm25s:** `bm25s.tokenize(corpus, stopwords="en", stemmer=...)`, `BM25().index(tokens)`, `retrieve(query_tokens, k)`. It claims speedups "by orders of magnitude" over rank-bm25, measured in QPS on BEIR, single-threaded (https://github.com/xhluca/bm25s). LlamaIndex's `BM25Retriever` depends on `bm25s>=0.2.7.post1` (https://github.com/run-llama/llama_index/blob/main/llama-index-integrations/retrievers/llama-index-retrievers-bm25/pyproject.toml). LangChain's `BM25Retriever` wraps `rank_bm25.BM25Okapi`, and its default tokenizer is `text.split()` (https://github.com/langchain-ai/langchain-community/blob/master/libs/community/langchain_community/retrievers/bm25.py). ToolRet (in 04) used BM25s as its lexical baseline.
- **Tantivy:** a Lucene-style library in Rust. It claims "Tiny startup time (<10ms)" and "approximately 2x faster than Lucene" on its own search benchmark (https://github.com/quickwit-oss/tantivy). It is the "Lucene-lite" option. For tool catalogs of a few hundred documents it is overkill, but it shows the ceiling of the lexical-library category.

### 3. Measured: defaults and latency on our 199-tool catalog

Method: Node 24.19.0 on arm64 macOS. Data: `data/metatool/dataset.json`, 199 tools (name + description) and the 398 `single-*` queries, using the raw `request` text. Each library was indexed on name + description with its documented default settings. I used the ASCII tokenizer `[a-z0-9]+` only where the library requires you to bring one (wink, okapibm25). Lunr query operators were stripped. Timings come from `performance.now()` after 20 warm-up queries. This is one run; the latencies are indicative and not a rigorous benchmark.

| Library (defaults) | Index build | Query p50 | Query p95 | hit@1 (raw request) |
|---|---|---|---|---|
| Orama 3.1.18 | 6.39 ms | 121 µs | 237 µs | 15.1% |
| MiniSearch 7.2.0 | 2.83 ms | 101 µs | 287 µs | 32.2% |
| FlexSearch 0.8.212 (`suggest: true`) | 3.46 ms | 20 µs | 43 µs | 15.6% |
| Lunr 2.3.9 | 9.51 ms | 54 µs | 150 µs | 47.2% |
| wink-bm25 3.1.2 | 1.87 ms | 23 µs | 46 µs | 38.4% |
| okapibm25 1.4.1 (no index, rescans per query) | 0.18 ms | 856 µs | 2,018 µs | 47.5% |

Orama variations (same data, measured):

| Orama config | hit@1 |
|---|---|
| defaults, name + description | 15.1% |
| defaults, description only | 20.1% |
| defaults, one concatenated text field | 16.6% |
| `tokenizer: { stemming: true, stopWords: english }`, name + description | 31.2% |
| same, one concatenated text field | 34.2% |
| same, `relevance: { k: 1.5, b: 0.75, d: 0 }` | 30.4% |

Reading:
- The previous benchmark's raw-words Orama number (15.8%, tuned preset) matches Orama's out-of-the-box behavior, not a ceiling for BM25. Two untuned libraries (Lunr, okapibm25) land around 47% on the same raw text. The obvious suspects are Orama not removing stopwords by default combined with OR matching ("Can you help me…" words then dominate), and its per-field score summing. I did not trace the remaining gap between stemmed Orama (31–34%) and okapibm25 (47.5%) (UNVERIFIED cause).
- This weakens a "Jev 74.6% vs BM25 15.8%" headline. The honest comparison for the post is Jev 74.6% against a BM25 baseline somewhere in the 45–50% range on raw words. The benchmark should add a tuned BM25 arm (Lunr-like: stemming, stopwords, OR matching) before publishing.
- Latency: all indexed libraries are sub-millisecond at this size. What a library adds is relevance and robustness, not speed.

### 4. Tool-search packages for agents

| Package | Retrieval | API surface | Pluggable scorer? | Adoption |
|---|---|---|---|---|
| AI SDK `toolSearch()` (`ai`) | "local and case-insensitive, matching words in tool names and descriptions. Camel-case names are split… Name matches rank above description matches" | factory "takes no arguments", model input `{ query }`, "at most five matching tools", no schemas, empty → `{ tools: [] }` | No | ships in `ai` (https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-search) |
| Mastra `ToolSearchProcessor` (`@mastra/core`) | its own `BM25Index` (`packages/core/src/workspace/search/bm25`) plus name boosting | `new ToolSearchProcessor({ tools, search: { topK: 5, minScore: 0, autoLoad: false }, storage, ttl, filter })`, exposing `search_tools` + `load_tool` meta-tools | No (no scorer option in the reference) | `@mastra/core` 1,161,907/wk (npm search API) (https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/processors/tool-search-processor.mdx) |
| StackOne `@stackone/ai` | `search: 'auto'` (default) "tries semantic search first, falls back to local"; `'semantic'` throws if the API is unavailable; `'local'` is "BM25+TF-IDF only". Local fusion: "`alpha * bm25 + (1 - alpha) * tfidf`", "Default alpha = 0.2" (`DEFAULT_HYBRID_ALPHA = 0.2` in `src/consts.ts`). In the TF-IDF index the name is repeated three times for boosting; the Orama side keeps `name` as its own field. The semantic client has a 30,000 ms timeout | `toolset.searchTools(q, { topK, search })`, `searchActionNames` (names only), `getSearchTool().search(q, { topK })` returning a `Tools` collection with `.toOpenAI()` | Backend switch only (auto/semantic/local) | 43/wk npm, 30 stars; Python `stackone-ai` 112/wk (https://github.com/StackOneHQ/stackone-ai-node, `src/local-search.ts`, `src/semantic-search.ts`) |
| FastMCP transforms | regex / BM25 / Jev | see 04 | Yes (transform classes) | `fastmcp` 12,672,008/wk on PyPI |
| `opencode-tool-search`, `@openstellar/tool-search` | "BM25 and regex search to discover tools on demand" | OpenCode plugin | n/a | 237 and 177/wk |
| `@fractalizer/mcp-search` | "compile-time indexing and 5 search strategies — name, description, category, fuzzy, weighted-combined" with configurable weights | strategy interface | Yes (strategy interface) | 45/wk (npm readme) |
| `dsh-tool-search`, `@dsh-cc/tool-search` and similar | deferred registration + `ToolSearch` meta-tool for "DeepSeek Harness" | plugin | n/a | 9–569/wk each (npm search API) |
| LangGraph bigtool (Python) | embeddings via the LangGraph store (see 04) | `retrieve_tools_function` override | Yes (function override) | 3,310/wk PyPI |

Takeaways:
- Every package returns tools, not documents. The unit is "a tool the model can now call", often with a load/activate step: Mastra's `load_tool`/`autoLoad`, and the AI SDK queues discovered tools for "the next model step".
- An explicit empty result is common: AI SDK `{ tools: [] }`, Mastra `minScore`, StackOne `minScore`. A score floor is expected.
- StackOne is the only one with a documented remote-first, local-fallback mode. Given that Jev refused 48% of 199-option calls with HTTP 429 in our run, a fallback is a requirement for a Jev library.

### 5. Packages that wrap a reranker as a search API

- **AI SDK `rerank()`**: `rerank({ model: cohere.reranking('rerank-v4.0-pro'), documents, query, topN })`. `documents` "Can be an array of strings or JSON objects". It returns `ranking` as `{ originalIndex, score, document }`, plus `rerankedDocuments` and `originalDocuments`, and accepts `maxRetries` (default 2) and `abortSignal` (https://ai-sdk.dev/docs/reference/ai-sdk-core/rerank, https://ai-sdk.dev/docs/ai-sdk-core/reranking). Gateway lists `voyage/rerank-2.5` and Cohere rerank models (see 03). This is the closest existing API to a "Jev search" call. A Jev library could mirror its input/output shape so that swapping Voyage for Jev is a one-line change.
- **`rerankers` (Python, AnswerDotAI)**: "A lightweight, low-dependency, unified API to use all common reranking and cross-encoder models". It is one class, `Reranker('cohere', api_key=...)` / `Reranker('cross-encoder')` / `Reranker('flashrank')`, and one call, `rank(query, docs)` → `RankedResults`. It is extended by "a new class with a `rank()` function" (https://github.com/AnswerDotAI/rerankers). 1,634 stars, 7,831/wk on PyPI. This is the Python model for a pluggable-scorer registry.
- **qmd (tobi/qmd)**: "combines BM25 full-text search, vector semantic search, and LLM re-ranking—all running locally via node-llama-cpp with GGUF models". The pipeline is query expansion → BM25 + vector → RRF → LLM reranker, with `candidateLimit` "Max candidates to rerank (default 40)" and `rerank` "(default **true**); set false for RRF-only". It is exposed as a CLI, a library (`store.search({ query, rerank: false })`) and an MCP server (https://github.com/tobi/qmd). 30,021 stars, `@tobilu/qmd` 37,022/wk. This is the best example of a packaged "lexical shortlist, then model rerank" with a switch, but it targets documents, not tools.
- **Framework-internal rerankers**: LangChain.js `@langchain/cohere` (89,776/wk), TanStack AI Cohere adapter, `@memberjunction/ai-reranker` and others (npm search API, 2026-09-25). These are adapters inside frameworks, not standalone search engines.
- **None found** that wraps Cohere/Voyage rerank specifically as a drop-in tool-search engine. StackOne's own table cites "Reranker 40%+ top-1" but ships no reranker mode (see 04).

### 6. Design patterns a packaged search primitive has

| Pattern | Who does it | Evidence |
|---|---|---|
| Typed schema declared up front | Orama (`create({ schema })`, 10 types), wink (`fldWeights`), MiniSearch (`fields`) | READMEs above |
| Index once, search many; immutable or consolidated index | Lunr (builder → immutable), wink (`consolidate()`), FastMCP (rebuilds lazily on a hash of searchable text, per 04) | READMEs |
| Serialize/restore the index | Orama Data Persistence plugin, wink `exportJSON`/`importJSON`, FlexSearch export/import + Fast-Boot | docs/READMEs |
| Pluggable scorer | Orama QPS/PT15 plugins; `rerankers` `rank()` classes; FastMCP transforms; fractalizer strategy interface | docs/READMEs |
| Same call, different mode | Orama `mode: 'fulltext' \| 'vector' \| 'hybrid'`; StackOne `search: 'auto' \| 'semantic' \| 'local'`; qmd `rerank: boolean` | docs/READMEs |
| Remote model inside a local engine | Orama Secure Proxy (query embedding via Orama Cloud), Orama Embeddings plugin (local TF.js), StackOne semantic client | docs/source |
| Fallback on remote failure | StackOne `auto` (semantic → local), 30 s timeout | `src/semantic-search.ts`, README |
| Score floor / allow empty | Orama `threshold`, Mastra/StackOne `minScore`, AI SDK empty `tools` | docs |
| Field boosting | Orama `boost`, wink `fldWeights`, StackOne name ×3 (TF-IDF side), Mastra name boost | docs/source |
| Two-stage (cheap recall, expensive precision) | qmd (RRF → LLM rerank, 40 candidates), TypeSafe rerank cookbook (see 03) | README/03 |
| Caching | FastMCP index hash (04); qmd keeps models loaded and disposes contexts "after 5 min idle". I found no package that caches query → result for a remote scorer | README |
| Built-in evaluation harness | Nobody ships one as API. StackOne keeps `scripts/benchmark-search.ts` in the repo; Orama's docs tell users to test "with your dataset and queries"; speed benchmarks exist (FlexSearch, bm25s, Tantivy) | repo trees/docs |

## Implications for a Jev search library

1. **Copy Orama's shape, not its engine.** `createToolIndex({ tools, fields })` once, then `search(index, { query, topK, minScore, mode })` → `{ hits: [{ tool, score, probability }], elapsed }`. A `mode` of `'lexical' | 'jev' | 'hybrid'` maps directly onto what people already know from Orama's `mode` and StackOne's `search`.
2. **Ship a real lexical stage inside the package, and tune it.** The measurements show default Orama is the weakest BM25 we tried. A Lunr-style setup (stemming, stopwords, OR matching) or a small in-house BM25 like okapibm25/wink costs under 4 KB gzipped and gets about 47% hit@1 on raw words for free. Pinning `@orama/orama` also means depending on an unreleased-since-2025-12 package with a governance fight around it. zbsearch is the maintained fork, if an Orama-compatible engine is wanted at all.
3. **Two-stage by default, sized to Jev's limits.** Take the lexical top-k (k ≈ 20, where our run saw ~0% 429s), then a Jev `choice` over that k. Offer whole-catalog `choice` (≤255 options, 32k budget) as an opt-in that is chunked into ≤20-option calls, given the 48% 429 rate at 199 options. This mirrors qmd's `candidateLimit` and TypeSafe's own rerank cookbook.
4. **Fallback is not optional.** Follow StackOne's `auto` semantics: try Jev with a short timeout (StackOne uses 30 s; for search, a budget in the hundreds of ms is more reasonable, UNVERIFIED as a good number), and on a 429, timeout or missing key, return the lexical ranking with a `source: 'lexical'` flag so callers can log it.
5. **Use probabilities as the score floor.** Jev returns calibrated per-option probabilities and a `confidence` statistic (03). That gives a principled `minProbability` and a real empty result ("no tool fits"), which BM25 libraries can only approximate with `threshold`/`minScore`.
6. **Mirror the AI SDK surfaces.** Provide (a) a drop-in replacement for `toolSearch()` that accepts a scorer, since today's factory "takes no arguments", and (b) a `rerank()`-compatible adapter (`{ documents, query, topN }` → `ranking[{ originalIndex, score, document }]`) so Jev and `voyage/rerank-2.5` can be swapped in a benchmark or in production.
7. **Cache query → result.** No package does this for a remote scorer. Agent queries repeat within a session, and the catalog hash (FastMCP's trick) plus the normalized query makes a safe key.
8. **Ship the evaluation harness as a feature.** Nobody else does. A `evaluate(index, labeledQueries)` → hit@1/hit@5/MRR/abstention report, with the lexical and Jev arms side by side, would be the differentiator and would also defend the accuracy claim. Our `tool-search-bench` package is most of this already.
9. **Keep the in-process core zero-dependency and let `ai` be a peer dependency.** Orama's "zero dependencies" and "any JS runtime" are the parts of its pitch that held up. Its size claim did not.

## Open questions

1. Why does default Orama score 15.1% where okapibm25 scores 47.5% on the same raw text? Stopwords explain half of the gap (31.2% with stemming + stopwords). The rest, possibly per-field score summing or BM25+ `d`, is untraced.
2. Would a tuned lexical arm (~47%) change the benchmark's "BM25 top-20 then Jev" result (70.6%)? Recall@20 of a better BM25 is likely higher, so the two-stage arm might close on whole-catalog Jev (74.6%). Needs a run.
3. What drove zbsearch from ~1k to ~490k weekly downloads in August 2026? Probably a large dependent switching (UNVERIFIED). Is `@orama/orama` still maintained by Oramasearch, Inc.?
4. Does Orama's `d: 0.5` default (a numerator term, not textbook BM25+; see section 1) hurt short tool descriptions? Setting `d: 0` did not help here (30.4% vs 31.2%), but that was one configuration.
5. Is Jev's 429 behavior at high option counts a capacity artifact of launch week or a stable property? It determines whether whole-catalog mode can be the default.
6. FlexSearch's AND-by-default behavior was observed in our run, not quoted from its docs (UNVERIFIED wording). The MiniSearch serialization API is now confirmed in source.
7. Mastra's BM25 parameters were only partly read. `packages/core/src/workspace/search/bm25.ts` exposes a `k1` option and ships a `DEFAULT_STOPWORDS` English set, and `tool-search.ts` builds `new BM25Index({}, TOOL_SEARCH_TOKENIZE_OPTIONS)`. The default values of k1 and b were not read.

## Sources

- Orama README: https://github.com/oramasearch/orama
- Orama docs index and full text: https://docs.orama.com/llms.txt, https://docs.orama.com/llms-full.txt (sources in https://github.com/oramasearch/docs)
- Orama JS intro: https://docs.orama.com/docs/orama-js
- Orama BM25: https://docs.orama.com/docs/orama-js/search/bm25
- Orama algorithms (QPS/PT15): https://docs.orama.com/docs/orama-js/search/changing-default-search-algorithm
- Orama threshold: https://docs.orama.com/docs/orama-js/search/threshold
- Orama hybrid: https://docs.orama.com/docs/orama-js/search/hybrid-search
- Orama plugins: https://docs.orama.com/docs/orama-js/plugins, https://docs.orama.com/docs/orama-js/plugins/writing-your-own-plugins, https://docs.orama.com/docs/orama-js/plugins/plugin-secure-proxy, https://docs.orama.com/docs/orama-js/plugins/plugin-data-persistence
- Orama stemming: https://docs.orama.com/docs/orama-js/text-analysis/stemming
- Orama Cloud: https://docs.orama.com/docs/cloud, https://docs.orama.com/docs/cloud/what-is-orama-cloud, https://docs.orama.com/docs/cloud/mcp-server
- OramaCore: https://github.com/oramasearch/oramacore
- Michele Riva, "My Last Day at Orama" (2026-02-27): https://www.micheleriva.dev/writings/my-last-day-at-orama
- ZBSearch: https://github.com/micheleriva/zbsearch ; npm downloads range: https://api.npmjs.org/downloads/range/2026-06-01:2026-09-21/zbsearch
- MiniSearch: https://github.com/lucaong/minisearch (CHANGELOG.md for BM25+)
- FlexSearch: https://github.com/nextapps-de/flexsearch ; benchmark https://nextapps-de.github.io/flexsearch/
- Lunr: https://github.com/olivernn/lunr.js
- wink-bm25-text-search: https://github.com/winkjs/wink-bm25-text-search
- okapibm25: https://www.npmjs.com/package/okapibm25
- bm25s: https://github.com/xhluca/bm25s
- rank_bm25: https://github.com/dorianbrown/rank_bm25
- Tantivy: https://github.com/quickwit-oss/tantivy ; tantivy-py: https://github.com/quickwit-oss/tantivy-py
- LlamaIndex BM25 retriever deps: https://github.com/run-llama/llama_index/blob/main/llama-index-integrations/retrievers/llama-index-retrievers-bm25/pyproject.toml
- LangChain BM25Retriever: https://github.com/langchain-ai/langchain-community/blob/master/libs/community/langchain_community/retrievers/bm25.py
- AI SDK `toolSearch()`: https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-search
- AI SDK `rerank()`: https://ai-sdk.dev/docs/reference/ai-sdk-core/rerank ; guide https://ai-sdk.dev/docs/ai-sdk-core/reranking
- Mastra ToolSearchProcessor: https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/processors/tool-search-processor.mdx ; source `packages/core/src/processors/processors/tool-search.ts`
- StackOne AI SDK (Node): https://github.com/StackOneHQ/stackone-ai-node (README "Search Tool", `src/local-search.ts`, `src/semantic-search.ts`, `scripts/benchmark-search.ts`); Python: https://github.com/StackOneHQ/stackone-ai-python
- rerankers: https://github.com/AnswerDotAI/rerankers
- qmd: https://github.com/tobi/qmd
- opencode-tool-search: https://github.com/M0Rf30/opencode-tool-search ; @fractalizer/mcp-search: https://github.com/FractalizeR/mcp_servers
- npm downloads API: https://api.npmjs.org/downloads/point/last-week/{package} (2026-09-15..21); npm search API: https://registry.npmjs.org/-/v1/search
- PyPI stats: https://pypistats.org/api/packages/{package}/recent (fetched 2026-09-25)
- Own measurements: esbuild 0.25.10 bundle sizes and a Node 24.19.0 micro-benchmark over `data/metatool/dataset.json` (scripts in the session scratchpad, not committed)

## Verification log

Adversarial pass, 2026-09-25. For each claim I opened the primary source and tried to refute it.

| # | Claim | Verdict | Source checked |
|---|---|---|---|
| 1 | `@orama/orama` latest is 3.1.18, published 2025-12-19, with zero dependencies | CONFIRMED | `npm view @orama/orama time dependencies` (3.1.18 at 2025-12-19T22:14:30Z; no dependencies field) |
| 2 | `@orama/orama` had 825,562 downloads for 2026-09-15..21 | CONFIRMED | https://api.npmjs.org/downloads/point/2026-09-15:2026-09-21/@orama/orama |
| 3 | zbsearch first published 2026-07-07, 4.0.0 on 2026-08-11, weekly downloads 332 (wk of 07-06) to 491,017 (wk of 09-07) | CONFIRMED | `npm view zbsearch time`; https://api.npmjs.org/downloads/range/2026-06-01:2026-09-21/zbsearch, summed Monday-start weeks. The rolling 09-15..21 figure is 491,846 |
| 4 | ZBSearch is a fork created 2026-07-08 with 296 stars; README says "the original Orama team" and "the entire engineering team left Orama" | CONFIRMED, context added | `gh api repos/micheleriva/zbsearch` (fork of oramasearch/orama) and its README. Added that Riva is one of the listed maintainers |
| 5 | Riva's post dated 2026-02-27 with the quotes "approaching 500,000 weekly downloads… 10,200 GitHub stars", "released back to the community", "cannot guarantee…" | CONFIRMED; "founder" CORRECTED to co-founder | https://www.micheleriva.dev/writings/my-last-day-at-orama (curl with browser UA); ZBSearch README "ex Co-Founder, CTO" |
| 6 | Last commits on `oramasearch/orama` main are dated 2026-07-03 | CONFIRMED | `gh api repos/oramasearch/orama/commits` |
| 7 | OramaCore is AGPL-3.0, 261 stars, last pushed 2026-04-14; Cloud docs say "Orama 4.0, is a complete rewrite of the engine in Rust" | CONFIRMED | `gh api repos/oramasearch/oramacore`; https://docs.orama.com/llms-full.txt line 23 |
| 8 | `@orama/orama` is Apache-2.0 per the repo LICENSE | CONFIRMED | LICENSE.md in oramasearch/orama ("Licensed under the Apache License, Version 2.0"). The GitHub API reports NOASSERTION only because it cannot parse the file |
| 9 | BM25 defaults k 1.2, b 0.75, d 0.5, and "d makes it BM25+" | CORRECTED | Defaults confirmed in the docs and in `search-fulltext.js` (3.1.18). The formula in `components/algorithms.js` puts `d` in the numerator, not as BM25+'s additive term |
| 10 | Threshold default is 1 and means OR matching | CONFIRMED, caveat added | https://docs.orama.com/docs/orama-js/search/threshold and 3.1.18 source. OramaCore docs use a reversed scale (default 0 = any term) |
| 11 | QPS/PT15 quote "Since version `3.0.0`…" and "testing each one with your dataset and queries" | CONFIRMED | llms-full.txt lines 4656, 4758 |
| 12 | Hybrid `similarity` defaults to 0.8; "one vector property at a time" | CONFIRMED | llms-full.txt lines 5748, 5775; `DEFAULT_SIMILARITY = 0.8` in `trees/vector.js` |
| 13 | "33 languages out of the box in 8 different alphabets"; stemming off by default; default stopword list empty | CONFIRMED | llms-full.txt line 6578; `components/tokenizer/index.js` (3.1.18): stemming disabled by default and `stopWords = []` unless supplied |
| 14 | "less than 2kb" is false: Orama 21,695 B, zbsearch 25,777 B, MiniSearch 5,887 B, okapibm25 754 B min+gz | CONFIRMED | Re-measured with esbuild 0.25.10 + gzip -9: 21,689 / 25,771 / 5,881 / 745 B (6–9 B less because of a smaller entry stub) |
| 15 | hit@1 on 398 raw single-tool queries: Orama 15.1, FlexSearch 15.6, MiniSearch 32.2, wink 38.4, Lunr 47.2, okapibm25 47.5 | CONFIRMED | Re-ran the original `bench.mjs` with `SUB=single` against `data/metatool/dataset.json` (199 tools, 398 single queries): identical percentages |
| 16 | Latency "9–120 µs p50" | CORRECTED to about 20–120 µs | The note's own table (lowest p50 20 µs) and the re-run (19–116 µs) |
| 17 | FlexSearch table: 50,955,718 vs Orama 29,445 vs MiniSearch 30,589 "single-term queries/s" | CORRECTED (unit wording) | https://github.com/nextapps-de/flexsearch README: numbers are in the "Query: Single" column, "measured in terms per seconds" |
| 18 | AI SDK `toolSearch()`: "takes no arguments", case-insensitive word matching, camel-case split, name above description, "at most five", empty `{ tools: [] }` | CONFIRMED | https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-search (.md) |
| 19 | AI SDK `rerank()`: documents "Can be an array of strings or JSON objects", `maxRetries` default 2, `ranking` with `originalIndex` | CONFIRMED | https://ai-sdk.dev/docs/reference/ai-sdk-core/rerank (.md) |
| 20 | StackOne: auto tries semantic first and falls back to local; alpha 0.2; 30,000 ms timeout; name tripled; depends on `@orama/orama` | CONFIRMED; name-tripling CORRECTED (TF-IDF side only) | `gh api` on StackOneHQ/stackone-ai-node: README, `src/local-search.ts`, `src/consts.ts`, `src/semantic-search.ts` (`timeout = 30_000`), package.json, `scripts/benchmark-search.ts` exists |
| 21 | Mastra `ToolSearchProcessor`: topK 5, minScore 0, autoLoad false, filter, `search_tools`/`load_tool`, its own BM25Index | CONFIRMED | tool-search-processor.mdx (defaults `5`, `0`, `false`); `tool-search.ts` imports `BM25Index` from `workspace/search/bm25` |
| 22 | qmd: `candidateLimit` default 40, `rerank` default true, "after 5 min idle", 30,021 stars, `@tobilu/qmd` 37,022/wk | CONFIRMED | https://github.com/tobi/qmd README lines 5, 180, 194–195; `gh api repos/tobi/qmd`; npm downloads API |
| 23 | rerankers quote "A lightweight, low-dependency, unified API…", 1,634 stars, 7,831/wk | CONFIRMED | The quote is the GitHub repo description (not the README); https://pypistats.org/api/packages/rerankers/recent |
| 24 | MiniSearch `toJSON`/`loadJSON` (was UNVERIFIED) | CONFIRMED | `src/MiniSearch.ts` lines 1519, 1843 |
| 25 | Stars/downloads in the peer table (minisearch 6,149, flexsearch 13,798, lunr 9,202, wink 74, fuse 20,494, bm25s 1,792, rank_bm25 1,395, tantivy 16,142/427; PyPI bm25s 337,106, rank-bm25 2,262,915, tantivy 570,784, fastmcp 12,672,008) | CONFIRMED | `gh api repos/...`; npm and pypistats APIs |
| 26 | wink defaults `k1` 1.2, `b` 0.75, `k` 1, 4 deps; LlamaIndex `bm25s>=0.2.7.post1`; LangChain `text.split()` + `BM25Okapi`; Tantivy "<10ms", "same as Lucene", "approximately 2x faster" | CONFIRMED | wink README line 115 and `npm view`; llama_index pyproject.toml line 36; langchain-community bm25.py lines 12, 55; Tantivy README lines 34, 35, 132 |

Counts: 21 CONFIRMED (rows 4 and 10 with added context), 5 CORRECTED (rows 5, 9, 16, 17, 20), 0 UNVERIFIED among the checked claims. Items still marked UNVERIFIED elsewhere in the note (what drove the zbsearch jump, the cause of the stemmed-Orama vs okapibm25 gap, FlexSearch AND-by-default wording, a good Jev timeout budget) were not resolvable from primary sources.
