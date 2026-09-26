# Experiments: what a Jev search library should do by default

Run 2026-09-25 (afternoon, CEST) from Frankfurt through Vercel AI Gateway (`typesafe-ai/jev`; both
providers in FRA1). Code: `experiments/`:

- `lib.ts`: the harness;
- `strategies.ts`: the algorithms;
- `run.ts`: the experiment groups;
- `analyze.ts`, `adjusted.ts`, `fusion.ts`: summaries;
- `lexical-recall.ts`, `judge-misses.ts`;
- `engine.ts`: the spike, with tests in `tests/engine.test.ts`.

Raw rows are in `results/exp-*.jsonl` and `judge-*.json` (git-ignored,
local only). Rows carry no timestamps; groups ran one after another or in parallel as noted.

Dataset: the MetaTool sample from the prior benchmark: 199 tools, 398 single-tool requests, catalog
seed 11. State is `User request: <the user's words>`; option text is the full tool description
(~90 characters) unless stated.

- hit@1 counts a query that failed every attempt as a miss; "answered-only" drops those.
- Intervals are 95% bootstrap over queries.
- "Paired" means paired by query. Pairs **within** one group were interleaved in time (the harness
  shuffles tasks). Pairs **across** groups were not, and capacity errors vary between runs, so
  cross-group differences in failure-driven arms are confounded with time. Sections 10–11 redo the
  head-to-head inside single groups.

Retry policy unless stated: 4 attempts, exponential backoff 1 s / 2 s / 4 s, SDK `maxRetries: 0`
so every attempt is ours and logged. "Refused" means an attempt that failed with HTTP 503
"Service temporarily unavailable" (`GatewayInternalServerError`, `isRetryable: true`).

## 1. Cardinality, with no retrieval confound

The right tool plus N−1 random distractors from the catalog, options shuffled per query (n = 398 per arm).

| Options | hit@1 | recall@5 | Refused attempts | p50 clean | Input tokens | ECE (top prob) |
|---|---|---|---|---|---|---|
| 20 | 90.7% [87.9, 93.5] | 98.5% | 0.3% | 285 ms | 965 | 0.030 |
| 50 | 85.7% [81.9, 88.9] | 97.0% | 4.8% | 288 ms | 1,925 | 0.040 |
| 100 | 79.4% [75.4, 83.2] | 93.7% | 13.5% | 293 ms | 3,515 | 0.061 |
| 150 | 75.1% [70.9, 79.4] | 90.7% | 29.7% | 441 ms | 5,116 | 0.072 |
| 199 | 73.4% [68.8, 77.6] | 88.4% | 39.8% | 450 ms | 6,685 | 0.054 |

- Accuracy falls with option count: about 17 points from 20 to 199 random options.
- Latency steps up between 100 and 150 options (≈290 → ≈445 ms for a clean call). This fits the
  launch blog's "2 stage-system" for high-cardinality choices, but that is an inference.
- The top probability is well calibrated on random distractors (ECE ≤ 0.07). It is worse on
  lexical shortlists (§4: ECE 0.15–0.19), where every option is a lookalike.

## 2. What drives capacity errors: request size

The 503 comes from TypeSafe AI (FRA1, whose hop answers in about 0.16 s per the Gateway log). The
Gateway then falls back to DigitalOcean (FRA1), which also fails.
At the client, a failed attempt takes a median of **672 ms** (p10 579, p90 774, n = 371), because
it includes that fallback. Across experiments, by request signature:

| Median input tokens per request | Examples | Refused attempts |
|---|---|---|
| 470–910 | shortlists ≤ 25 options, finals of 12–16, boolean fits | 0–2% |
| 1,160–1,580 | 33-tool chunks, finals of 24, 26–40-option shortlists | 1–5% (one bad window: ~10%, §11) |
| ~1,900 | 50-option chunks, 50 random options | 4.8–8.3% |
| 2,071 | 199 options, **names only** (criteria `null`) | 0.5% |
| 3,512 | 100 options | 13.5% |
| 5,116–5,366 | 150 options; 199 options with 60-char descriptions | 29.7–37.5% |
| 6,650–6,950 | 199 options with full descriptions, including 4 or 8 chunk questions in one request | 32–59% |

- Request size in tokens is the best single predictor we have, but it is not the whole story: 199
  name-only options (2.1k tokens) were refused only 0.5% of the time.
- **Batching chunk questions into one request does not help.** Four 50-option questions in one
  request were refused on 32–49% of attempts, and eight 25-option questions on 37%, against 54% for
  one 199-option question in the same group and 7–8% for four separate 50-option requests.
- The same 199-option full-description request was refused on 35–59% of attempts across groups
  on the same day (48.4% in the prior benchmark). These are load-shedding rates of a service in
  its second week, not constants.

## 3. Whole catalog: one question vs a tournament (first pass)

| Strategy (199 tools, one group) | hit@1 | Answered-only | Failed queries | Calls | p50 | p95 | $/1k (list) |
|---|---|---|---|---|---|---|---|
| One choice over 199, backoff retries | 67.8% | 75.4% | 40 / 398 | 1.0 | 778 ms | 9.4 s | 0.281 |
| Tournament, 4 parallel requests of 50, top 3 each → final of 12 | 71.6% | 71.6% | 0 | 5.0 | 863 ms | 2.5 s | 0.354 |
| Tournament, 4 chunk questions in one request → final | 66.1% | 71.5% | 30 | 1.9 | 983 ms | 6.5 s | 0.317 |
| Tournament, 8 chunk questions in one request → final | 66.6% | — | 40 | 1.9 | 1,043 ms | 9.8 s | 0.330 |
| 4 chunk questions, merge chunk probabilities, no final | 61.6% | — | 30 | 1.0 | 540 ms | 9.3 s | 0.286 |

Paired against the single call (same group): parallel tournament +3.8 pts [−0.3, 7.5], driven
entirely by the single call's failures; no-final merge −6.3 [−11.3, −1.3].

- **A final round is required.** Probabilities from different chunks are not comparable: merging
  them costs 6 points and wrecks calibration (ECE 0.30, mean top probability 0.96 vs accuracy 0.66).
- The right tool reached the final in 94.7% of queries (377 / 398). The single call's recall@5 is
  82.2% counting failures as misses and 91.3% on answered queries, so the shortlists are about
  equal. Given the right tool among 12 finalists, the final picked it 75.6% of the time.
- On answered queries the single call is more accurate (75.4% vs 71.6%). The tournament won end
  to end only because it never failed, and §10 shows fast retries remove that advantage.

## 4. BM25 shortlist, then Jev

Tuned BM25 (Orama 3.1.18, boosts, 1 edit of tolerance) on the agent's keywords, top-k to Jev.

| k | hit@1 | BM25 recall ceiling | Mean options sent | Refused | p50 | $/1k |
|---|---|---|---|---|---|---|
| 10 | 69.1% | 77.6% | 7.8 | 0.0% | 284 ms | 0.024 |
| 20 | 70.9% | 80.2% | 11.9 | 0.5% | 281 ms | 0.030 |
| 40 | 71.1% | 81.2% | 16.0 | 0.3% | 283 ms | 0.035 |
| 80 | 71.4% | 81.9% | 20.4 | 2.5% | 285 ms | 0.042 |

- Orama's default threshold returns only tools that share a term with the query (median 11, mean
  23 on this catalog). So most queries gain no options past k = 20, and the few that do (up to
  61–80 options at k = 80) are the requests that get refused (12% of them). 9 queries per arm had
  no BM25 match at all and made no call.
- Inside the shortlist Jev is right about 87% of the time (71.4 / 81.9). The ceiling belongs to
  the retriever.
- Top probability is overconfident on lexical shortlists (ECE 0.15–0.19: mean 0.88 vs accuracy 0.73).

Lexical first stage, recall@k (no model calls, `lexical-recall.ts`):

| First stage | Query text | recall@10 | recall@20 | recall@40 |
|---|---|---|---|---|
| Tuned preset (keywords as `string[]`) | agent keywords | 77.6% | 80.2% | 81.2% |
| Tuned preset | union of keywords and user words | 74.9% | 80.2% | 85.4% |
| Keywords joined into one string | agent keywords | 78.1% | 80.9% | 81.4% |
| Joined + stemming | agent keywords | 79.1% | 82.9% | 84.7% |
| Joined + stemming | union of keywords and user words | 75.1% | 81.9% | 87.2% |
| Tuned preset | user's words | 46.7% | 56.5% | 71.6% |

- The Orama `string[]` bug (note 10) barely moves recall (+0.7 pts). Stemming adds about 2.
- The union arms run with Jev (`union-40`, the engine's shortlist mode) used the tuned preset:
  85.4% ceiling. The stemmed variant (87.2%) was not run end to end.
- No BM25 configuration we tried puts the right tool into the shortlist more than about 87% of
  the time on this catalog.

## 5. Option text

| Option text (199 tools, one group) | hit@1 | Answered-only | Refused | Tokens |
|---|---|---|---|---|
| Full description (~90 chars) | 67.8% | 75.4% | 53.9% | 6,686 |
| First 60 characters | 71.1% | 73.1% | 37.5% | 5,369 |
| Name only | 47.0% | 47.0% | 0.5% | 2,074 |

- Names alone lose 21 points [−26.4, −15.6]. Jev needs descriptions.
- 60 characters cost about 2 points when answered, but get refused less. §11 repeats the
  comparison inside the engine: full text wins by 1.6–2.4 points.
- MetaTool descriptions are short (p10/p50/p90/max = 45/88/120/355 characters; 50 tools are under
  60). What truncation does to 400–1,200-character MCP descriptions is untested.

## 6. Option order

Same 199 options, shuffled per query vs catalog order, answered pairs only (n = 336):

- Same top tool on 300 of 336 (89.3%).
- **When both runs' top probability was ≥ 0.6: 241 of 241 agreed.** Every order flip happened on
  an uncertain answer. Order only matters below that line. A second, reversed call on those queries
  did not help, though (§8): the uncertain queries stay hard.

## 7. Abstention and the close read

Close read (FastMCP style): the whole-catalog choice, then one boolean "can this tool, on its own,
carry out the request?" per top-3 candidate, batched in one request. Out-of-catalog: the same
query with its right tool removed from the catalog (n = 398 each).

- **Re-ranking by the fit questions hurts:** 77.1% → 66.0% hit@1 on answered queries (n = 376).
- Separating in-catalog from out-of-catalog, AUROC: top probability 0.776; TypeSafe `confidence`
  0.777 (a monotone function of top probability at fixed n, so the same signal); max fit 0.731.
- At a top-probability floor of 0.5: 84% of answerable queries kept (85% of those correct by the
  plain choice; 74% after fit re-ranking), and 50% of unanswerable ones rejected. At 0.3: 96% kept
  (80% correct), 15% rejected.
- Measured on single whole-catalog calls only; tournament finals are lookalike sets and were not
  tested for abstention.
- Caveat: MetaTool has near-duplicate tools, so an "out-of-catalog" query often still has a tool
  that genuinely fits. These rejection rates are a lower bound.

## 8. Round 2: smaller parallel chunks, second looks, fusion, and what the misses are

| Strategy (199 tools, one group, n = 398) | hit@1 | Failed | Refused chunk attempts | Calls | p50 | p95 | Tokens | $/1k |
|---|---|---|---|---|---|---|---|---|
| 6 parallel requests (~33 tools, median 1,393 tokens), top 4 each → final of 24 (`t2-6x4`), fast retries | 73.6% [69.3, 78.1] | 0 | 3.6% | 7.0 | 820 ms | 1.45 s | 9,465 | 0.398 |
| Same + reversed second ask of the final when its top probability < 0.6 | 73.1% | 0 | 4.8% | 7.25 | 896 ms | 1.78 s | 9,753 | 0.410 |
| BM25 union (agent keywords + user words) top 40 → one choice | 70.9% | 0 | 2.2% | 1.0 | 296 ms | 614 ms | 1,675 | 0.070 |

Within this group: second look vs none −0.5 [−2.3, 1.5]. Against the single call from §3
(cross-group, confounded by §3's failures): `t2-6x4` +5.8 [2.0, 9.5]. §10 replaces that comparison.

- Smaller requests cut capacity errors: 3.6% of 33-tool chunk attempts refused, against 8.3% for
  50-option chunks (§3) and ~50% for one 199-option request. The finals of 24 were refused 2.5% of
  the time. The right tool reached the final in 96.7% of queries.
- **The second look is not worth it.** It fired on 98 of 398 queries and changed nothing measurable.
- **Fusing round-1 and final probabilities does not help** (`fusion.ts`, offline on the stored
  rows): final only 73.6%, final × round-1 72.9%, final + round-1 71.6%, round-1 only 58–63%
  depending on how its many ties are broken. Trust the final round's distribution.

### What the misses are: blind adjudication

MetaTool gives each request one label, and many catalogs have near-duplicates (`recipe_retrieval`
vs `DietTool`, `seoanalysis` vs `SEOTool`, `what_to_watch` vs `MediaTool`). For every miss, a judge
(`anthropic/claude-sonnet-5`, `judge-misses.ts`) saw the request and two tools, the label and the
arm's pick, in hidden order, and answered A, B or BOTH. Each miss was judged twice with positions
swapped. A miss counts as a defensible pick only if the judge preferred it **in both orders**.
Misses with no pick at all (no BM25 match, failed searches) were not judged and stay misses.

Controls:

- **Random tool:** with a random other tool in place of the pick, the judge preferred the label
  101 of 105 times.
- **Position swap:** normal and swapped orders agreed on 83–96% of misses.

| Arm (199 tools, same 398 requests) | Strict hit@1 | Picks judged better, both orders | Judge-adjusted hit@1 |
|---|---|---|---|
| Jev tournament `t2-6x4` (round 2) | 73.6% | 72 of 105 | 91.7% |
| Voyage rerank-2.5, whole catalog (prior run) | 72.9% | 48 of 108 | 84.9% |
| Tuned BM25, agent keywords (prior run) | 43.2% | 23 of 217 judged (9 had no match) | 49.0% |

Judge-adjusted, paired (cross-run for Voyage and BM25, whose rankings do not depend on capacity):

- tournament vs Voyage: +6.8 pts [3.3, 10.3];
- tournament vs BM25: +42.7 [37.2, 48.0].

Strictly scored, the tournament and Voyage tie: +0.8 [−3.0, 4.8].

- About two thirds of Jev's misses are defensible picks the single label misses. ~74% strict hit@1
  is close to this dataset's ceiling.
- Limitation: the judge is an LLM and may share Jev's preferences (both read descriptions the same
  way). The random-tool control rules out rubber-stamping, not shared taste. Human adjudication of
  a sample is the stronger check.

## 9. Retry policy

Whole catalog (199 options, the worst case), 200 queries, strategies interleaved in one group:

| Policy | hit@1 | Failed queries | p50 | p95 |
|---|---|---|---|---|
| Exponential backoff 1/2/4 s, 4 attempts | 65.5% | 24 (12%) | 792 ms | 9.35 s |
| Fast jittered retry 100–300 ms, 8 attempts | 72.5% | 5 (2.5%) | 1,216 ms | 4.05 s |
| Hedged: 2 identical requests per attempt, 100–300 ms jitter, 4 attempts | 73.5% | 4 (2%) | 466 ms | 2.26 s |
| One try, then the batched tournament on refusal | 72.0% | 2 (1%) | 511 ms | 4.04 s |

- A failed attempt costs ~0.67 s at the client (§2), so a 1/2/4 s backoff mostly adds waiting.
  Fast retries or hedging recover most refused queries.
- Hedging sends two requests per attempt. If both are billed, that is about $0.56 per 1k searches
  instead of $0.28. This is an estimate: the harness logs only the winner's usage.

## 10. Head-to-head, interleaved (the comparison that decides the default)

Every contender in one group, tasks shuffled, n = 398 each (`exp-final`).

| Strategy (199 tools) | hit@1 | Failed | Refused attempts | Requests | p50 | p95 | $/1k |
|---|---|---|---|---|---|---|---|
| One choice over 199, **hedged** (2 per attempt, 4 attempts) | **75.9% [71.6, 80.2]** | **0** | 21.7% | 1–4 | **460 ms** | 2.12 s | 0.281 (×2 if both hedges billed) |
| One choice over 199, fast retries (8 attempts) | 75.6% [71.4, 79.9] | 2 | 44.1% | 1–8 | 722 ms | 3.20 s | 0.281 |
| Tournament `t2-6x4` | 73.9% [69.6, 78.1] | 0 | 3.4% | 7 | 814 ms | 1.49 s | 0.398 |
| BM25 union top 40 → one choice | 70.9% [66.6, 75.4] | 0 | 2.7% | 1 | 292 ms | 638 ms | 0.070 |
| Engine spike, first rewrite (60-char options, 1,200-token chunks) | 68.6% | 1 | — | 7.5 | 722 ms | 1.53 s | 0.342 |
| Engine spike, shortlist mode (same defaults; split into 3 requests) | 68.1% | 0 | — | 3.0 | 608 ms | 1.17 s | 0.093 |

Paired against the hedged single call (same group), strict: fast retries −0.3 [−1.5, 1.0];
tournament −2.0 [−4.3, 0.3]; union-40 −5.0 [−8.3, −1.8]; first-rewrite engine −7.3 [−10.3, −4.3];
engine shortlist −7.8 [−11.8, −4.0].

Judge-adjusted (same protocol as §8, all arms judged in both orders, `adjusted.ts`):

| Arm | Strict | Adjusted | vs hedged single, adjusted |
|---|---|---|---|
| One choice over 199, hedged | 75.9% | **93.5%** | — |
| Tournament `t2-6x4` | 73.9% | 91.5% | −2.0 [−4.0, −0.3] |
| BM25 union top 40 → Jev | 70.9% | 88.4% | −5.0 [−7.8, −2.3] |
| Voyage rerank-2.5, whole catalog (prior run) | 72.9% | 84.9% | −8.5 [−11.8, −5.0] |
| Tuned BM25 (prior run) | 43.2% | 49.0% | −44.5 [−49.5, −39.4] |

- **Measured fairly, one whole-catalog question is the most accurate plan**, even while 35–55% of
  its attempts are refused, as long as refusals are retried fast or hedged. Splitting costs about
  2 points; a BM25 shortlist about 5.
- The tournament's advantage is reliability at a fixed request size and catalogs past one
  request. It is not accuracy.
- The first engine rewrite was worse than both. §11 finds why.

## 11. Engine ablation and the cascade

The first rewrite changed three things at once: 60-character options, a 1,200-token budget, and
calibrated token estimates. The calibration made a 40-option shortlist too big for one request,
so shortlist mode split it into a 3-request tournament. Ablation, interleaved, 250 queries
(`exp-ablation`, a worse capacity window: the hedged single call failed 18 of 250 here):

| Engine config (whole catalog) | hit@1 | vs hedged single | Requests | Mean tokens / request |
|---|---|---|---|---|
| Full text, 1,600-token chunks | 68.4% | −1.6 [−6.4, 2.8] | 7.0 | 1,354 |
| Full text, 1,200 | 67.2% | −2.8 [−8.0, 2.4] | 11.5 | 993 |
| 60 chars, 1,600 | 66.8% | −3.2 [−8.4, 2.0] | 6.0 | 1,254 |
| 60 chars, 1,200 | 64.8% | −5.2 [−10.4, 0.0] | 7.4 | 1,088 |
| Hedged single call | 70.0% (75.4% answered-only) | — | 1–4 | 6,686 |

- Full descriptions beat 60 characters at both budgets (+1.6, +2.4). Larger chunks beat smaller
  (+1.2, +1.6). Every interval overlaps (n = 250), but the direction is the same in all four cells.
  The engine at full text / 1,600 has the same shape as `t2-6x4` (6 chunks + final) and sits at
  the same distance from the hedged anchor (−1.6 here, −2.4 for `t2-6x4` on these 250 queries in §10).

The cascade (`engine.ts` now): one hedged whole-catalog question when the catalog fits
`directTokens`, the tournament if that is refused twice, then the fallback ranking. First
confirmation run (`exp-cascade`, interleaved, n = 398):

| Arm | hit@1 | vs hedged single |
|---|---|---|
| Hedged single call | 74.9% (8 failed) | — |
| `t2-6x4` | 74.4% | −0.5 [−3.3, 2.0] |
| Engine cascade, whole catalog | 71.9% | −3.0 [−5.8, −0.3] |
| Engine cascade, shortlist (40, one direct request) | 70.1% | −4.8 [−8.0, −1.8] |

The run exposed three engine bugs, fixed afterwards:

- **The direct plan never ran** (2 of 398). With `directTokens` at 7,000, the calibrated estimate
  of the full 199-tool catalog (~6.7k real) did not fit. Now 10,000.
- **7 searches hit the 5 s deadline under load.** Now 10 s.
- **3 requests failed with `Question "pick" did not select a highest-probability option`.** Jev's
  `choice` disagreed with its own rounded probabilities, and the SDK rejects that as invalid and
  non-retryable (3 of 2,891 requests). The engine now retries it.

Second confirmation run after the fixes (`exp-cascade2`, interleaved, n = 398):

| Arm | hit@1 | Judge-adjusted | Failed / fell back | Plans used | Requests | p50 | p95 | $/1k |
|---|---|---|---|---|---|---|---|---|
| **Engine cascade, whole catalog** | **75.9% [71.6, 80.2]** | **93.0%** | 0 thrown, 2 fell back | direct 337, tournament 59 (direct refused), fallback 2 | 1.92 | 538 ms | 2.96 s | 0.295 |
| Hedged single call | 75.1% [70.6, 79.4] | 92.0% | 4 failed | — | 1–4 | 497 ms | 2.66 s | 0.281 |
| Tournament `t2-6x4` | 74.4% [69.8, 78.4] | — | 0 | — | 7 | 1,041 ms | 2.40 s | 0.397 |

Paired against the hedged single call: engine +0.8 [−1.0, 2.5] strict, +1.0 [−0.8, 2.8]
judge-adjusted; tournament −0.8 [−3.3, 1.8]. 25.3% of the engine's request attempts were
refused (almost all on the 6.7k-token direct question), and it still never failed a search.
Hedged requests may be billed twice, which the $/1k column does not include.

The cascade keeps the direct question's accuracy and the tournament's reliability. It is the
engine default.

## 12. Real MCP tools: LiveMCPBench (the defaults did not transfer)

LiveMCPBench, the catalog of the "Picking the right tool" post: 525 real tools from 69 MCP servers,
94 human-annotated tasks. Description length p10/p50/p90/max = 28/61/598/3,841 characters, against
MetaTool's 45/88/120/355. Scored three ways, as in that post: exact (first tool is a listed tool),
server (first tool is on a needed server), and top 5 (any listed tool in the top five).
Code: `experiments/mcp-engine.ts` (`--set first`, `--set staged`) and `experiments/mcp-analyze.py`.

**First run** (`exp-mcp-engine`, interleaved, n = 94): the MetaTool defaults (full text, 1,600-token
chunks) against the post's FastMCP-style search.

| Arm | Exact | Server | Top 5 | Requests | $/1k | p50 / p95 |
|---|---|---|---|---|---|---|
| FastMCP-style Jev search (the post's) | 58.5% | 67.0% | 83.0% | — | ~1.03 (post) | 1.3 / 2.1 s |
| Embeddings top 100 → FastMCP-style search (the post's) | 55.3% | 68.1% | 74.5% | — | ~0.28 (post) | 1.0 / 7.2 s |
| Engine, whole catalog, full text | 39.4% (−19.1 [−29.8, −8.5]) | 54.3% | 76.6% | 44.8 | 2.67 | 3.3 / 10.0 s |
| Engine, whole catalog, 160-char options | 46.8% (−11.7 [−22.3, −2.1]) | 61.7% | 78.7% | 21.8 | 1.31 | 1.8 / 2.4 s |
| Engine, embeddings top 100 | 53.2% | 71.3% | 88.3% | 1.9 | 0.32 | 0.7 / 1.9 s |

With long descriptions, full text makes each 1,600-token chunk hold about a dozen tools. The
catalog splits into dozens of chunks, and the final compares lookalikes on the same text.
FastMCP's search reads a 160-character summary in its wide passes and the full description plus
parameters (1,200 characters) in a final over 8 finalists.

**Staged engine** (`exp-mcp-staged`, interleaved, n = 94): wide rounds read 160-character summaries.
A narrowing question cuts the field to 8, and the deciding question reads name, description and
parameters with the instruction "read what each tool actually does and what parameters it takes".
Three rows for `task-060`, an 18,686-character request that exceeded the per-request budget, were
rerun after the budget was made to stretch for long states (it had refused before any request).

| Arm | Exact | Server | Top 5 | Requests | $/1k | p50 / p95 |
|---|---|---|---|---|---|---|
| FastMCP-style Jev search (the post's) | 54.3% | 67.0% | 83.0% | — | ~1.03 (post) | 1.3 / 1.7 s |
| Engine staged, whole catalog | 52.1% (−2.1 [−10.6, 6.4]) | 63.8% | 88.3% | 25.6 | 1.51 | 2.3 / 3.5 s |
| Engine staged, whole catalog, 4k-token chunks | 48.9% (−5.3 [−14.9, 3.2]) | 63.8% | 89.4% | 10.0 | 1.19 | 1.3 / 1.9 s |
| **Engine staged, embeddings top 100** | **58.5% (+4.3 [−5.3, 12.8])** | **72.3%** | **91.5% (+8.5 [1.1, 16.0])** | 2.8 | **0.26** | 0.9 / 8.6 s |

- The staged final closes the whole-catalog gap from −19 to −2 (noise).
- Behind an embeddings shortlist, the staged engine has the best top 5 measured on this benchmark.
  The post's Voyage reranker had 86% top 5 (and 60% exact, still the best exact). Exact and server
  gains are inside the noise.
- The 8.6 s p95 of the embeddings arm is the Voyage embeddings call. The engine's own Jev time
  was p50 0.64 s, p95 4.2 s, with 0 refused attempts out of 264 on this day.
- The FastMCP-style search scored 58.5% and 54.3% in the two runs, and 56% in the post: with 94
  tasks, about ±5 points is run-to-run noise.
- Consequence for the defaults: option text is two-level, `describe` (short, wide rounds) and
  `detail` (rich, deciding question over `finalSize` = 8). "Full text everywhere", the MetaTool
  winner, lost on real MCP tools. Full descriptions beat 60-char options by ~2 on MetaTool, and
  lost to 160-char summaries by 7 on MCP. This is the one-catalog risk the plan named, measured.

## Cost note

The Gateway reported `cost: "0"` on every call. The Jev model page says "Promotional pricing ends
on September 25, 2026". The $/1k columns use `marketCost`, the list price of $0.042 per million
input tokens, and count only successful requests.
