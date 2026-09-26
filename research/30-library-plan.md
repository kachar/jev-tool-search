---
title: "Orama for Jev: a TypeScript search engine whose ranking is a Jev decision"
date: 2026-09-25
status: proposed
owner: Ilko Kacharov
evidence:
  - research/20-experiments.md
  - research/10-orama-architecture.md
  - research/11-lexical-engine-landscape.md
  - research/12-typesafe-docs-sweep.md
  - research/13-jev-prior-art.md
  - research/14-llm-ranking-theory.md
  - research/15-ai-sdk-integration.md
  - research/00-benchmark-results.md
---

# Orama for Jev

> **Update 2026-09-26:** on real MCP tools (LiveMCPBench, §12), the MetaTool defaults lost by 19
> points. With two-level option text (short summaries to narrow, description plus parameters to
> decide over 8 finalists), the whole-catalog gap closed to 2 points. Behind an embeddings top 100,
> the engine had the best top 5 on that benchmark (91.5%) at $0.26 per 1k searches. `engine.ts`
> now takes `describe` and `detail`. The rest of this plan predates that run.

"§n" points to a section of `research/20-experiments.md`; "note n" to
`research/n-*.md`. Every number is from MetaTool (199 tools, 398 single-tool
requests), measured from Frankfurt through Vercel AI Gateway on 2026-09-25, Jev's second week on
the Gateway. Treat the defaults as tuned on one catalog in one day.

## The question, and the short answer

"Can we do for Jev what Orama does for BM25?"

**Partly.** Orama packages an algorithm: zero dependencies, synchronous, deterministic, free,
in-process. Jev is a hosted model, so none of that can carry over. What can carry over is Orama's
shape, `create` / `insert` / `search` with a typed schema, wrapped around a client that:

1. plans requests around the hosted model's limits,
2. falls back instead of failing, and
3. ships the harness that proves the defaults on the user's own catalog.

On MetaTool, every sensible way to call Jev lands at 71–76% strict hit@1 (88–94% once a blind judge
forgives the dataset's single-label misses), against 43% for tuned BM25. The library does not
make Jev more accurate than a well-called single request. What it adds:

- the same accuracy with **0 failed searches** while Jev refuses 35–55% of large requests;
- a bounded p95;
- catalogs larger than one request can hold;
- a measured default per catalog size instead of guesswork.

The mistakes it prevents are expensive. Paired differences, in points of hit@1:

| Decision a raw `evaluate()` caller must make | Measured cost of the wrong choice (199 tools) |
|---|---|
| Retry policy | SDK-style backoff: 10–12% of searches fail, p95 9.4 s. Hedged fast retries: 0 fail, p95 2.1 s (§9, §10) |
| Option text | Names instead of descriptions: −21 (§5). 60-char truncation: about −2 (§10) |
| Splitting a big catalog | Merging chunk probabilities without a final round: −6.3 (§3) |
| Batching chunks | Four 50-option questions in one request were refused on 32–49% of attempts, against 7–8% as separate requests (§2) |
| "Does it fit?" close read | Re-ranking by per-candidate booleans: −11 (§7) |
| Trusting a BM25 shortlist | The shortlist never contains the right tool more than ~85–87% of the time. BM25 top 40 → Jev: −5 vs the whole catalog, judge-adjusted (§4, §10) |

## What Orama does for BM25, and what carries over

From note 10 (source read at v3.1.18 / v3.2.0) and note 11 (six libraries measured on our catalog):

| Orama property | Carries over to Jev? |
|---|---|
| One-line API: `create({ schema })`, `insert`, `search({ term })` | **Yes.** Same shape; `search` is async and takes `state` (the user's request), not a keyword `term`. |
| Typed schema, typed hits | **Yes.** Generic over the document type. |
| Zero dependencies, runs anywhere | **Mostly.** Peer-depends on `ai` for the evaluate call; runs wherever `fetch` does. |
| Instant index, no training | **Yes.** Indexing is rendering option text and estimating tokens. |
| Deterministic, inspectable scores | **No.** Jev is not deterministic: the vendor reports Noul std ≈ 0.01, and a Choice top pick flipped on 2 of 8 questions with a random field in the state (note 12). Our repeat run agreed on 95 of 97. Instead, every hit carries its probability, which stage produced it, the plan used, and whether the search fell back. |
| Free, sub-millisecond | **No.** 0.3–0.8 s p50, $0.06–0.40 per 1k searches at list price. The pitch is accuracy and reliability per dollar. |
| Pluggable scorers, hybrid mode, `beforeSearch`/`afterSearch` hooks | **Yes, inverted.** Jev can plug into Orama through `afterSearch`, and a lexical index plugs into the engine as fallback and shortlist. |
| `save` / `load` | **Partly.** The rendered catalog persists; responses are not worth caching (see Non-goals). |

Orama itself (note 11) has had no npm release since 3.1.18 (2025-12-19). Its co-founder and CTO
left in February 2026, the original engineers forked it as `zbsearch`, and the commercial product
is now a Rust rewrite. On this data its defaults score 15.1–15.8% hit@1 on raw requests, where Lunr
and okapibm25 reach 47% (the two figures come from different indexing of name and description). The
library should not depend on Orama: it ships its own small lexical fallback, and the Orama plugin
waits until someone asks for it.

## Prior art, and the gap

From note 13:

- **`vibiz-jev-search` 0.1.0** (npm, 2026-09-17, one version, no repository, 54 downloads/week)
  has its own BM25. With an agent query it takes the BM25 top 30 and asks one Jev choice with a
  `__none__` option. Without one, it sends the whole catalog (up to 254 tools). It includes an AI
  SDK `prepareStep` helper and falls back to BM25. Self-reported: 98% vs 82% top-1 on 55
  hand-written queries.
- **FastMCP `JevSearchTransform`** (Python, v4.0.6): a wide pass over chunks of ≤ 150, keeping 8
  per chunk until ≤ 24 remain, then a close read (choice plus per-candidate boolean, drop < 0.3).
  No lexical fallback. It reports 82% vs 30% top-1 on 374 model-written queries; the harness is not
  public. Our data argues against two of its choices: the close read (§7: −11) and small chunks
  when one request would do (§10).
- Every other tool-search implementation found shortlists or chunks well below 255 options
  (FastMCP 150, BuilderIO 128, pi-mcp-adapter 127, jev-gateway 120). None reports capacity errors.
  Our refusal-vs-request-size data (§2) appears to be new.
- The widely used TypeScript tool-search packages don't accept a custom scorer. AI SDK
  `toolSearch()` takes no arguments, Mastra's processor is BM25-only, and StackOne's is BM25/TF-IDF
  or its cloud. The only exception found is the tiny `@fractalizer/mcp-search` strategy interface
  (45 downloads/week) (notes 11, 15).

The gap is a maintained TypeScript library that:

1. searches the whole catalog, not only a lexical shortlist;
2. sizes and hedges requests so Jev answers them;
3. degrades instead of failing;
4. ships the harness that measures all of this on the user's catalog.

## Evidence the defaults rest on

The head-to-head arms ran **interleaved in time** (§10), because capacity errors vary by run. The
earlier cross-run comparisons overstated the tournament's advantage.

| Approach (199 tools, n = 398) | Strict hit@1 | Judge-adjusted | Failed searches | p50 / p95 | $/1k (list) | Source |
|---|---|---|---|---|---|---|
| Tuned BM25 on the agent's keywords | 43.2% | 49.0% | 0 | <1 ms | 0 | prior run |
| Voyage rerank-2.5 over all 199 | 72.9% | 84.9% | 0 (1 retried) | 394 ms / 537 ms | 0.41 | prior run |
| BM25 union top 40, then one Jev choice | 70.9% | 88.4% | 0 | 292 ms / 638 ms | 0.07 | §10 |
| Jev tournament: 6 parallel requests → final of 24 | 73.9% | 91.5% | 0 | 814 ms / 1.49 s | 0.40 | §10 |
| One Jev choice over all 199, backoff retries (SDK-like) | 67.8% | — | 40 | 778 ms / 9.4 s | 0.28 | §3 |
| One Jev choice over all 199, hedged fast retries | 75.9% | 93.5% | 0 | 460 ms / 2.12 s | 0.28–0.56 | §10 |
| **Engine spike (cascade: direct hedged → tournament → BM25)** | **75.9%** | **93.0%** | **0 (2 fell back)** | 538 ms / 2.96 s | 0.30–0.6 | §11 |

Paired, same group (§10, §11): against the hedged single call, the tournament costs −2.0 [−4.3, 0.3]
strict and −2.0 [−4.0, −0.3] adjusted, and the BM25-40 shortlist costs −5.0. The engine cascade
scores +0.8 [−1.0, 2.5] strict and +1.0 [−0.8, 2.8] adjusted against its own interleaved hedged
single call (a later window: 75.1% there). Adjusted, Jev leads Voyage by 6.8–8.5 points and BM25 by
about 44. Strictly, Jev and Voyage tie.

Judge-adjusted: a miss counts as correct when a blind judge (`anthropic/claude-sonnet-5`), asked
twice with positions swapped, preferred the arm's pick over MetaTool's single label both times.
Controls are in §8: against a random tool, the judge picked the label 101 of 105 times. The judge
is an LLM and may share Jev's taste, so treat the adjusted column as supporting evidence until
humans label a sample.

What moved the numbers, and what did not:

- **Helped:**
  - asking the whole catalog in one question whenever Jev answers it;
  - hedged fast retries (two identical requests, first wins; 100–300 ms jitter);
  - descriptions in the options (full beat 60 characters);
  - separate parallel requests with a final round when the catalog must be split;
  - larger tournament chunks (1,600 beat 1,200 tokens).
- **Did not help:**
  - batching chunk questions in one request;
  - merging chunk probabilities without a final;
  - a reversed second look when unsure (−0.5);
  - fusing round-1 into the final (−0.7 to −2.0);
  - per-candidate close reading (−11);
  - BM25 shortlists deeper than 20 (+0.5 at k = 80, where the extra 61–80-option requests get refused);
  - fixing the Orama `string[]` bug (+0.7 recall).

## Design

### Package

Working name `jev-search` (npm availability to check). ESM, TypeScript, Node ≥ 22 (AI SDK 7's
floor). Peer dependency: `ai` ≥ 7.0.105, pinned exactly in our own `package.json`. No other runtime
dependencies. The spike lives in `experiments/engine.ts` with tests in
`tests/engine.test.ts` (mock evaluation model).

### Core API (mirrors Orama)

```ts
import { createIndex, search } from "jev-search";

const index = createIndex({
  documents: tools,
  id: (tool) => tool.name,
  describe: (tool) => tool.description, // what Jev reads per option; required (names alone: −21 pts)
});
index.insert({ name: "calculator", description: "Evaluate arithmetic expressions" });

const result = await search(index, {
  state: "User request: what is 0.8723 to the power of 4?", // the user's request, not keywords
  limit: 5,
  fallback: bm25Order, // optional; the built-in lexical fallback is used when omitted (milestone 1)
});
// result.hits: [{ id, document, probability, stage: "final" | "round" | "fallback" }]
// result.plan: "direct" | "tournament" | "fallback";  result.degraded?: "direct refused"
// result.partial: some chunks failed and their best candidates advanced by fallback order
// result.requests: per-request options, tokens, failures, ms;  result.inputTokens, result.costUsd
// result.abstained: final top probability below minProbability (off unless the harness sets it)
```

`search` never throws on a capacity error. It returns `plan: "fallback"` with the reason, so callers
can log it. It **does** throw on configuration errors (unknown model, bad credentials, invalid
request: anything the SDK marks non-retryable), and on a state too long for the request budget,
before any network call. A misconfigured deployment must not quietly serve BM25.

### The planner: one search, as a cascade

1. **Render once at insert time.** Option text is `describe(doc)`, capped at `optionChars`
   (default 1,000: effectively the full description). Token cost per option is estimated from
   the text, then **calibrated from every response's real `usage.inputTokens`**. A fixed estimate
   under-counted by 12–30%. The state's tokens count against every request.
2. **Direct.** If the whole pool fits `directTokens` (default 7,000, the largest request size we
   measured), ask one choice question, hedged (2 identical requests, first answer wins), up to
   `directAttempts` (2). This is the most accurate plan (§10). Refused attempts come back in about
   0.67 s at the client (median, n = 371; the TypeSafe hop itself answers its 503 in about 0.16 s,
   and the Gateway then tries DigitalOcean), so two hedged attempts cost at most about 1.5 s.
3. **Tournament**, if the direct plan is refused or the pool is too big. Chunks are sized to
   `requestTokens` (default 1,600, full descriptions, 1–10% refused), balanced by tokens, never
   more than 255 options. The pool is shuffled by a stable hash first, so a catalog grouped by
   server does not put all lookalikes in one chunk. Each chunk is **its own parallel request**
   (at most `maxConcurrency` = 8 in flight). The top `keepPerChunk` (4) of each advance, and
   rounds repeat until the contenders fit one request, whose distribution decides. A failed chunk
   does not sink the search: its best candidates by fallback order advance, and the result is
   marked `partial`.
4. **Retries:** SDK `maxRetries: 0` (the SDK's own default waits 2 s, then 4 s). The library
   retries only errors the SDK marks retryable, with 100–300 ms jitter, 4 attempts per tournament
   request.
5. **Fallback:** if every path fails, or the deadline (default 5 s) passes, return the fallback
   ranking. Stragglers are aborted so nothing keeps spending after the result is returned.
6. **Hits past the finalists** come from round probabilities (`stage: "round"`, not comparable to
   final probabilities), then fallback order, so `limit` is honoured.
7. **Shortlist mode** (opt-in, `candidates`): the same cascade over a lexical shortlist. The
   union of BM25 over the agent's keywords and over the user's words, top 40, contained the
   right tool 85.4% of the time as run (87.2% with stemming and joined keywords, untested end to
   end). It costs about a fifth of the whole catalog. Choose it with the harness, per catalog.

Not in the planner, and why: no second look below 0.6 (§6, §8: −0.5); no probability fusion
across rounds (§8); no per-candidate fit questions (§7); no `__none__` option (below).

### Throughput and cost by catalog size

From measured token counts: about 34 tokens per full-description option, about 300 tokens of
instructions and state per request. List price $0.042 per million input tokens (promotional
pricing, under which the Gateway billed $0, "ends on September 25, 2026" per the Jev model page).
The account limit is 1,200 requests/min, which TypeSafe says "can change without notice".

| Catalog | Plan | Requests / search | Input tokens / search | $ per 1k searches | Searches/min at 1,200 RPM |
|---|---|---|---|---|---|
| 40 (shortlist) | direct, hedged | 2 | ~3.3k | ~0.14 | ~600 |
| 199 | direct, hedged (§10) | 2–3 | ~13–20k | ~0.56–0.84 | ~400–600 |
| 199 | tournament | 7 | ~9.5k | ~0.40 | ~170 |
| 1,000 | tournament, 3 rounds (27 chunks → 3 → final) | ~31 | ~47k | ~2.0 | ~39 |
| 2,000 | tournament, 3 rounds (53 chunks → 6 → final) | ~60 | ~94k | ~3.9 | ~20 |

Hedged requests are assumed billed twice; the harness logged only the winner's usage. Above
roughly 1,000 tools a shortlist first is the practical plan. The engine needs an account-wide rate
limiter (milestone 1), not just the per-search semaphore it has, and it must honour `Retry-After`
on a real 429 instead of jitter-retrying into its own limit.

### Abstention

`minProbability` is off by default. On the single whole-catalog call, top probability separates
in-catalog from out-of-catalog requests with AUROC 0.78 (§7). TypeSafe's `confidence` is
`clamp((n·p − 1)/(n − 1), 0, 1)`, which is the same signal at fixed n (note 12). A threshold does not
transfer across plans or catalog sizes (ECE 0.03–0.07 on random sets vs 0.15–0.19 on lexical
shortlists), and it was never measured on tournament finals. So the harness picks it from a
risk-coverage table on the user's labeled requests.

No `__none__` option by default. Kadavath et al. found that replacing an MMLU option with "none
of the above" reduced accuracy and calibration. TypeSafe's docs recommend such an option, and
jev-rerank-bench saw it over-abstain on answerable queries. It is untested on tool catalogs (notes
12–14), so it is a harness experiment, not a default.

### Adapters (0.1 ships only the first)

1. **AI SDK tool search.** `toolSearch()` cannot take a scorer, and it hides `deferLoading` tools
   from any other search. So the adapter returns a `search` tool plus a `prepareStep` that sets
   `activeTools` from the results. It needs a multi-step loop:
   ```ts
   const { tools, prepareStep } = jevToolSearch({ catalog: await mcpClient.tools() });
   await generateText({ model, tools, prepareStep, stopWhen: isStepCount(5), prompt });
   ```
   Jev gets the user's message as `state`: it scored 74.6% on raw words, while BM25 needs the
   agent's keywords (47% vs 16%). The shapes follow the signatures compiled in note 15 (names
   changed here; recompile before release). File upstream: `toolSearch({ search })`.
2. *Later, on request:* an Orama `afterSearch` plugin. It is prototyped in `engine.ts`. `state` is
   required, and the hook must be a native `async function` or Orama races it (note 10). Also
   later: a `RerankingModel` for `rerank()`, and an MCP `search_tools` + `call_tool` proxy (the AI
   SDK MCP client treats `tools/list_changed` as an error, note 15).

### Evaluation harness (ships in 0.1)

```ts
import { evaluateSearch } from "jev-search/eval";
const report = await evaluateSearch(index, labeledRequests, { plans: ["cascade", "shortlist"] });
```

The report covers:

- hit@1, recall@5, MRR;
- capacity errors by request size, fallbacks, partials;
- p50/p95;
- $/1k searches and searches/min at the account RPM;
- ECE and a risk-coverage table for `minProbability`;
- paired bootstrap between plans, run interleaved.

It is `packages/tool-search-bench` lifted, including the blind-judge step for single-label
datasets. No other tool-search package ships one (note 11), and it is how a user checks that the
defaults hold on their catalog.

## Non-goals (YAGNI)

- **No response cache.** Agent traffic rarely repeats the exact state, and a key over the whole
  catalog is invalidated by any insert. Revisit with a per-request key if a user shows repeats.
- **No embeddings stage.** The whole-catalog plan already covers what lexical recall misses.
- **Nothing beyond ranking over a catalog.** No scores, rubrics or verification wrappers.
- **No own HTTP client.** Use `experimental_evaluate`; revisit if the experimental API breaks in a
  patch release (it may, per its docs).
- **No server, no hosted index.**

## Risks

| Risk | Mitigation |
|---|---|
| Capacity errors change. They are 503 load shedding, not content refusals, and the same 199-option request saw 35–59% across runs in one day | Budgets are config; the harness reports errors by request size; the cascade adapts on its own (direct when answered, tournament when not) |
| If the size-dependent 503s go away, the direct plan wins outright | Already the default; the tournament then runs only for catalogs past `directTokens` |
| `experimental_evaluate` changes in a patch release | Exact pin, one call site, the harness as a regression test |
| Model updates (the Gateway catalog lists only `typesafe-ai/jev`; whether it accepts or reports a pinned version is unverified, note 12) | Rerun the harness on changes; log `response.modelId` when present |
| Account rate limit: 1,200 RPM, 7–60 requests per tournament search | Account-wide limiter, `Retry-After`, throughput in the harness report; shortlist first for large catalogs |
| Cost grows with catalog size in tournament mode (table above) | `costUsd` on every result; the harness prints $/1k per plan |
| Catalogs grouped by server (lookalikes in one chunk) | Stable-hash shuffle before chunking; test grouped order in the harness |
| Multi-tool requests: the "call first" instructions and top-k for `activeTools` were not tested on the 100 two-tool requests | Add the two-tool set to the harness before 0.1 |
| Long MCP-style descriptions (400–1,200 chars): MetaTool's median is 88 | Second catalog before 0.1 (milestone 2), with `optionChars` and budgets re-swept |
| Prompt injection through tool descriptions (Jev "does not treat [state] as hostile by default") | Document it. Descriptions from untrusted MCP servers can argue for their own selection, the same exposure as keyword stuffing in BM25 |
| Judge-adjusted numbers rely on an LLM judge that may share Jev's preferences | Report strict and adjusted side by side; human-label 50 misses before quoting adjusted numbers publicly |

## Milestones

1. **Core engine**, from `experiments/engine.ts`: the cascade, recursion, partial chunks, error
   classification, token calibration, and tests against the mock model (done in the spike). The
   spike already clears the accuracy bar: 75.9% vs 75.1% for an interleaved hedged single call,
   0 thrown errors, 2 fallbacks in 398 searches (§11). Still to do:
   - a built-in stemmed BM25 fallback;
   - an account-wide limiter with `Retry-After`;
   - a test that forces 100% refusals and checks that hit@1 equals the BM25 arm.

   Done when: on MetaTool 199, interleaved against a hedged single call, hit@1 is within the noise
   of it, and 0 searches throw.
2. **Second catalog** (500+ tools with long MCP-style descriptions, grouped by server) plus the
   two-tool requests. Re-sweep `directTokens`, `requestTokens`, `keepPerChunk` and `optionChars`,
   interleaved. This gates 0.1, because every default so far comes from one catalog and one day.
3. **AI SDK adapter** `jevToolSearch` with a live smoke test.
4. **Harness** `evaluateSearch`, ported from the bench package.
5. **Publish** 0.1.0 with the numbers in the README, and a blog post.


## Open questions

1. Do the request-size findings hold with long descriptions (milestone 2)?
2. What drives the 503s: tokens, options with non-null criteria, or server-side routing into a
   high-cardinality path? 199 name-only options were refused only 0.5% of the time at 2.1k tokens.
3. Where does direct stop being answered at all: 10k, 20k, or 30k tokens? We measured up to 6.7k.
4. Is a per-catalog calibration fit (temperature or isotonic) on top probability worth shipping, or
   is a risk-coverage table enough?
5. Upstream AI SDK request: `toolSearch({ search: (query, candidates) => Promise<string[]> })`.
