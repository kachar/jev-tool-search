// Runs one experiment group over the 199-tool MetaTool catalog.
//   tsx --env-file=.env.local experiments/run.ts --group chunking [--limit 40] [--pin typesafe-ai]
import { parseArgs } from "node:util";
import { BACKOFF, catalogOf, runExperiment, type Provider, type Strategy } from "./lib";
import { closeRead, degrade, engineStrategy, tournamentV2, unionPrefilter, FAST_RETRY, HEDGED, prefilter, randomN, single, tournament, withRetry } from "./strategies";

const GROUPS: Record<string, () => Strategy[]> = {
  cardinality: () => [20, 50, 100, 150, 199].map(randomN),
  chunking: () => [
    single(),
    tournament({ parts: 4, keep: 3, mode: "batched" }),
    tournament({ parts: 4, keep: 3, mode: "parallel" }),
    tournament({ parts: 4, keep: 3, mode: "batched", final: false }),
    tournament({ parts: 8, keep: 2, mode: "batched" }),
  ],
  text: () => [single("name"), single("short"), single("full", true)],
  prefilter: () => [10, 20, 40, 80].map(prefilter),
  abstain: () => [closeRead(3), closeRead(3, true)],
  retry: () => [
    withRetry(single(), BACKOFF, "backoff"),
    withRetry(single(), FAST_RETRY, "fast"),
    withRetry(single(), HEDGED, "hedged"),
    degrade(),
  ],
  round2: () => [tournamentV2({ parts: 6, keep: 4 }), tournamentV2({ parts: 6, keep: 4, selfConsistency: true }), unionPrefilter(40)],
  engine: () => [engineStrategy("catalog"), engineStrategy("shortlist")],
  // Interleaved head-to-head of every contender for the default (review finding: earlier pairs crossed runs).
  final: () => [
    withRetry(single(), FAST_RETRY, "fast"),
    withRetry(single(), HEDGED, "hedged"),
    tournamentV2({ parts: 6, keep: 4 }),
    unionPrefilter(40),
    engineStrategy("catalog"),
    engineStrategy("shortlist"),
  ],
  // Engine ablation: option text × request budget, interleaved.
  ablation: () => [
    engineStrategy("catalog", { optionChars: 60, requestTokens: 1200 }, "-60c-1200"),
    engineStrategy("catalog", { optionChars: 1000, requestTokens: 1200 }, "-full-1200"),
    engineStrategy("catalog", { optionChars: 60, requestTokens: 1600 }, "-60c-1600"),
    engineStrategy("catalog", { optionChars: 1000, requestTokens: 1600 }, "-full-1600"),
    engineStrategy("shortlist", { optionChars: 1000, requestTokens: 1600 }, "-full-1600"),
    withRetry(single(), HEDGED, "hedged"),
  ],
  // Confirmation of the cascade engine (direct hedged → tournament → BM25), interleaved.
  cascade2: () => [
    engineStrategy("catalog", {}, "-cascade2"),
    withRetry(single(), HEDGED, "hedged"),
    tournamentV2({ parts: 6, keep: 4 }),
  ],
  cascade: () => [
    engineStrategy("catalog", {}, "-cascade"),
    engineStrategy("shortlist", {}, "-cascade"),
    withRetry(single(), HEDGED, "hedged"),
    tournamentV2({ parts: 6, keep: 4 }),
  ],
  pin: () => [randomN(50), randomN(199)],
};

const { values } = parseArgs({
  options: {
    group: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    pin: { type: "string" },
    tag: { type: "string" },
  },
});
const group = values.group!;
const { catalog, single: queries } = await catalogOf(199);
const sample = values.limit ? queries.slice(0, Number(values.limit)) : queries;
const rows = await runExperiment({
  experiment: `exp-${group}${values.tag ? `-${values.tag}` : ""}`,
  strategies: GROUPS[group]!(),
  queries: sample,
  catalog,
  concurrency: Number(values.concurrency),
  pin: values.pin as Provider | undefined,
});
console.log(`${rows.length} rows`);
