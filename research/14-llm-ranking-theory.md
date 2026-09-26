# LLM ranking theory for a Jev search library

Research date: 2026-09-25. This note covers the literature on ranking many candidates with a model that returns a distribution over a bounded option set, and translates each method into Jev's `choice` / `score` / `boolean` primitives. It does not repeat the Jev API facts in `research/tool-search/03-jev-model-and-evaluate-api.md` or the product landscape in `04-tool-search-landscape.md`. Paper numbers were read from the arXiv HTML tables (curl, then parsed) unless marked otherwise. Anything not checked at a primary source is marked UNVERIFIED. Cost figures labelled "our arithmetic" are mine, derived from the published price and our own benchmark.

## TL;DR

- The literature has four ways to prompt a ranker: pointwise (one candidate per question), pairwise (two), listwise (a window of ~20 that the model permutes), and setwise (pick the best of a set, read the logits). Jev's `choice` with per-option probabilities is setwise/FIRST-style listwise by construction: a single "forward pass" that returns a distribution over all options, with no generated permutation to parse. The papers that match Jev best are Setwise (Zhuang et al., SIGIR 2024), FIRST (Reddy et al., EMNLP 2024) and TourRank (Chen et al., WWW 2025).
- Reading a distribution beats reading a generated answer, by a lot. Setwise on Flan-T5-large (TREC DL19, BM25 top-100): `listwise.likelihood` nDCG@10 .669 in 10 s against `listwise.generation` .561 in 54.2 s. "Beyond Yes and No": the expected relevance from label likelihoods scores avg nDCG@10 0.4992 against 0.3989 for the generated label. Jev already hands us the distribution; the library should always use `probabilities`, never only `choice`.
- Initial-order sensitivity is the biggest known failure of window-based listwise ranking. RankGPT (gpt-3.5-turbo, DL19) fell from nDCG@10 65.80 with BM25 order to 25.17 with a random initial order. Tournament and setwise schemes are "far more robust" (Setwise) or show "almost no effect" from shuffling (TourRank). Permutation self-consistency (shuffle, re-ask, aggregate) gains "up to" 7–18% for GPT-3.5 across sorting and reranking datasets, but on passage reranking alone the average relative gain was 2% for GPT-3.5 and 5% for GPT-4. Five permutations capture 67% of the gain of twenty. Jev's own order sensitivity is unmeasured; this is the first experiment to run.
- A cascade can never beat its first stage's recall. In our benchmark, BM25 recall@20 at 199 tools was 80.2%, and BM25-top-20-then-Jev lost 4.0 points of hit@1 to whole-catalog Jev (70.6% vs 74.6%). 27 of the 35 requests only the whole-catalog arm got right had the answer outside BM25's top 20. On the same 199-tool ToolE/MetaTool catalog, Re-Invoke measured BM25 recall@5 at 46.18% on raw queries.
- Past 255 options you have to merge distributions from several calls. A chunk's probabilities are conditional on that chunk, so raw numbers from different chunks are not comparable. The safe merge is rank-based: take the top-m of each chunk into a final round, as in TourRank or tournament sort. Calibrated pointwise `boolean` scores are the only outputs that are on a common scale by design, and whether Jev's are calibrated on tool data is UNVERIFIED.
- Abstention: Kadavath et al. found that replacing an option with "none of the above" "reduces accuracy and calibration significantly" in LLMs. For "no tool fits", ask a separate `boolean` question rather than adding a "none" option to the `choice`, and tune its threshold on a risk-coverage curve. TypeSafe's own cookbooks already use gate thresholds of 0.30 (skill suggestion) and a 0.9 confidence cutoff (SEC classification: the confident half was right 90% of the time, the other half 40%).
- Query rewriting helps lexical and dense retrievers a lot. ToolRet's BM25s goes from avg nDCG@10 22.32 to 36.46 with an instruction, but those instructions were written by GPT-4o with the target tools in view ("target-aware"), so treat that as an upper bound. HyDE did not reliably help tool retrieval: on ToolE multi-tool it cut BM25 nDCG@5 from 0.2635 to 0.1954. Jev scored 74.6% hit@1 on the user's raw words in our benchmark, so rewriting is optional for Jev and mainly matters for a lexical prefilter.
- Proposed defaults (our arithmetic, $0.042/M tokens). For 200 tools: one whole-catalog `choice` (about 6.7k tokens, $0.00028), then a re-check call on the top 3–5 (a `choice` plus one `boolean` per candidate, under 1k tokens), which is 2 sequential calls. For 2,000 tools: 8 parallel chunk `choice` calls of 250 options, top-5 from each, and a final `choice` over 40 finalists. That is 9 calls, about 72–74k tokens (the higher figure with full descriptions for the finalists) and $0.003 per query, with no lexical recall ceiling. At 20-option chunks the same tournament takes 111 calls. That avoids the 429s we saw on large questions, but it runs into the 1,200 requests/min rate limit.

## Detailed findings

### 0. Units used for every cost estimate

- Price: $0.042 per 1M input tokens, output free (see note 03).
- Tokens per option, measured by us. The benchmark's cost column gives $0.28 per 1k queries for a 199-option call, which is about 6,700 input tokens per call, and $0.03 per 1k for a 20-option call, about 710 tokens (`research/00-benchmark-results.md`, our arithmetic from $/1k divided by $0.042/M). MetaTool descriptions are short, so that is roughly 33–36 tokens per option including instructions and state. "Compact" below means 35 tokens per option. "Rich" means 100 tokens per option, a guess for real MCP descriptions without schemas.
- Hard limits: 255 options per `choice`, 32k tokens for state plus the longest single question, and 64k per request (note 03). Compact catalogs hit the 255-option cap first. Rich catalogs hit about 250 options × 100 tokens ≈ 25k of the 32k budget.
- Availability, from our benchmark: 48.4% of 199-option calls were refused, against 0.4% of 20-option calls (`RESULTS.md`). Call size is therefore a reliability parameter as well as a cost parameter.
- Rounding: Jev rounds probabilities to 2 decimals, so most of a long tail ties at 0.00 (our adapter comment in `src/jev.ts`; the rounding is documented in note 03). Any merge rule that divides by or takes the log of small probabilities has to handle exact zeros.

### 1. Pointwise, pairwise, listwise, setwise

**RankGPT, listwise permutation generation with sliding windows.** Sun et al., "Is ChatGPT Good at Search?", EMNLP 2023 (arXiv 2304.09542).
- The model outputs a permutation of passage IDs for a window. Windows slide back-to-front over the BM25 top-100 with window size 20 and step size 10.
- TREC DL19 nDCG@10: BM25 50.58, gpt-3.5-turbo 65.80, gpt-4 75.59 (Table 1).
- Window ablation (gpt-3.5-turbo-16k, DL19): w=20 gives the best nDCG@10 (67.05). w=40 gives the best nDCG@1 (78.30) and nDCG@5. w=80 has the worst nDCG@1 (72.09), but its nDCG@5 (70.59) and nDCG@10 (65.57) beat w=60 (69.23, 65.03), so larger windows are not uniformly worse (Table 12).
- Cost (Table 11): gpt-3.5-turbo used 19,960 tokens and 10 requests per query ($0.040). gpt-4 used 19,890 tokens ($0.596). A gpt-4 pass over only the top-30 from gpt-3.5 used 3,271 tokens, 1 request and $0.098. On BEIR this cascade cost "only 1/5 of that of only using GPT-4".
- Order sensitivity (Table 5): starting from a random order instead of BM25 order dropped nDCG@10 from 65.80 to 25.17, and reverse BM25 order gave 32.77. The sliding window only bubbles up what it can see, so it is effectively a single bubble-sort pass.
- Jev translation: a window is one `choice`. Jev does not need windows below 255 options, so the sliding window matters only as the thing to avoid. It costs ~(N−w)/s sequential calls and depends on initial order.

**PRP, pairwise ranking prompting.** Qin et al., NAACL 2024 Findings (arXiv 2306.17563; https://aclanthology.org/2024.findings-naacl.97/).
- Each prompt holds the query and two documents, and each pair is asked "in both orders" to cancel position bias.
- PRP-Allpair needs O(N²) calls and scores each document by wins, with half a point for inconsistent answers. PRP-Sorting uses heapsort, and PRP-Sliding-K runs K bubble passes.
- DL19 nDCG@10 with FLAN-UL2 (20B): Allpair 72.42, Sorting 71.88, Sliding-10 72.65 (Table 2), against gpt-4 RankGPT at 75.59.
- The paper argues pointwise needs "calibrated prediction probabilities before sorting, which is known to be very difficult", while pairwise avoids calibration entirely.
- Jev translation: a pair is a 2-option `choice`. Both orders fit in one call as two questions with the options listed in opposite order (the questions share state). Allpair over 200 tools would be 19,900 pairs, so it is out. Use it only to break near-ties between the top two.

**Setwise.** Zhuang et al., SIGIR 2024 (arXiv 2310.09497).
- The prompt asks for the most relevant of c documents, and the ranking is read from the output logits over the document labels. This generalises pairwise heapsort and bubblesort from 2 to c per comparison. c=3 in the main results, and the prompt was capped at 512 tokens.
- Table 2, Flan-T5-large, DL19, BM25 top-100:

| method | nDCG@10 | inferences/query | prompt tokens/query | latency |
|---|---|---|---|---|
| pointwise.yes_no | .654 | 100 | 16,112 | 0.6 s |
| listwise.generation | .561 | 245 | 119,121 | 54.2 s |
| listwise.likelihood | .669 | 245 | 94,201 | 10 s |
| pairwise.allpair | .666 | 9,900 | 3,014,383 | 109.6 s |
| pairwise.heapsort | .657 | 230.3 | 104,953 | 16.1 s |
| setwise.heapsort | .670 | 125.4 | 40,461 | 8.0 s |
| setwise.bubblesort | .678 | 460.5 | 147,774 | 29.1 s |

- Robustness: under inverted and shuffled BM25 orders, "Setwise prompting is far more robust to variations in the initial ranking order", and listwise.likelihood and setwise.bubblesort are about as robust as pairwise.heapsort (§5.4).
- On calibration: pointwise outputs "necessitate calibration", while setwise logits "serve as an indicator of preference among documents. Thus, calibration is not necessary."
- Follow-up: Setwise Insertion (Podolak et al., arXiv 2504.10509) uses the initial ranking as a prior and reports "a 31% reduction in query time, a 23% reduction in model inferences" with slightly better effectiveness.
- Jev translation: Jev's `choice` is setwise with c up to 255 and the logits already exposed as `probabilities`. Heapsort with c-ary nodes finds the top-k in about k·log_c(N) comparisons (TourRank Table 6 gives k·log_c N · c documents read). At c=255 and N ≤ 255 that is a single call.

**FIRST, single-token listwise reranking from first-token logits.** Reddy et al., EMNLP 2024 (https://aclanthology.org/2024.emnlp-main.491/; arXiv 2406.15657).
- A fine-tuned listwise reranker orders candidates by the logits of the *first* generated identifier instead of generating the full permutation. Identifiers are the letters A–Z because windows hold at most 20 candidates. The model is trained with a learning-to-rank loss (weighted RankNet) on top of the LM loss.
- The paper reports that FIRST "accelerates inference by 50%" and matches or beats RankZephyr on BEIR. An independent reproduction (Chen et al., arXiv 2411.05508) measured "a 21%-42% gain" in latency and confirmed that "fast reranking with single-token logits does not compromise out-of-domain reranking quality".
- The motivating analysis (Fig. 2) is the relevant part for Jev. The first-token logits of a model trained only to generate full rankings already agree closely with its generated ranking, so a distribution over "which is best" carries a full ranking signal, not just an argmax.
- Jev translation: Jev's `choice.probabilities` is the same object, a distribution over "best option". Ranking by it is the FIRST recipe. The difference is that Jev rounds to 2 decimals, so the tail below 0.005 has no order. FIRST's training objective puts weight on getting the top of the list right, which is what hit@1 and recall@5 measure. How Jev was trained is only described as "Reinforcement Learning for Calibrated Decisions (RLCD)" (note 03).

**TourRank, tournament ranking with points.** Chen et al., WWW 2025 (DOI 10.1145/3696410.3714863; arXiv 2406.11678).
- One tournament runs 100 → 50 → 20 → 10 → 5 → 2. Groups are seeded so each group gets a spread of the initial ranks. The stage configurations are 100→50 as 5 groups of 20 picking 10, 50→20 as 5 groups of 10 picking 4, then single groups for 20→10, 10→5 and 5→2 (Table 7). Every advance earns a point.
- r tournaments run in parallel, and their points are summed. By my count one tournament is 13 calls in 5 sequential stages.
- gpt-3.5-turbo, DL19 nDCG@10 (Table 2, all methods reproduced by the authors): RankGPT 68.19, Setwise.heapsort (c=10) 68.16, PRP-Allpair 68.18, TourRank-1 66.23, TourRank-2 69.54, TourRank-10 71.63. On BEIR, TourRank-2 averaged 49.46 against RankGPT's 49.37.
- Shuffling or reversing the initial order "has almost no effect on TourRank-r", because "each tournament is a selection over all candidate documents, not just a fine-tuning of the initial ranking like RankGPT".
- Cost: TourRank-2 costs about the same as RankGPT and Setwise.heapsort, with lower latency than every baseline except pointwise (§4.5.2, at 30 API requests per second).
- Jev translation: this is the template for catalogs over 255. Each group is a `choice`, "select m" means taking the top-m by probability, and points are summed across r rounds with re-shuffled groups.

**ListT5**, Yoon et al., ACL 2024 (arXiv 2402.15838). An m-ary tournament sort with output caching. It "overcomes the lost-in-the-middle problem of previous listwise rerankers" and gains +1.3 avg nDCG@10 over RankT5 on BEIR. It is another tournament precedent.

**Top-down partitioning**, Parry et al., arXiv 2405.14589 (2024). It replaces the bottom-up sliding window with a pivot-based, parallelisable partition and reduces "the number of expected inference calls by around 33% when ranking at depth 100". It also reports that "list-wise rankers are biased towards relevant documents at the start of their context window".

### 2. Position bias and option-order sensitivity

- Lost in the Middle (Liu et al., TACL 2024, arXiv 2307.03172): accuracy is U-shaped in the position of the relevant passage. With the answer in the middle of 20 documents, GPT-3.5-Turbo did worse than its closed-book score of 56.1%.
- Selection bias in multiple choice (Zheng et al., "Large Language Models Are Not Robust Multiple Choice Selectors", ICLR 2024 Spotlight, arXiv 2309.03882):
  - Always moving the gold answer to position D drops gpt-3.5-turbo's 0-shot MMLU accuracy "from 67.2 to 60.9".
  - The main cause is "token bias", a prior on the ID tokens A/B/C/D. Removing IDs reduces bias but "usually degrades model performance". Switching to a/b/c/d or 1/2/3/4 gives "no remarkable reduction".
  - Their fix, PriDe, estimates the prior from option permutations on "a small number of test samples (e.g., 5%)" and divides it out.
  - Jev relevance: Jev options are keyed by name (the tool name), not by letters, so token bias on letter IDs may not apply. Jev's internal representation is not public, so this is UNVERIFIED.
- Permutation self-consistency (Tang et al., NAACL 2024, arXiv 2310.07712):
  - Shuffle the list, re-rank, and aggregate with the Kemeny ranking, which minimises total Kendall-tau distance.
  - Gains are "up to 7–18% for GPT-3.5, 8–16% for LLaMA v2 (70B)", and the HTML v2 abstract adds "34–52% for Mistral". These maxima pool sorting tasks with passage reranking. On passage reranking (TREC DL), the paper reports average relative increases of "0.4%, 2%, and 5%" for RankVicuna, GPT-3.5 and GPT-4 (§4, results discussion). For a reranker, expect the small number.
  - "the score improvement from using five aggregated rankings reaches 67% of twenty". Sampling temperature "has little effect on (and at times harming)" aggregated quality, so the diversity has to come from shuffling.
  - A side finding relevant to cascades: SPLADE++ as first stage added "an average of 7.26 points" over BM25, and reranking the SPLADE top-20 in a single call beat the top-100 with a sliding window.
- PRP's both-orders trick (above) is the pairwise version of the same idea.
- Our only related data point: a repeat run of whole-catalog Jev matched its own top tool on 95 of 97 answered requests, and the 20-option hybrid on 100 of 100 (`RESULTS.md`). That measures run-to-run stability with a fixed option order. It says nothing about order sensitivity.
- Jev recipe (proposal):
  - First measure. Take 200 labelled queries and ask the same `choice` with 3 random option orders. Report the top-1 flip rate, the mean total-variation distance between the distributions, and hit@1 as a function of the gold tool's position (first, middle and last third).
  - If the flip rate is small (say under 2%), skip permutation averaging. If not, average the probabilities over P shuffles; averaging distributions is the natural analogue of Kemeny when you have probabilities instead of permutations. Five permutations captured most of the gain in PSC.
  - Cost is P times the base: 200 tools compact with P=3 is 3 parallel calls, ~20k tokens, $0.00084 (our arithmetic).

### 3. Cascades and the first-stage recall ceiling

- The principle: final hit@1 ≤ recall@K of the prefilter. Our benchmark shows it directly. BM25 recall@20 was 86% at 50 tools, 81.5% at 100 and 80.2% at 199. The hybrid scored 70.6% against whole-catalog Jev's 74.6% (paired +4.0 pts, 95% CI [0.5, 7.3]). 27 of the 35 whole-only wins lay outside BM25's top 20.
- Recall ceilings on the same catalog from Re-Invoke (Chen et al., EMNLP Findings 2024, arXiv 2408.01875). ToolE single-tool is 20,550 queries over 199 tools, the MetaTool catalog. The table has recall@1 and recall@5:

| first stage | recall@1 | recall@5 |
|---|---|---|
| BM25 on the raw query | 27.16% | 46.18% |
| HyDE + BM25 | 31.21% | 43.37% |
| Re-Invoke (intent extraction + synthetic-query doc expansion) + BM25, gpt-3.5 | 52.55% | 71.93% |
| Vertex AI embeddings | 52.65% | 75.74% |
| Re-Invoke + embeddings, text-bison | 67.15% | 87.07% |

- More candidates are not always better. "Drowning in Documents" (Jacob et al., ReNeuIR @ SIGIR 2025, arXiv 2411.11767) found that cross-encoder rerankers improve at first and then decline, and "can even degrade quality beyond a certain limit", as K grows toward 5,000. ToolRet found MonoT5 reranking NV-Embed's list lowered avg nDCG@10 from 33.83 to 28.92. For Jev we know K=199 beat K=20 on tools. Nothing is known above 255.
- The ranker cascade precedent is RankGPT's gpt-3.5 → gpt-4 top-30 pass at 1/5 of the cost.
- Jev recipes:
  - 200 tools, BM25 top-20 then Jev: 1 call, ~710 tokens, $0.00003. The ceiling is 80.2% (measured). It is cheapest, but lost 4 points.
  - 2,000 tools, prefilter top-250 then Jev: 1 call, ~8.8k tokens compact, $0.00037, or 1 call at ~25k tokens rich. The ceiling is prefilter recall@250 at 2,000 tools, which is unmeasured. Use embeddings or a hybrid, not BM25 on raw words (46% recall@5 at 199).
  - A cheaper cascade inside Jev itself: a short-description `choice` for recall, then full descriptions for the top-k. This is TypeSafe's skill-suggestion pattern (60-char index descriptions, then a re-read of the top 3) and FastMCP's wide pass plus close read. The FastMCP docs report the single-pass mode was "six points worse at returning the right tool first" (note 04).

### 4. Calibration, selective prediction and "none of these"

- Calibration metric: ECE = Σ_m (|B_m|/n)·|acc(B_m) − conf(B_m)|, with M=15 equal-width bins in Guo et al., "On Calibration of Modern Neural Networks", ICML 2017 (arXiv 1706.04599). Their fix is temperature scaling, a single parameter T that divides the logits, fitted on held-out data: "surprisingly effective".
  - Jev translation: compute ECE of `max(probabilities)` against hit@1 on our labelled set. If Jev is miscalibrated on tools, fit p_i ∝ p_i^{1/T} and renormalise. Exact zeros from rounding stay zero, so T can only redistribute mass among the options that got nonzero probability.
- Reject option: Chow, "On optimum recognition error and reject tradeoff", IEEE Trans. Inf. Theory 1970 (DOI 10.1109/TIT.1970.1054406). With calibrated posteriors, rejecting when max-posterior < 1 − c (c = cost of a rejection relative to an error) is optimal.
- Selective classification: Geifman & El-Yaniv, NeurIPS 2017 (arXiv 1705.08500). Pick a confidence threshold on held-out data to guarantee a target risk with high probability; their example is 2% top-5 ImageNet error "with probability 99.9%, and almost 60% test coverage". The practical tool is the risk-coverage curve.
- Conformal prediction gives set-valued output with a coverage guarantee (Angelopoulos & Bates, arXiv 2107.07511). Applied to LLM multiple-choice QA, Kumar et al. (arXiv 2305.18404, ICML 2023 workshop) found conformal uncertainty "tightly correlated with prediction accuracy".
  - Jev translation: calibrate q̂ on labelled queries, then return every tool with p ≥ 1 − q̂. The number of tools handed to the agent then adapts per query, with (1−α) coverage if the calibration data is exchangeable with production traffic.
- "None of the above" as an option (Kadavath et al., "Language Models (Mostly) Know What They Know", arXiv 2207.05221, §3.1): replacing an MMLU option with "none of the above" "reduces accuracy and calibration significantly". The model "seems strongly biased against using this option". The same models were "well calibrated on True/False distinctions".
  - Jev translation: put abstention in a `boolean` ("Can any listed tool do this?"), or in a per-finalist `boolean` fit check, rather than a `none` option in the `choice`. That this ordering holds for Jev is UNVERIFIED; test both.
- Vendor practice (primary, TypeSafe docs):
  - `confidence` "collapses that shape into a single number", and "low confidence on a Choice often means none of the options are a clea[r fit]" (https://docs.typesafe.ai/confidence.md).
  - The classification cookbook reads confidence rather than the winner's probability ("A winner at 0.45 with a runner-up at 0.44, and a winner at 0.45 with the rest of the weight scattered thinly, are different situations"). It reports "a confidence cutoff of 0.9 splits them in half. The confident half is right 90% of the time; the other half, 40%", on 60 filings. It also says "a Choice works reliably up to roughly 240 options" (https://docs.typesafe.ai/cookbooks/classification_using_confidence.md).
  - The skill cookbook suppresses suggestions when its three gate booleans average below 0.30, and FastMCP's `fit_threshold` is 0.3 (note 03, note 04).
- Signals to threshold on, in order of how cheap they are: max probability, margin p₁ − p₂, TypeSafe `confidence`, and a separate `boolean` P(fit). The library should log all four and pick the one with the best risk-coverage curve on labelled data. Do not hard-code 0.3.

### 5. Merging distributions from multiple chunks

Once a catalog exceeds 255 options, or when we deliberately use smaller calls to avoid 429s, the library has to combine per-chunk outputs.

- **Why raw probabilities don't merge.** A `choice` distribution is conditional on its option set. A chunk with no suitable tool spreads its mass over lookalikes, and a chunk with two suitable tools splits it. Chunk probabilities could be compared across chunks only if the model obeyed Luce's choice axiom (independence from irrelevant alternatives), p(i|S) = w_i / Σ_{j∈S} w_j. Whether Jev obeys it is UNVERIFIED. The generalized Bradley-Terry/Plackett-Luce models that assume it are fitted with Hunter's MM algorithm (Hunter, Annals of Statistics 2004, DOI 10.1214/aos/1079120141).
- **Rank-based merge (safe default): top-m per chunk, then a final round.**
  - This is TourRank's group stage and ListT5's m-ary tournament. The finalist set has the answer whenever the gold tool is in its chunk's top-m, so the ceiling is chunk-level recall@m.
  - As a proxy, whole-catalog Jev at 199 options had recall@5 of 89.9% (`RESULTS.md`), so expect roughly a 90% ceiling with m=5 and chunks of about 200.
  - Run a final `choice` over the finalists with full descriptions.
- **Multiple rounds with re-partitioning (TourRank-r).** Re-shuffle chunk membership and option order each round and add points: +1 per advance, or the probability itself. This averages out chunk-composition and position effects, and TourRank-2 already beat RankGPT. It costs ×r.
- **Anchored rescaling (proposal, untested).** Put the same 2–3 anchor tools in every chunk and rescale each chunk by w_i ∝ p(i|S)/p(anchor|S). This is valid only under IIA, and it breaks when anchors round to 0.00. Treat it as a research experiment, not a default.
- **Pointwise common scale.** Per-tool `boolean` P(fit) answers are on a common scale if they are calibrated, so they can be sorted globally across chunks. Many boolean questions can share one call (they share state). TypeSafe reports that batching 13 questions in one call was "12.2x cheaper and 10.0x faster with no change in answers" (note 03). The literature puts pointwise below listwise (Setwise Table 2: .654 vs .669–.678), and pointwise is where calibration matters most (PRP, Setwise).
- **Reciprocal rank fusion** (Cormack, Clarke & Büttcher, SIGIR 2009, DOI 10.1145/1571941.1572114): score = Σ 1/(k + rank) with k = 60. This is the standard way to fuse rankings from multiple rounds, permutations or retrievers without calibration. MCPProxy uses RRF k=60 for BM25+dense (note 04).
- Vendor hint: TypeSafe's launch blog says that "for the higher cardinality choices, we do a 2 stage-system of scoring independently then making an explicit choice" (note 03). Jev may already run pointwise-then-choice internally for big option sets. How that interacts with external chunking is UNVERIFIED.

### 6. Query rewriting, HyDE and raw user words for tool retrieval

- **ToolRet** (Shi et al., ACL 2025, arXiv 2503.01763). Tables 4 and 5, average nDCG@10, without → with instruction:

| model | without instruction | with instruction |
|---|---|---|
| BM25s | 22.32 | 36.46 |
| NV-Embed-v1 | 33.83 | 42.71 |
| gte-Qwen2-1.5B-inst | 28.96 | 45.96 |
| bge-reranker-v2-gemma | 35.51 | 47.52 |
| gpt-3.5-turbo-1106 RankGPT | 30.75 | 38.77 |

  - This confirms the Table 5 value that note 04 flagged as UNVERIFIED: BM25s is 36.46 with instructions.
  - LLM rerankers reranked NV-Embed-v1's candidates.
  - The instructions come from a "target-aware strategy": GPT-4o writes an instruction that "outlines the relevance criteria by bridging the query intent and the functionality of the target tools". 89.2% were judged correct and the rest were revised by experts. The instruction therefore contains information about the answer, so the w/ inst. numbers are an upper bound on what a real agent-written query can reach.
  - The gpt-3.5-turbo-0125 row's average cells (29.60 / 29.52) are the same in both tables even though its per-task cells differ (e.g. 30.29 without vs 37.22 with instruction on the first task), so the averages in the with-instruction table look like a copy error in the paper.
- **HyDE** (Gao et al., ACL 2023, https://aclanthology.org/2023.acl-long.99/): generate a hypothetical document, then embed it. On web search it lifted Contriever DL19 nDCG@10 from 44.5 to 61.3, with BM25 at 50.6. On tools it was mixed. On ToolE single-tool (199 tools) HyDE+BM25 recall@1 rose from 27.16% to 31.21%, but recall@5 fell from 46.18% to 43.37%, and multi-tool nDCG@5 fell from 0.2635 to 0.1954 (Re-Invoke Table 1; Table 6 prints the BM25 baseline as 0.2627).
- **Re-Invoke** extracts the tool-related intents from verbose queries and expands each tool document with 10 synthetic queries. Ablation (dense, ToolE single nDCG@5): baseline 0.6522, + query generator 0.7813, + intent extractor 0.6756, both 0.7821. Document expansion did most of the work on ToolE, where "documentation … only include the tool name and descriptions".
- **Our benchmark.** The agent's query beat the user's words by +27.6 pts for tuned BM25 (43.2% vs 15.6%). The Jev adapter sends the user's raw words (`state: "User request: …"` in `src/jev.ts`) and scored 74.6%.
- Jev recipe:
  - Keep the raw user words as `state`. Jev does the vocabulary bridging that rewriting does for BM25.
  - Rewrite only for a lexical or dense prefilter, and cache doc-side expansion (synthetic queries per tool, once at index time), which costs nothing per query.
  - TypeSafe's jaggedness page warns of "context rot" with a "large state full of irrelevant detail". A cheap intent-extraction step may help Jev on long chat histories. That is UNVERIFIED and worth one ablation.

### 7. Recipe table: calls and tokens per query

Our arithmetic: compact = 35 tokens per option, rich = 100 tokens per option, plus ~50 tokens of state and instructions per call, at $0.042/M. "Seq" is the number of sequential rounds, which sets latency.

| recipe | 200 tools: calls (seq) | 200 tools: tokens / $ | 2,000 tools: calls (seq) | 2,000 tools: tokens / $ | ceiling / risk |
|---|---|---|---|---|---|
| A. whole-catalog `choice` | 1 (1) | 7.0k / $0.00029 (rich 20k / $0.00084) | not possible (>255) | — | 48% refusals at 199 options in our run |
| B1. chunk tournament, 8×250 → top-5 → final 40 (full desc.) | n/a | — | 9 (2) | ~74k / $0.0031 (rich ~205k / $0.0086) | chunk recall@5, ~90% proxy |
| B2. chunk tournament, 20-option groups, top-2 advance | 10+1 = 11 (2) | ~8.3k / $0.00035 | 100+10+1 = 111 (3) | ~83k / $0.0035 | 111 req/query vs 1,200 req/min limit |
| C. B1 or B2 with r=2 re-partitioned rounds | 22 (2) | ~16.5k / $0.00069 | 18 (B1) (2) | ~148k / $0.0062 | cost ×r |
| D. BM25 top-K then `choice` | K=20: 1 (1) | ~0.75k / $0.00003 | K=250: 1 (1) | ~8.8k / $0.00037 | prefilter recall@K (80.2% at K=20, 199 tools) |
| E. re-check top-k: `choice` + k `boolean` fit (full desc.) | +1 (+1) | k=5: ~1.1k / $0.00005 | +1 (+1) | same | adds abstention |
| F. permutation averaging, P=3 on A | 3 (1) | ~21k / $0.00088 | on B1: 27 (2) | ~222k / $0.0093 | only if Jev is order-sensitive |
| G. PRP tie-break on top-2 when margin < δ | +1 (+1) | ~0.3k | +1 (+1) | ~0.3k | both orders in one call |
| H. pointwise `boolean` per tool, batched | 1 (1) | ~10k / $0.00042 | ~4 (1) | ~100k / $0.0042 | needs calibration, and the literature puts pointwise below listwise |

Throughput: Jev's published rate limits are 250,000 tokens/s and 1,200 requests/min, "adjusting dynamically" (note 03). B2 at 2,000 tools allows about 10 queries per minute per account on the request limit. B1 allows about 133.

## Implications for a Jev search library

1. **Primitive mapping.** `choice` = setwise/FIRST listwise ranker. `score` = graded pointwise with a built-in expected-relevance output. The score's probability-weighted mean is exactly the expected-relevance ("ER") scoring from "Beyond Yes and No", which beat generated labels (0.4992 vs 0.3989 with 3 levels; 4 levels were on par with 3). ER and peak-relevance ("PR") scoring were close: PR scored 0.5005 with 3 levels, ER was ahead with the other two prompts (Table 3). `boolean` = pointwise P(fit), for gates and cross-chunk scores. Rank by distributions, never by `choice` alone.
2. **Size-adaptive planner** (proposal):
   - N ≤ ~240 and fits the 32k budget: one `choice` (A), then the re-check (E).
   - 240 < N ≤ ~5k: chunk tournament (B1), with chunk size set by the tighter of 255 options or 32k tokens, and seeded group assignment like TourRank's.
   - Offer an optional lexical/dense prefilter (D) as a cost mode, and report its recall ceiling to the caller.
   - Make chunk size configurable so users can trade calls for fewer 429s (B2).
3. **Default merge = rank-based.** Take the top-m per chunk (m = 5) into a final `choice` over the finalists with full descriptions. Add re-partitioned rounds only when evaluation shows gains. Do not sort raw probabilities across chunks.
4. **Abstention is a separate `boolean`.** Return `{ tools, abstained, signals: { maxP, margin, confidence, pFit } }`. Ship a calibration helper that fits the threshold (or a conformal q̂) from a user's labelled queries and prints a risk-coverage table.
5. **Adaptive k.** Instead of a fixed top-5, return the smallest set whose cumulative probability ≥ 1 − α, capped at k_max. That is conformal-style output, and it fits "load these tools into context".
6. **Order hygiene.** Shuffle option order deterministically (seeded by query hash) so results are reproducible, but not tied to catalog order. If the order-sensitivity experiment shows an effect, expose `permutations: P`.
7. **Two-description index.** Keep a short description (for the recall pass and chunk rounds) and a full description (for finalists). This mirrors TypeSafe's skill cookbook and FastMCP's wide pass plus close read, and it is where most of the token savings come from at 2,000 tools.
8. **Handle rounding.** Probabilities come in steps of 0.01. Break ties with a secondary signal (chunk-local rank, BM25, or catalog order, as the bench adapter already does). Never take log(0).
9. **Measure before building the fancy parts.** The benchmark harness can answer the open questions below with fewer than 2,000 Jev calls (our arithmetic: 200 queries × ~10 variants). Permutation averaging, anchored rescaling and pointwise-global ranking should stay out of v1 unless those numbers justify them.

## Open questions

1. Is Jev's `choice` order-sensitive? Measure the top-1 flip rate under shuffles, and hit@1 by the gold tool's position.
2. Does Jev satisfy IIA closely enough that p(i|S)/p(j|S) is stable across option sets? If it does, cross-chunk rescaling becomes possible.
3. What is Jev's ECE on tool selection, for max-prob, margin, `confidence` and `boolean` P(fit)? Which signal gives the best risk-coverage curve?
4. Holding recall fixed, does accuracy drop from 20 → 100 → 250 options? Our 74.6% vs 70.6% mixes the recall ceiling with any cardinality effect. Answer it by running Jev on 20-option sets that always contain the gold tool.
5. Does Jev's internal "2-stage" mode for high cardinality make external chunking redundant or harmful? At what option count does it switch on?
6. For "no tool fits", is a separate `boolean` gate better than a `none` option inside the `choice`? The LLM evidence (Kadavath) says a separate gate, but this is untested for Jev.
7. Does intent extraction or rewriting help Jev on long, noisy states, as the "context rot" warning suggests? It does not seem to matter for short MetaTool requests (74.6% on raw words).
8. At 2,000 tools, how does embedding or hybrid recall@250 compare with the chunk tournament's chunk-level recall@5? This decides whether D or B1 should be the default at scale.
9. Are the 429 refusals a function of option count, tokens, or just launch-week capacity? The chunk-size default depends on it (48.4% at 199 options vs 0.4% at 20 in our run, second week after launch).

## Sources

Papers (primary, arXiv abstract plus HTML tables read):
- Sun et al., "Is ChatGPT Good at Search? Investigating Large Language Models as Re-Ranking Agents", EMNLP 2023. https://arxiv.org/abs/2304.09542 ; https://arxiv.org/html/2304.09542
- Qin et al., "Large Language Models are Effective Text Rankers with Pairwise Ranking Prompting", NAACL 2024 Findings. https://arxiv.org/abs/2306.17563 ; https://aclanthology.org/2024.findings-naacl.97/
- Zhuang et al., "A Setwise Approach for Effective and Highly Efficient Zero-shot Ranking with Large Language Models", SIGIR 2024. https://arxiv.org/abs/2310.09497 ; https://arxiv.org/html/2310.09497
- Podolak et al., "Beyond Reproducibility: Advancing Zero-shot LLM Reranking Efficiency with Setwise Insertion", 2025. https://arxiv.org/abs/2504.10509 (abstract only)
- Reddy et al., "FIRST: Faster Improved Listwise Reranking with Single Token Decoding", EMNLP 2024. https://aclanthology.org/2024.emnlp-main.491/ ; https://arxiv.org/abs/2406.15657
- Chen et al., "An Early FIRST Reproduction and Improvements to Single-Token Decoding for Fast Listwise Reranking", 2024. https://arxiv.org/abs/2411.05508 (abstract only)
- Chen et al., "TourRank: Utilizing Large Language Models for Documents Ranking with a Tournament-Inspired Strategy", WWW 2025. https://arxiv.org/abs/2406.11678 ; https://arxiv.org/html/2406.11678 ; DOI 10.1145/3696410.3714863
- Yoon et al., "ListT5: Listwise Reranking with Fusion-in-Decoder Improves Zero-shot Retrieval", ACL 2024. https://arxiv.org/abs/2402.15838 (abstract only)
- Parry et al., "Top-Down Partitioning for Efficient List-Wise Ranking", 2024. https://arxiv.org/abs/2405.14589
- Tang et al., "Found in the Middle: Permutation Self-Consistency Improves Listwise Ranking in Large Language Models", NAACL 2024. https://arxiv.org/abs/2310.07712 ; https://arxiv.org/html/2310.07712
- Liu et al., "Lost in the Middle: How Language Models Use Long Contexts", TACL 2024. https://arxiv.org/abs/2307.03172
- Zheng et al., "Large Language Models Are Not Robust Multiple Choice Selectors", ICLR 2024. https://arxiv.org/abs/2309.03882
- Zhuang et al., "Beyond Yes and No: Improving Zero-Shot LLM Rankers via Scoring Fine-Grained Relevance Labels", NAACL 2024. https://arxiv.org/abs/2310.14122
- Jacob et al., "Drowning in Documents: Consequences of Scaling Reranker Inference", ReNeuIR @ SIGIR 2025. https://arxiv.org/abs/2411.11767
- Guo et al., "On Calibration of Modern Neural Networks", ICML 2017. https://arxiv.org/abs/1706.04599
- Chow, "On optimum recognition error and reject tradeoff", IEEE Trans. Inf. Theory, 1970. https://doi.org/10.1109/TIT.1970.1054406 (metadata via Crossref)
- Geifman & El-Yaniv, "Selective Classification for Deep Neural Networks", NeurIPS 2017. https://arxiv.org/abs/1705.08500
- Angelopoulos & Bates, "A Gentle Introduction to Conformal Prediction and Distribution-Free Uncertainty Quantification". https://arxiv.org/abs/2107.07511
- Kumar et al., "Conformal Prediction with Large Language Models for Multi-Choice Question Answering", ICML 2023 workshop. https://arxiv.org/abs/2305.18404
- Kadavath et al., "Language Models (Mostly) Know What They Know", 2022. https://arxiv.org/abs/2207.05221
- Hunter, "MM algorithms for generalized Bradley-Terry models", Annals of Statistics 32(1), 2004. https://doi.org/10.1214/aos/1079120141
- Cormack, Clarke & Büttcher, "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods", SIGIR 2009. https://doi.org/10.1145/1571941.1572114
- Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance Labels" (HyDE), ACL 2023. https://aclanthology.org/2023.acl-long.99/ ; https://arxiv.org/abs/2212.10496
- Shi et al., "Retrieval Models Aren't Tool-Savvy: Benchmarking Tool Retrieval for Large Language Models" (ToolRet), ACL 2025. https://arxiv.org/abs/2503.01763 ; https://arxiv.org/html/2503.01763
- Chen et al., "Re-Invoke: Tool Invocation Rewriting for Zero-Shot Tool Retrieval", EMNLP 2024 Findings. https://arxiv.org/abs/2408.01875 ; https://arxiv.org/html/2408.01875

Vendor docs (primary):
- https://docs.typesafe.ai/confidence.md
- https://docs.typesafe.ai/cookbooks/classification_using_confidence.md
- https://docs.typesafe.ai/llms.txt

Internal:
- `research/tool-search/03-jev-model-and-evaluate-api.md`, `research/tool-search/04-tool-search-landscape.md`, `research/00-benchmark-results.md`
- `src/jev.ts` (Jev adapter: raw user words as state, rank by probability, tie-break for rounded zeros)

## Verification log

Adversarial check on 2026-09-25. Each claim was re-read at the source listed (arXiv HTML fetched with curl and parsed to text, arXiv API abstracts, TypeSafe docs as raw `.md`, and the repo files).

| # | Claim | Verdict | Source checked |
|---|---|---|---|
| 1 | Setwise Table 2 (Flan-T5-large, DL19): listwise.likelihood .669 / 10 s, listwise.generation .561 / 54.2 s, pointwise .654, setwise.heapsort .670, setwise.bubblesort .678, and the inference/token counts | CONFIRMED (token counts are rounded from e.g. 16,111.6) | https://arxiv.org/html/2310.09497 |
| 2 | Setwise quotes "far more robust" and "calibration is not necessary"; c=3; 512-token cap | CONFIRMED | https://arxiv.org/html/2310.09497 |
| 3 | Beyond Yes and No: ER 0.4992 vs generated 0.3989; ER "found best" | CORRECTED: numbers right (RG-3L, Table 3), but PR scored 0.5005 for RG-3L, so ER is not uniformly best | https://arxiv.org/html/2310.14122 |
| 4 | RankGPT DL19: BM25 50.58, gpt-3.5 65.80, gpt-4 75.59; random order 25.17, reverse 32.77 | CONFIRMED | https://arxiv.org/html/2304.09542 (Tables 1, 5) |
| 5 | RankGPT window ablation: w=80 "worse on every metric" | CORRECTED: w=80 has the worst nDCG@1 only; its nDCG@5/10 beat w=60 | https://arxiv.org/html/2304.09542 (Table 12) |
| 6 | RankGPT Table 11 costs (19,960 tokens / $0.040; 19,890 / $0.596; 3,271 / 1 request / $0.098) and "1/5" cascade | CONFIRMED | https://arxiv.org/html/2304.09542 |
| 7 | PRP DL19 nDCG@10 FLAN-UL2: 72.42 / 71.88 / 72.65; "very difficult" calibration quote | CONFIRMED | https://arxiv.org/html/2306.17563 |
| 8 | TourRank Table 2 (68.19, 68.16, 68.18, 66.23, 69.54, 71.63), BEIR 49.46 vs 49.37, Table 7 stage config, 13 calls in 5 stages, "almost no effect", 30 requests/s | CONFIRMED | https://arxiv.org/html/2406.11678 |
| 9 | Permutation self-consistency "7–18% for GPT-3.5", "67% of twenty", temperature "little effect", SPLADE++ +7.26 | CORRECTED (context): quotes accurate, but on passage reranking the average relative gains were 0.4% / 2% / 5% (RankVicuna / GPT-3.5 / GPT-4); added to TL;DR and §2 | https://arxiv.org/html/2310.07712 ; https://arxiv.org/abs/2310.07712 |
| 10 | Zheng et al.: 67.2 → 60.9, token bias, "no remarkable reduction", removing IDs "usually degrades", PriDe on ~5% | CONFIRMED | https://arxiv.org/html/2309.03882 |
| 11 | Kadavath: "none of the above" "reduces accuracy and calibration significantly", "strongly biased against", well calibrated on True/False | CONFIRMED | https://arxiv.org/html/2207.05221 (§3.1) |
| 12 | Re-Invoke ToolE single-tool recall@1/@5 table; 20,550 queries, 199 tools | CORRECTED: Re-Invoke + embeddings (text-bison) recall@1 is 67.15%, not 67.16% (67.16 is its nDCG@1); rest confirmed | https://arxiv.org/html/2408.01875 (Tables 5, 6) |
| 13 | HyDE on ToolE multi-tool BM25 nDCG@5 0.2635 → 0.1954; ablation 0.6522 / 0.7813 / 0.6756 / 0.7821 | CONFIRMED, with a note that Table 6 prints the BM25 baseline as 0.2627 | https://arxiv.org/html/2408.01875 (Tables 1, 3, 6) |
| 14 | ToolRet avg nDCG@10 without → with instruction (BM25s 22.32 → 36.46, etc.), MonoT5 33.83 → 28.92, target-aware GPT-4o instructions, 89.2% | CONFIRMED | https://arxiv.org/html/2503.01763 |
| 15 | ToolRet gpt-3.5-turbo-0125 "row identical in both tables" | CORRECTED: only the average cells repeat; per-task cells differ | https://arxiv.org/html/2503.01763 |
| 16 | FIRST "accelerates inference by 50%"; reproduction "21%-42%" and "does not compromise out-of-domain reranking quality" | CONFIRMED | https://arxiv.org/abs/2406.15657 ; https://arxiv.org/abs/2411.05508 |
| 17 | Setwise Insertion 31% / 23%; top-down partitioning ~33% and start-of-window bias; ListT5 +1.3; Drowning in Documents "degrade quality beyond a certain limit", K > 5,000 | CONFIRMED | https://arxiv.org/abs/2504.10509 ; https://arxiv.org/abs/2405.14589 ; https://arxiv.org/abs/2402.15838 ; https://arxiv.org/html/2411.11767 |
| 18 | Lost in the Middle closed-book 56.1%; Geifman 2% / 99.9% / ~60%; Kumar "tightly correlated", ICML 2023 workshop | CONFIRMED | https://arxiv.org/pdf/2307.03172 ; https://arxiv.org/abs/1705.08500 ; https://arxiv.org/abs/2305.18404 |
| 19 | TypeSafe confidence quotes; classification cookbook: 0.9 cutoff, 90% / 40%, 60 filings, "roughly 240 options", 0.45 vs 0.44 example | CONFIRMED | https://docs.typesafe.ai/confidence.md ; https://docs.typesafe.ai/cookbooks/classification_using_confidence.md |
| 20 | Skill cookbook gate 0.30, 60-char index descriptions, top 3 re-read; rate limits 250,000 tokens/s and 1,200 req/min "adjusting dynamically"; 64k/32k context; "context rot" | CONFIRMED | https://docs.typesafe.ai/cookbooks/skill_suggestion.md ; https://docs.typesafe.ai/models.md ; https://docs.typesafe.ai/model-jaggedness/jev-1.13.md |
| 21 | Benchmark numbers: 74.6 / 70.6 hit@1, +4.0 [0.5, 7.3], recall@20 86 / 81.5 / 80.2%, 27 of 35, 95 of 97, recall@5 89.9%, 48.4% vs 0.4% refusals, $0.28 and $0.03 per 1k, 43.2% vs 15.6%, second week after launch; adapter sends `User request: …` and tie-breaks rounded zeros | CONFIRMED | `research/00-benchmark-results.md` ; `src/jev.ts` |
| 22 | Recipe arithmetic (35 / 100 tokens per option + 50 per call, $0.042/M) | CORRECTED: B2 is ~8.3k / $0.00035 at 200 tools and ~83k / $0.0035 at 2,000 (was 7.8k and 78k); C at 200 tools ~16.5k / $0.00069; TL;DR B1 token figure aligned with the table (72–74k). Other rows and the 10 vs 133 queries/min throughput check out | our arithmetic |

Totals: 16 CONFIRMED, 6 CORRECTED, 0 UNVERIFIED in this pass. The UNVERIFIED markers already in the body (Jev's calibration on tools, IIA, token bias under name keys, internal 2-stage mode, intent extraction on long states) remain open; none of them has a primary source to check against.
