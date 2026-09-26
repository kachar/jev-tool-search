# 12 — TypeSafe docs sweep: what a Jev search/ranking library needs to know

Swept 2026-09-25. I fetched all 111 pages listed in https://docs.typesafe.ai/llms.txt as `.md` with curl, plus the TypeSafe OpenAPI spec, the public agent skill, every TypeSafe blog post in the sitemap, the Vercel TypeSafe-compatible API page and its 2026-09-21 changelog entry, the AI SDK TypeSafe provider page, and the published JS SDK bundle. This note adds to `research/tool-search/03-jev-model-and-evaluate-api.md` and `04-tool-search-landscape.md` and does not repeat them. Where a fact is already there, I only note what the docs add or contradict.

## TL;DR

- **Most cookbook numbers come from `jev-1.12`, not the current `jev-1.13.0`.** That includes skill suggestion, re-ranking, line-by-line search, hierarchical classification, parallel questions and classification-by-confidence. Only the two self-consistency cookbooks ran on `jev-latest` (sampled 2026-09-11; both report `jev-1.13.0` as the answering model for all 15 calls). The jaggedness page covers `jev-1.13` (reviewed 2026-09-17). ([skill_suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), [rerank](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), [consistency_noul](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md))
- **Probabilities come back rounded to two decimals.** This comes from the AI SDK provider docs, and every TypeSafe example is consistent with it. On a 199-option Choice, most options should read `0.00` (our inference from the rounding; the docs show no example that large), so the ranking past the first few options is a pile of ties. Recall@k and MRR computed from a single Choice past its non-zero head are not meaningful. ([AI SDK TypeSafe provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai.md))
- **`confidence` has a closed form.** The docs' interactive widget computes `(n·p_max − 1)/(n − 1)`. This reproduces every documented Choice and Score confidence I checked (7 of 7, within rounding). The value depends on `n`: at 199 options, a top option at p=0.5 gives confidence ≈0.50, and at 3 options the same p gives 0.25. ([confidence](https://docs.typesafe.ai/confidence.md), raw page source)
- **Questions in one request are answered independently.** State is ingested once. The docs repeat this on several pages, and the parallel-questions cookbook tests it: 13 questions over a ~54k-character article gave the same answers batched or one per call for 11 of 13 questions (std 0.0); the two noisy Nouls differed slightly (`breach_72h` mean 0.804 vs 0.814; `criminal_penalties` std 0.0045 vs 0.0084), which the cookbook attributes to per-question sampling noise. Batching was 12.2x cheaper and 10.0x faster in summed latency (both averaged over 5 runs). The primitives page quotes different figures for the same experiment: "11.5x cheaper and 9.6x faster". ([primitives](https://docs.typesafe.ai/primitives.md), [parallel_questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md))
- **Choice limits in TypeSafe's own words:** "maximum of 255 options per Choice" ([api](https://docs.typesafe.ai/api.md)), "adding options costs a few tokens each, so give the model the full list" ([choice](https://docs.typesafe.ai/primitives/choice.md)), and "a Choice works reliably up to roughly 240 options" ([classification_using_confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)). The only per-option token figure is "a few tokens each"; the docs give no number.
- **The "2-stage system of scoring independently then making an explicit choice" appears once,** in the launch blog, as a note on the Wikiracing demo (hundreds to thousands of links per step). It reads as demo-side code for pages with more than 255 links. It does not say the server does this. UNVERIFIED either way. ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev))
- **Score levels are judged independently** ("Every level is evaluated separately. The model doesn't see a level's number or its neighbours"). The docs never say the same about Choice options. ([score](https://docs.typesafe.ai/primitives/score.md))
- **Choice and Noul answer different questions.** "the Choice is relative, settling *which* option, while each Noul is absolute and can be low for all of them" ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)). Both the skill-suggestion and line-by-line-search cookbooks pair a Choice (ranking) with Nouls (should we return anything). This is the vendor's pattern for abstention.
- **Client SDKs:** `@typesafe-ai/sdk` 0.6.0 (npm, Node ≥20, zero dependencies) and `typesafe-sdk` 0.7.1 (PyPI, Python ≥3.10). They add typed questions and answers, retries with backoff that honor `Retry-After` (defaults: 2 retries, 408/429/5xx), and timeouts. They do **not** batch states, cache, dedupe, or limit concurrency; I checked the JS bundle directly. ([sdk/javascript](https://docs.typesafe.ai/sdk/javascript.md), [python retries](https://docs.typesafe.ai/sdk/python/api/retries.md), [npm bundle](https://cdn.jsdelivr.net/npm/@typesafe-ai/sdk@0.6.0/dist/index.mjs))
- **Rate limits:** 250,000 tokens/s and 1,200 requests/min for `jev-1.13.0`, but "adjusting dynamically … can change without notice". `429` means your rate limit and `529` means TypeSafe is overloaded. Our benchmark saw Gateway return 429 with "provider at capacity", which looks like the Gateway reporting a 529-type condition under a 429 code. That mapping is our reading and is UNVERIFIED. ([models](https://docs.typesafe.ai/models.md), [api](https://docs.typesafe.ai/api.md))
- **Vendor search numbers are small-n.** Re-ranking: 40 queries, BM25 top-30, 1,200 single-Noul calls, top-1 5%→18%, i.e. 2→7 queries. Hierarchical beam K=3: 4 examples, beam 4/4 vs greedy 2/4. Classification by confidence: 60 filings, 75-way Choice, 39/60 top-1. Skill suggestion reports agent error rates, never Jev's own top-1 over 182 skills.

## Detailed findings

### 1. The API shapes: native vs Gateway vs AI SDK

Native endpoint ([api](https://docs.typesafe.ai/api.md), [OpenAPI 0.2.0](https://api.typesafe.ai/openapi.json)):

- `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer`. Body: `state` (string | object | array; required), `model` (required in the OpenAPI spec, defaulted by the SDKs), and `questions` (a map, `minProperties: 1`).
- Question fields: `type` ∈ `noul|choice|score`, `instructions` (string | object | array | null; the question ID "is not sent to the underlying model"), and `criteria`:
  - Choice: a map of option → string | object | array | null.
  - Score: an ordered array.
  - Noul: optional `{true, false}`.
- Response: `model` (the versioned ID, e.g. `"jev-1.13.0"`), `answers` keyed by your IDs, and `usage {input_tokens, output_tokens}`.
  - Choice answer: `choice`, `probabilities` (all options), `confidence`.
  - Score answer: `score` (probability-weighted mean of level indices), `legend`, `probabilities`, `confidence`.
  - Noul answer: `noul` only.
- The OpenAPI spec encodes neither the 255-option cap nor the 10-level cap. Its Score `criteria` has `minItems: 1`, while the docs say "at least two levels; the API accepts up to 10". The JS SDK enforces at least 2 Score levels on the client and has no option-count check. The Choice `probabilities` description says "values sum to approximately 1".
- `GET /v1/models` lists aliases only. Versioned IDs are accepted "whether or not they appear in the list" ([models](https://docs.typesafe.ai/models.md)).

Vercel paths ([Vercel TypeSafe API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe.md), [changelog 2026-09-21](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev)):

| Path | Model string | Boolean type / field | Notes |
|---|---|---|---|
| `https://ai-gateway.vercel.sh/typesafe/v1/systemone` (TypeSafe-compatible) | `typesafe-ai/jev` | `noul` / `noul` | Same shapes as native, plus `provider_metadata.gateway.cost`. Errors look like `{message, error_type}`, and provider errors pass through unchanged. Supports `GET /typesafe/v1/models`. |
| `https://ai-gateway.vercel.sh/v1/evaluate` | `typesafe-ai/jev` | `boolean` / `probability` | "the same capability without TypeSafe-specific naming" (covered in note 03). |
| AI SDK `experimental_evaluate` via `@ai-sdk/typesafe-ai` (direct to TypeSafe, v3.0.6) | `jev-latest` or any TypeSafe model ID | `boolean` / `probability` | Confidence is at `providerMetadata.typesafe.confidence[questionId]`; `result.rounding` reports two-decimal precision; core retries 429 and 529 with `maxRetries` (default 2). |

"Gateway supports TypeSafe clients" (2026-09-21) means only this: point `TypeSafeClient` at `baseURL: 'https://ai-gateway.vercel.sh/typesafe'` with an AI Gateway key. "Your `systemOne` calls, `noul` questions, and response shapes stay exactly as they are", and billing moves to the Gateway. BYOK with a TypeSafe key is supported. In the Vercel example the response `model` field is `"typesafe-ai/jev"`, not a versioned ID. So through the Gateway you may lose the version visibility that native responses give you (UNVERIFIED; open question). The Python SDK docs also show OpenRouter as a base URL (`https://openrouter.ai/api`, model `~typesafe/jev-latest`) ([python usage](https://docs.typesafe.ai/sdk/python/usage.md)). It is not in OpenRouter's public `/api/v1/models` list as I fetched it, so OpenRouter support is UNVERIFIED.

### 2. Client SDKs

- **JavaScript/TypeScript:** `npm install @typesafe-ai/sdk`. v0.6.0 was released 2026-09-15; the initial public release was v0.5.7 on 2026-09-11. The package has ESM, CJS and d.ts builds. `package.json` has no `dependencies` and requires `node >=20`.
  - API: `new TypeSafeClient({apiKey, baseURL, defaultModel, timeout, retry, fetch, logger, logLevel, dangerouslyAllowBrowser})`, `client.systemOne({state, questions, model?}, {timeout, retry, headers, signal})`, `client.models.list()`, and helpers `choice()`, `noul()`, `score()`. Answer types are inferred from the questions, e.g. `choice` is typed `keyof T & string`.
  - Defaults: `defaultModel` `jev-latest`, timeout 10,000 ms per attempt ("without a total retry budget"), and `RetryPolicy` {maxRetries 2, backoffInitialMs 500 doubling to backoffMaxMs 5000, jitter 0.25, httpStatuses 408, 429 and 500–599, respectRetryAfter (reads `Retry-After` and `retry-after-ms`, capped at maxRetryAfterMs 60,000), retry on connection and timeout errors}.
  - The client refuses to run in a browser unless `dangerouslyAllowBrowser`. Errors carry `requestId` from `x-typesafe-request-id`, and `RateLimitError.retryAfterMs` is exposed.
  - Sources: [TypeSafeClient](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md), [RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md), [TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md), [RateLimitError](https://docs.typesafe.ai/sdk/javascript/api/classes/RateLimitError.md), [changelog](https://docs.typesafe.ai/sdk/javascript/changelog.md).
- **Python:** `pip install typesafe-sdk`. v0.7.1 was released 2026-09-21. It depends on httpx2, pydantic, pydantic-core, tenacity and typing-extensions, and requires Python >=3.10 ([PyPI JSON](https://pypi.org/pypi/typesafe-sdk/json)).
  - Clients: `TypeSafeClient` and `AsyncTypeSafeClient`, with `system_one(state, questions, model=, retry=, response_model=, extra_body=)` and typed accessors `.nouls`, `.choices`, `.scores`.
  - `RetryPolicy` defaults: max_retries 2, backoff 0.5 s doubling to 5 s, jitter 0.25, statuses {408, 429, 500–599}, and `timeout=30.0` as a *total* retry budget per call. The default HTTP timeout is 10 s.
  - `extra_body` forwards unknown request fields. The docs' example field `beam_width` is marked "illustrative; only send fields supported by the API".
  - Sources: [python](https://docs.typesafe.ai/sdk/python.md), [usage](https://docs.typesafe.ai/sdk/python/usage.md), [retries](https://docs.typesafe.ai/sdk/python/api/retries.md), [changelog](https://docs.typesafe.ai/sdk/python/changelog.md).
- **What the SDKs do not do:** no multi-state batching, no response cache, no request dedupe, no concurrency limiter, and no option-count guard. Every cookbook brings its own `ThreadPoolExecutor` (skill suggestion uses `WORKERS = 8`, "gentle on rate limits") and a `JsonCache` from the `cooksafe` helper package (`cooksafe>=0.2.0,<0.3.0`).

### 3. Batching semantics and cost

- "Every question in a request sees the same state, is evaluated independently" and "One question's answer is not hidden context for another. You can add or remove questions without changing the others' results" ([primitives](https://docs.typesafe.ai/primitives.md)).
- "Jev ingests the `state` once and evaluates every question against it in parallel. The 64k budget covers the `state` plus all questions combined; the 32k budget applies to the `state` plus the single longest question" ([models](https://docs.typesafe.ai/models.md)).
- The parallel-questions experiment (`jev-1.12`, GDPR article at 53,777 characters, 8 Noul + 2 Choice + 3 Score, 5 runs each) ([parallel_questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md)):
  - One call with all 13: "$0.000497" and "0.27s".
  - 13 calls with one each: "$0.006090" and "2.71s" (latencies summed, i.e. run one after another).
  - Cost and latency are means over the 5 runs.
  - 11 of 13 answers had std 0.0 both ways. Two Nouls were noisy: `breach_72h` (std 0.0055 both ways, mean 0.804 batched vs 0.814 single) and `criminal_penalties` (std 0.0045 batched vs 0.0084 single, mean 0.108 both).
  - Our arithmetic from the published cost and rate: the batched call is about 11,833 input tokens and a single call averages about 11,154. So each extra question added roughly 57 tokens here.
- Other request sizes in the docs: 62 questions in one request took 0.51 s ([autoformat](https://docs.typesafe.ai/cookbooks/autoformat.md)). The function-calling cookbook sends 54 questions per command ([function_calling](https://docs.typesafe.ai/cookbooks/function_calling.md)).
- **Batching pairwise scoring in one request.** The Noul page scores one resume against three candidate records in one request. Each record sits inside that Noul's structured `instructions` (`{"potential_duplicate": {...}, "question": "..."}`) ([noul](https://docs.typesafe.ai/primitives/noul.md)). This is the documented shape for scoring many candidates against one query in one request. The re-ranking and RAG cookbooks do not use it: "Nothing batches passages into one request, because each question is about one pair" ([classifying_rag_passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md)).

### 4. The Choice primitive for search

- Option names and descriptions both reach the model; question IDs do not. Descriptions can be string, object, array or null ("use null when an option needs no extra detail") ([api](https://docs.typesafe.ai/api.md), [choice](https://docs.typesafe.ai/primitives/choice.md)). Field names inside object descriptions (`what`, `not_for`, `examples`) are free-form: "none are reserved … The model sees the names along with the values".
- **Two ways to encode a catalog:**
  1. *Descriptions in `criteria`.* Skill suggestion uses `{skill.name: skill.description}` for 182 skills, with descriptions averaging 54 characters and capped at 60.
  2. *Content in `state`, bare IDs as options.* Line-by-line search prefixes each of 218 lines with `L000|` in the state and makes the options `{L000: None, …}`. The state holds 43,980 characters of text ([semantic_find](https://docs.typesafe.ai/cookbooks/semantic_find.md)).

  The hierarchical cookbook uses a third variant: opaque keys `c0..cN` with the label as the description, "reversible option mapping" ([hierarchical_classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md)). No cookbook compares these encodings.
- **Beyond 255 options.** For documents: "search in two passes: one Choice question picks a window of lines, and a second ranks the lines inside it" ([semantic_find](https://docs.typesafe.ai/cookbooks/semantic_find.md)). For rosters: "A few times larger and you would split it into chunks and rank each one, then run this same shortlist step over the winners" ([skill_suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)).
- Always add a no-match path. The docs suggest "an `other` or `none of the above` option when the list might not cover every input" ([choice](https://docs.typesafe.ai/primitives/choice.md)), or a separate Noul, because "Choice probabilities always add up to 1, so some line ranks first even when the document doesn't answer the question" ([semantic_find](https://docs.typesafe.ai/cookbooks/semantic_find.md)).

### 5. Confidence, score, noul, calibration

- **Confidence formula.** The widget's JS is `Math.max(0, Math.min(1, (count * peak - 1) / (count - 1)))`, where `peak` is the max probability (in the raw source of [confidence.md](https://docs.typesafe.ai/confidence.md)).
  - Checked against documented outputs: 0.61 over 3 options → 0.415 (doc 0.42); 0.40 over 4 → 0.20 (0.20); 0.84 over 3 → 0.76 (0.76); 0.74 over 5 → 0.675 (0.67); Score 0.57 over 3 → 0.355 (0.35); 0.76 over 3 → 0.64 (0.64); 0.88 over 3 → 0.82 (0.81).
  - The docs call it "a convenient measure", and "you are never locked into our definition".
  - Because the formula scales with `n`, confidence thresholds do not carry over between catalogs of different sizes. That is our inference from the formula.
- **Rounding.** "TypeSafe returns scores and probabilities rounded to two decimal places … probabilities may not add up to exactly one" ([AI SDK provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai.md)).
- **Score.** `score = Σ level·p`. It is "a position", and "Different distributions can produce the same score". The jaggedness page warns that "score levels are weak in numerical calibration" ([score](https://docs.typesafe.ai/primitives/score.md), [jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)).
- **Noul.** It is P(yes) with no confidence field. "it's not a scale of the thing you asked about". Structural identities fail in the docs' own example: the refund Noul (0.72) and the not-refund Noul (0.47) sum to 1.19. The same question asked as a Noul returned 0.22 and as a yes/no Choice returned yes=0.01 ([noul](https://docs.typesafe.ai/primitives/noul.md), [jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)).
- **Calibration.** Only definitional claims are published: "Outcomes assigned a probability of `0.2` should occur about 20% of the time", and "Calibration is measured across groups of predictions; it does not guarantee that an individual answer is correct" ([primer](https://docs.typesafe.ai/introduction/machine-learning-primer.md), [system-one](https://docs.typesafe.ai/concepts/system-one.md)). I found no reliability diagram, ECE, or Brier score anywhere in the docs or blog. The closest evidence is the classification cookbook: at confidence ≥0.9, "27/30 right"; below it, "12/30 right" ([classification_using_confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)). By stated policy the company publishes "no standard benchmark table in our model releases" ([antibenchmaxxing](https://typesafe.ai/blog/antibenchmaxxing), Sep 11, 2026).
- **Determinism.** Jev is not deterministic. Mean per-question Noul std was "`0.0102`" over 15 runs, and a `covered` answer ranged "`0.43` to `0.53`". On Choice, "TypeSafe flips on 2 of the 8 questions", with 90.8% plurality agreement (99.2% once answers under a 0.60 top probability are routed to `uncertain`, with no question producing two different concrete labels) ([consistency_noul](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md), [consistency_choice](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md)). The runs added a random `uid` field to the state, so the docs admit they "cannot separate sensitivity to the irrelevant field from variation that would occur on identical requests".

### 6. Rate limits, errors, versions, data handling

- `jev-1.13.0`: "$42 / $0.042" per Btok/Mtok; "250,000 tokens per second / 1,200 requests per minute"; "64k tokens per request; 32k tokens for `state` plus the longest question"; text only. "Rate limits are adjusting dynamically … can change without notice … Higher limits are available on custom and enterprise plans" ([models](https://docs.typesafe.ai/models.md)).
- Error codes are 401, 422, 429 ("You have exceeded your rate limit") and 529 ("TypeSafe is temporarily overloaded"), and the docs say to "retry … with exponential backoff" ([api](https://docs.typesafe.ai/api.md)). The SDK exception classes also cover 400, 403, 404 and 5xx, and a response-validation error with `field_path` ([python exceptions](https://docs.typesafe.ai/sdk/python/api/exceptions.md)).
- **Aliases.** `jev-latest` points to `jev-1.13.0`, the most recent stable release. `jev-preview` points to `jev-1.13.0` as well, and "There is no preview build available right now". The docs advise: "If you have tuned confidence thresholds against a specific version, pin that version's ID instead of the alias". Cookbooks pin short forms like `"jev-1.12"` and the jaggedness example uses `TypeSafeClient(model="jev-1.13")`, so minor-version IDs appear to be accepted too (UNVERIFIED beyond these examples) ([models](https://docs.typesafe.ai/models.md)).
- **No fine-tuning.** "Jev is not fine-tuned or LoRA-adapted with customer data … the same weights serve every account" ([models](https://docs.typesafe.ai/models.md)).
- **ZDR and data.** "Jev is not trained on customer requests or responses." "We also offer zero data retention (ZDR) for enterprise customers" (contact sales) ([models](https://docs.typesafe.ai/models.md), [legal](https://docs.typesafe.ai/legal.md)). The DPA (dated Apr 24, 2026) states no concrete retention period: "retained for as long as necessary taking into account the purpose of the Processing" ([DPA](https://typesafe.ai/legal/data-processing)).
- **Speed claims.** "Most queries complete in about 100 ms" ([how-to-build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)); "70ms-500ms" end to end, with evals "run from our laptops on the West Coast (this is where our service is currently based)" ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). Cookbook timings for a 182-option Choice plus 3 Nouls were 0.31 s, 0.16 s and 0.16 s. The follow-up call with a 3-option Choice plus 3 Nouls took 0.09–0.12 s ([skill_suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)).
- **Language.** "English is the primary training language … Other languages, including CJK scripts, are handled but not equally well" ([models](https://docs.typesafe.ai/models.md)).

### 7. Jaggedness (jev-1.13, reviewed 2026-09-17) — items that matter for search

Source: [jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md). Note 03 already covers the full list. These are the items that bear on a search library:

- **Literal reading.** "answers the question you wrote, not the one you meant". Raw user phrasing and misspellings in tool queries are exactly this risk.
- **Large state full of irrelevant detail.** "Accuracy falls as the state grows with content unrelated to the decision … Jev suffers from context rot." This argues against the "catalog in state" encoding for large catalogs, and for filtering first.
- **Adversarial content.** "does not treat it as hostile by default". Tool descriptions written by third parties, such as MCP servers, are untrusted content that goes into `criteria`.
- **Invariants.** "Don't carry a threshold tuned on a Noul over to a Choice".
- **Missing topic.** The page says nothing about how accuracy changes with option count. The only statement on that is the "roughly 240 options" line in a cookbook.

### 8. Every cookbook, with the algorithm and numbers

All use `jev-1.12` unless noted. `cooksafe` caches replay the published numbers.

- **Skill suggestion** ([link](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)). Data: 182 Hermes skills in 33 categories; 488 requests (315 covered by exactly one skill, 173 by none); agent `claude-haiku-4-5-20251001`.
  - Call 1: `Choice` over all 182 with instructions "Which of these skills, if any, is the right one to load to help with the user's latest request?". Criteria are the 60-character index descriptions. The same call carries 3 gate Nouls: `acts_on_user_system`, `would_follow_documented_procedure`, and the inverted `prose_suffices`. The gate is their mean, with `prose_suffices` flipped as 1−v. If the gate is below 0.30, suggest nothing.
  - Call 2: `Choice` over the top 3 with "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name." Criteria are `description_full + " — " + body[:700]`. The call also carries one `fits::{name}` Noul per candidate ("Does the skill '{name}' do the specific thing the user's request asks for? It is described as: …"). If the best fit is below 0.30, suggest nothing; otherwise suggest the Choice winner.
  - Output is one system-prompt line: "Relevant to the current request: X. Ignore this if it does not fit what the user actually asked for."
  - Results: wrong loads 16.8%→7.3% (oracle 2.5%) and needless loads 9.8%→4.0% (oracle 1.2%). The suggestion fixed 37 covered requests and broke 7. Jev's own top-1 is not reported. The covered requests were LLM-written from each SKILL.md, "so … the requests are easier than the ones users send".
- **Re-ranking** ([link](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)). Data: CLERC, 170 rows pooled into 3,565 passages, 40 evaluation queries.
  - Pipeline: `bm25s` top-30 (recall@30 = 100%, BM25 top-1 = 5%), then one Noul per (query, candidate) pair in its own call, so 1,200 calls with a 12-thread pool. State is `{query_excerpt, candidate_passage}`. Candidates are sorted by `noul`.
  - Instructions: "The query excerpt comes from a US federal court opinion and was written immediately around a citation to a precedent; the citation itself has been removed. Could the candidate passage be from that cited precedent — does it establish the specific legal proposition the query excerpt invokes at its citation point?"
  - Criteria: true = "…states or establishes the specific rule, standard, holding, or fact pattern that the query excerpt attributes to its removed citation"; false = "…merely on a similar topic or doctrine…".
  - Results: top-1 5%→18%, top-5 15%→35%, top-10 38%→62%. Tokens: 1,536,002 input and 25,200 output, "$0.0645" total. That is about 1,280 input tokens per call by our arithmetic.
  - The cookbook adds: "A real application would ask several questions about the same pair in one call."
- **Line-by-line search** ([link](https://docs.typesafe.ai/cookbooks/semantic_find.md)). GitHub ToS split into 218 lines, each tagged `L###|` in the state.
  - `where` Choice: "Which line of the document contains the answer to: "{query}"?" with null criteria.
  - `exists` Noul: "Does any line of the document address or answer: "{query}"?", with criteria true = "At least one line of the document states or directly implies the answer" and false = "No line of the document addresses this".
  - Thresholds: FOUND 0.7 and ABSENT 0.35 ("present answers typically read >=0.9, absent <=0.05").
  - Four demo queries only. Example: arbitration gets its top line at 0.86 but `exists` 0.14, which means not in the document.
- **Hierarchical classification** ([link](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md)). Data: CPC 2026.05, Shopify 2026-02, MeSH 2026, and a code tree.
  - Each node is a Choice with instructions "Which direct child category best matches this document?" and options `c{i}` → child label. Children are passed without subtrees here, although the Advanced page shows subtrees as option values.
  - Beam K=3, MAX_DEPTH 12. Path score is `product(p)^(1/decisions)` (geometric mean; use log-space past about 10 levels). Single-child nodes do not count as decisions. `separation = top/second` is reported but not used for pruning.
  - Frontier expansions run as separate calls in a thread pool (`max_workers=BEAM_WIDTH`), not as questions in one request, even though the prose says "parallel questions".
  - Client: `RetryPolicy(max_retries=5, backoff_initial=1.0, backoff_max=20.0)`.
  - Results: beam 4/4 and greedy 2/4. Beam recovered CPC ("A01K31/12 Perches…"; greedy went to "E99Z99/00") and Shopify ("Cat Window Beds & Perches"; greedy went to "Pet Chairs"). The cookbook does not handle nodes with more than 255 children.
- **Parallel questions** — see §3.
- **Classification using confidence** ([link](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)). 60 10-K filings (700–2,200 words) against one 75-option Choice. Each option is described as `"{umbrella} — includes: {up to 8 industries}"` when the SEC list gives the group an umbrella title (42 of the 75), otherwise by the umbrella or the industry list alone. Instructions: "Which broad industry does this company operate in? Judge the company's own operations as this filing describes them."
  - Top-1 was 39/60. At confidence ≥0.9: 30 filings, 27 right. Below 0.9: 30 filings, 12 right at group level. Falling back to the division gives 48/60 useful answers.
  - This is the only published many-option Choice accuracy.
- **Classifying RAG passages** ([link](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md)). 81 Supabase auth passages, `text-embedding-3-small` at 256 dimensions, top-12 retrieved.
  - Per (query, passage) call: 4 Nouls (`is_relevant`, `contains_answer_evidence`, `contradicts_query_premise`, `contains_prompt_injection`).
  - Routing in order: injection >0.70 excludes; contradicts >0.70 goes to the conflict block; relevance <0.45 excludes; evidence >0.55 includes; anything else is excluded.
  - Six queries. It shows reordering but reports no aggregate metric.
- **Function calling** ([link](https://docs.typesafe.ai/cookbooks/function_calling.md)). 10 typed functions; one `__tool__` Choice plus every argument's Choice/Noul in one request, 54 questions per command.
  - A `stated` Noul per optional argument decides whether to omit it.
  - Call confidence is "the least certain judgement in the call, rather than the product".
  - Advice: "Write each question about the idea rather than the words a user might pick … Avoid naming a question after its parameter."
- **Self-consistency: nouls / choices** (`jev-latest`, 2026-09-11) — see §5.
- **Structure recovery** ([link](https://docs.typesafe.ai/cookbooks/autoformat.md)): pass 1 is 16 questions in 0.32 s; pass 2 is 62 questions over 17 blocks in 0.51 s.
- **Entity alignment, citation check, guardrails, SDE cascade, date extraction, pre-parsed value extraction, autoresearch feature discovery.** None are search recipes. Patterns they use that are relevant here: a Score with a middle "send to a human" level; one Choice over candidate spans found by regex ("It cannot invent a value"); Jev as a cheap verifier in an LLM cascade; Jev answers as features for CatBoost ([cookbooks index](https://docs.typesafe.ai/cookbooks.md)).

### 9. Blog posts

The sitemap lists five posts ([sitemap](https://typesafe.ai/sitemap.xml)). None is newer than the launch post (Sep 15, 2026). The other four are "Lies, Damned Lies, and Benchmarks" (antibenchmaxxing, Sep 11), bitterest-lesson (Sep 10), and two earlier press pieces (Jun 19 and Mar 31). Launch-post details not already in note 03:

- "a new model architecture, parallel sampler for maximum efficiency".
- "Jev outputs all probabilities in parallel instead of autoregressively generating by token".
- Speed is "40x-200x faster for the same levels of frontier intelligence for System One shaped queries".
- The workflow evals use "the average of GPT-6 Astra and Fable 5.1 as the reference answer", and the workflows "were made by individuals on our model capabilities team, so some bias could exist".
- The Wikiracing demo note, quoted exactly: "Jev supports a cardinality up to 255. For the higher cardinality choices, we do a 2 stage-system of scoring independently then making an explicit choice, hence the occassional slowdown."

## Implications for a Jev search library

1. **Rounding means one Choice gives you top-few, not a ranking.** A library that returns top-k from a single Choice should treat options at `0.00` as unranked. It needs a second signal to order the tail: BM25 score, a second-pass Choice over a shortlist, or per-candidate Nouls. Report hit@1 and hit@k only up to the non-zero mass. This is a design constraint, not a tuning knob.
2. **Copy the vendor's two-stage shape.** Stage 1 is a wide Choice over the whole catalog, at most 255 options with ~240 as the "reliable" line, plus 1–3 gate Nouls in the same request. Stage 2 is a Choice over the top 3 with full descriptions, plus one `fits` Noul per candidate for abstention. The cookbook's thresholds (gate 0.30, fits 0.30) come from one agent and one roster, so treat them as defaults to re-tune.
3. **Pointwise re-ranking can be batched.** The docs do not do this in the rerank cookbook, but they document the mechanism in the Noul page: one Noul per candidate, with the candidate in structured `instructions` and the query as the state. For BM25 top-20 or top-30 that is one request instead of 20–30, and it stays inside the 64k total / 32k per-question limits. We have not tested whether this matches per-call scoring quality. It follows from "questions are independent", which the parallel-questions cookbook tested only on a document-heavy state.
4. **Chunking past 255** ("split it into chunks and rank each one, then run this same shortlist step over the winners"). The chunks can be separate questions in one request with the same state, since answers are independent and the state is paid once. That keeps a catalog of about 1,000 tools to one wide request plus one narrow one, as long as the total stays under 64k tokens.
5. **Confidence thresholds must be normalized by `n`.** Either compute your own statistic from `probabilities` (the docs encourage this), or document that `confidence` is `(n·p_max−1)/(n−1)` and scale thresholds per catalog size.
6. **The SDKs give you retries and nothing else.** The library has to supply:
   - a concurrency limiter aimed at 1,200 RPM / 250k TPS, which may change without notice;
   - caching keyed by (model version, catalog hash, query);
   - backoff on 429/529 and on Gateway 429 "provider at capacity";
   - graceful degradation to BM25 when Jev refuses.

   Our 48% refusal rate on 199-option calls against about 0% on 20-option calls fits "capacity" being token- or compute-weighted. That is our inference; the docs are silent on it.
7. **Pin versions, and log `response.model`.** Most vendor numbers are `jev-1.12`, and `jev-latest` can move under you. Through Vercel's TypeSafe-compatible path the response `model` may read `typesafe-ai/jev`. A library should allow an explicit versioned model ID and record what answered.
8. **Keep the state small.** Jaggedness #5 (context rot) argues for putting the catalog in `criteria` (descriptions) rather than in `state` for large catalogs, and for trimming descriptions. It also argues against dumping full JSON schemas. No doc quantifies per-option token cost beyond "a few tokens each", so measure it.
9. **Treat catalog text as untrusted.** Third-party tool descriptions go straight into `criteria`, and Jev "does not treat it as hostile by default".
10. **Framing for an "Orama for Jev".** Orama is in-process with no dependencies. Jev can only ever be a remote call (text-only, hosted, same weights for everyone), so the library is really a client-side orchestrator: candidate generation, chunking, batching, caching, abstention and fallback around a remote scorer. TypeSafe's own framing agrees. BM25 is "fast search" and Jev is the re-ranker ([rerank](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)); "Replace or supplement embeddings in RAG pipelines" ([use-case map](https://docs.typesafe.ai/concepts/use-case-map.md)).

## Open questions

- Does Jev score Choice options independently, the way Score levels are ("each level is judged on its own")? If so, option order and neighbours would not matter. The docs are silent on Choice. The hierarchical cookbook says "sibling options are asked in the order they appear here, so it is part of the question", which hints that order may matter. That line is a code docstring about keeping the CookSafe file-tree snapshot stable, not a model statement, so it is weak evidence.
- Is the launch blog's "2-stage system" server-side for large Choices, or only demo code? UNVERIFIED.
- What is the input-token cost per option? The docs say "a few tokens each". We should measure `usage.input_tokens` for 20, 50, 100 and 199 options, with and without descriptions, and with the catalog in `criteria` vs in `state`.
- Does batching N candidate Nouls in one request (the structured-instructions shape) reproduce the scores from N separate calls when the state is short (a query) and the candidate text sits in the questions? The parallel-questions test used a large shared state.
- What do the rate limits look like per request size? Are 199-option requests refused because of token-per-second weighting? The docs publish TPS and RPM only.
- Does Vercel's TypeSafe-compatible path, or `/v1/evaluate`, accept a pinned `jev-1.13.0`, and does it report the versioned model ID?
- Is there any published calibration curve for Choice with more than 50 options? None found. The 75-way SEC cookbook (n=60) is the only data point.
- Is OpenRouter really serving Jev as `~typesafe/jev-latest`? The claim appears only in TypeSafe's Python SDK docs.

## Sources

TypeSafe docs (fetched as `.md` on 2026-09-25):
- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/api.md
- https://docs.typesafe.ai/models.md
- https://docs.typesafe.ai/primitives.md
- https://docs.typesafe.ai/primitives/choice.md
- https://docs.typesafe.ai/primitives/score.md
- https://docs.typesafe.ai/primitives/noul.md
- https://docs.typesafe.ai/primitives/advanced.md
- https://docs.typesafe.ai/confidence.md (including the raw widget source for the formula)
- https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- https://docs.typesafe.ai/concepts/state.md
- https://docs.typesafe.ai/concepts/system-one.md
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
- https://docs.typesafe.ai/concepts/use-case-map.md
- https://docs.typesafe.ai/introduction/machine-learning-primer.md
- https://docs.typesafe.ai/introduction/quickstart.md
- https://docs.typesafe.ai/introduction/coding-agents.md
- https://docs.typesafe.ai/patterns/fan-out.md
- https://docs.typesafe.ai/patterns/confidence-routing.md
- https://docs.typesafe.ai/patterns/intent-routing.md
- https://docs.typesafe.ai/patterns/composite-scoring.md
- https://docs.typesafe.ai/cookbooks.md
- https://docs.typesafe.ai/cookbooks/skill_suggestion.md
- https://docs.typesafe.ai/cookbooks/rerank_typesafe.md
- https://docs.typesafe.ai/cookbooks/semantic_find.md
- https://docs.typesafe.ai/cookbooks/hierarchical_classification.md
- https://docs.typesafe.ai/cookbooks/parallel_questions.md
- https://docs.typesafe.ai/cookbooks/classification_using_confidence.md
- https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md
- https://docs.typesafe.ai/cookbooks/function_calling.md
- https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md
- https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md
- https://docs.typesafe.ai/cookbooks/autoformat.md
- https://docs.typesafe.ai/cookbooks/entity_alignment.md
- https://docs.typesafe.ai/cookbooks/citation_check.md
- https://docs.typesafe.ai/cookbooks/llm_guardrails.md
- https://docs.typesafe.ai/cookbooks/sde_cascade.md
- https://docs.typesafe.ai/cookbooks/date_extraction_cookbook.md
- https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md
- https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md
- https://docs.typesafe.ai/demos/smart-home.md
- https://docs.typesafe.ai/agent-skill.md
- https://docs.typesafe.ai/legal.md
- https://docs.typesafe.ai/sdk.md
- https://docs.typesafe.ai/sdk/javascript.md and all `/sdk/javascript/api/**` pages listed in llms.txt
- https://docs.typesafe.ai/sdk/javascript/changelog.md
- https://docs.typesafe.ai/sdk/python.md
- https://docs.typesafe.ai/sdk/python/usage.md
- https://docs.typesafe.ai/sdk/python/changelog.md
- https://docs.typesafe.ai/sdk/python/api/retries.md
- https://docs.typesafe.ai/sdk/python/api/exceptions.md
- https://docs.typesafe.ai/sdk/python/api/constants.md
- https://docs.typesafe.ai/sdk/python/api/clients/sync.md
- https://docs.typesafe.ai/sdk/python/api/types/questions.md
- https://docs.typesafe.ai/sdk/python/api/types/responses.md
- https://docs.typesafe.ai/migrating-to-v1.md (linked from the skill; returns "Page Not Found")

TypeSafe other:
- https://api.typesafe.ai/openapi.json (OpenAPI 0.2.0)
- https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md
- https://typesafe.ai/sitemap.xml
- https://typesafe.ai/blog/introducing-system-one-models-and-jev (Sep 15, 2026)
- https://typesafe.ai/blog/antibenchmaxxing (Sep 11, 2026)
- https://typesafe.ai/blog/bitterest-lesson (Sep 10, 2026)
- https://typesafe.ai/legal/data-processing

Packages:
- https://cdn.jsdelivr.net/npm/@typesafe-ai/sdk@0.6.0/dist/index.mjs and package.json
- https://pypi.org/pypi/typesafe-sdk/json
- `npm view @ai-sdk/typesafe-ai` (3.0.6)

Vercel / AI SDK:
- https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe (last_updated 2026-09-21)
- https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev (Sep 21, 2026)
- https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai
- https://openrouter.ai/api/v1/models (checked; no Jev entry)

## Verification log

Adversarial re-check on 2026-09-25. Each source was re-fetched with curl (`.md` variants for docs.typesafe.ai and vercel.com; raw HTML for the blog; npm/PyPI/jsDelivr for packages) and grepped for the exact text or numbers.

| # | Claim | Verdict | Source checked |
|---|---|---|---|
| 1 | Cookbooks (skill suggestion, rerank, semantic find, hierarchical, parallel questions, classification) pin `jev-1.12`; consistency cookbooks use `jev-latest` sampled 2026-09-11; jaggedness applies to `jev-1.13`, reviewed 2026-09-17 | CONFIRMED (added: consistency runs report `jev-1.13.0` for all 15 calls) | each cookbook `.md`; https://docs.typesafe.ai/model-jaggedness/jev-1.13.md |
| 2 | Probabilities rounded to two decimals; may not sum to 1 | CONFIRMED (stated only in AI SDK docs, not in TypeSafe's own docs; "most of 199 options read 0.00" relabelled as inference) | https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai.md |
| 3 | Confidence widget formula `(count*peak-1)/(count-1)`, clamped to [0,1]; reproduces documented values (0.61/3→0.42, 0.40/4→0.20, 0.84/3→0.76, 0.74/5→0.67, Score 0.57/3→0.35) | CONFIRMED | https://docs.typesafe.ai/confidence.md and rendered page JS; https://docs.typesafe.ai/primitives/choice.md; https://docs.typesafe.ai/primitives/score.md |
| 4 | Parallel questions: $0.000497 / 0.27 s vs $0.006090 / 2.71 s; 12.2x / 10.0x; 53,777 chars; 8 Noul + 2 Choice + 3 Score; 5 runs | CONFIRMED | https://docs.typesafe.ai/cookbooks/parallel_questions.md |
| 5 | Batched and single calls "gave the same means and standard deviations"; two Nouls varied "about 0.005–0.008" | CORRECTED: `breach_72h` means 0.804 vs 0.814; `criminal_penalties` std 0.0045 vs 0.0084; cost/latency are 5-run means | same |
| 6 | Primitives page quotes "11.5x cheaper and 9.6x faster" for the same experiment | CONFIRMED (docs are internally inconsistent) | https://docs.typesafe.ai/primitives.md |
| 7 | "maximum of 255 options per Choice"; "a few tokens each"; "reliably up to roughly 240 options" | CONFIRMED | https://docs.typesafe.ai/api.md; https://docs.typesafe.ai/primitives/choice.md; https://docs.typesafe.ai/cookbooks/classification_using_confidence.md |
| 8 | Blog quote on cardinality 255 and "2 stage-system" (typo "occassional" is in the original) | CONFIRMED verbatim; server-side vs demo-side remains UNVERIFIED | https://typesafe.ai/blog/introducing-system-one-models-and-jev |
| 9 | Score levels "evaluated separately"; 2 to 10 levels | CONFIRMED | https://docs.typesafe.ai/primitives/score.md |
| 10 | Rate limits 250,000 tokens/s and 1,200 RPM; "adjusting dynamically"; $42/$0.042; 64k / 32k; 429 vs 529 meanings | CONFIRMED | https://docs.typesafe.ai/models.md; https://docs.typesafe.ai/api.md |
| 11 | Gateway 429 "provider at capacity" = a 529-type condition | UNVERIFIED (no primary source; our reading) | — |
| 12 | JS SDK 0.6.0 (2026-09-15), initial 0.5.7 (2026-09-11); no `dependencies`; `node >=20`; RetryPolicy defaults (2 retries, 500→5000 ms, jitter 0.25, 408/429/5xx, Retry-After/retry-after-ms capped 60,000 ms); timeout 10,000 ms per attempt; client-side check for ≥2 Score levels; no option-count check, no cache or concurrency code | CONFIRMED | https://docs.typesafe.ai/sdk/javascript/changelog.md; https://cdn.jsdelivr.net/npm/@typesafe-ai/sdk@0.6.0/package.json and dist/index.mjs; RetryPolicy and TypeSafeClientConfig pages |
| 13 | Python SDK 0.7.1 (2026-09-21); `timeout=30.0` total retry budget; deps | CORRECTED (deps list also includes pydantic-core) | https://pypi.org/pypi/typesafe-sdk/json; https://docs.typesafe.ai/sdk/python/api/retries.md |
| 14 | OpenAPI 0.2.0 encodes no 255 cap and no 10-level cap; Score `criteria` `minItems: 1`; `questions` `minProperties: 1`; probabilities "sum to approximately 1" | CONFIRMED | https://api.typesafe.ai/openapi.json |
| 15 | Vercel TypeSafe-compatible response example reports `"model": "typesafe-ai/jev"`; errors `{message, error_type}`; provider errors pass through; "stay exactly as they are" | CONFIRMED | https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe.md; https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev |
| 16 | AI SDK: confidence at `providerMetadata.typesafe.confidence[questionId]`; core retries 429/529 with `maxRetries` default 2; `@ai-sdk/typesafe-ai` 3.0.6 | CONFIRMED (`npm view` 3.0.6; `ai` latest is 7.0.114) | https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai.md; npm registry |
| 17 | Re-ranking: 170 rows, 3,565 passages, 40 queries, BM25 top-30 at 100% recall, 1,200 calls, 12 workers, 1,536,002 / 25,200 tokens, $0.0645, top-1/5/10 5→18, 15→35, 38→62 | CONFIRMED | https://docs.typesafe.ai/cookbooks/rerank_typesafe.md |
| 18 | Skill suggestion: 182 skills / 33 categories; 488 requests (315/173); 16.8→7.3 and 9.8→4.0 (oracle 2.5/1.2); 37 fixed / 7 broken; thresholds 0.30; `WORKERS = 8`; excerpt 700 chars; timings 0.31/0.16/0.16 and 0.09–0.12 s | CONFIRMED | https://docs.typesafe.ai/cookbooks/skill_suggestion.md |
| 19 | Classification: 60 filings, 700–2,200 words, 75-way Choice, 39/60, 27/30, 12/30, 48/60; option description format | CORRECTED (umbrella title exists for only 42 of 75 groups) | https://docs.typesafe.ai/cookbooks/classification_using_confidence.md |
| 20 | Hierarchical: beam K=3, MAX_DEPTH 12, `max_workers=BEAM_WIDTH`, RetryPolicy(5, 1.0, 20.0), beam 4/4 vs greedy 2/4; "order they appear here" quote | CONFIRMED (the order quote is in a docstring about the CookSafe file tree, so it is weak evidence about Choice order sensitivity) | https://docs.typesafe.ai/cookbooks/hierarchical_classification.md |
| 21 | Consistency: Noul std `0.0102`, `covered` 0.43–0.53, 15 runs; Choice flips on 2 of 8, 90.8% | CONFIRMED (added the 99.2% policy-agreement context) | https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md; https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md |
| 22 | Jev not listed on OpenRouter | CONFIRMED (460 models in `/api/v1/models`, none match typesafe/jev); OpenRouter support stays UNVERIFIED | https://openrouter.ai/api/v1/models |

Totals: 18 CONFIRMED, 3 CORRECTED, 1 UNVERIFIED (plus the server-side "2-stage" question in row 8 and OpenRouter support in row 22, which remain UNVERIFIED inside confirmed rows).
