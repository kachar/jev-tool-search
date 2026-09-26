// Summarizes experiment JSONL files: accuracy, reliability, latency, cost, calibration, abstention.
//   tsx experiments/analyze.ts exp-chunking [exp-text ...] [--baseline single-full]
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { METRICS } from "../src/metrics";
import { bootstrapMean, mean, pairedDifference, percentile } from "../src/stats";
import type { Row } from "./lib";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { baseline: { type: "string" }, json: { type: "boolean", default: false } },
});
const RESULTS = new URL("../results/", import.meta.url).pathname;

const rows: Row[] = [];
for (const name of positionals) {
  const text = await readFile(`${RESULTS}${name}.jsonl`, "utf8");
  rows.push(...text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row));
}

const byStrategy = Map.groupBy(rows, (row) => row.strategyId);
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const hit1 = (row: Row) => METRICS.hit1(row.ranking, row.relevant);

const table = [...byStrategy].map(([strategyId, group]) => {
  const calls = group.flatMap((row) => row.calls);
  const attempts = calls.reduce((sum, call) => sum + call.failures.length + (call.error ? 0 : 1), 0);
  const failed = calls.reduce((sum, call) => sum + call.failures.length, 0);
  const ok = group.filter((row) => !row.error);
  const h = bootstrapMean(group.map(hit1));
  return {
    strategy: strategyId,
    n: group.length,
    errors: group.length - ok.length,
    hit1: `${pct(h.mean)} [${pct(h.low)}, ${pct(h.high)}]`,
    recall5: pct(mean(group.map((row) => METRICS.recall5(row.ranking, row.relevant)))),
    mrr: mean(group.map((row) => METRICS.mrr(row.ranking, row.relevant))).toFixed(3),
    refusedAttempts: pct(attempts ? failed / attempts : 0),
    callsPerQuery: (calls.length / group.length).toFixed(2),
    p50ms: Math.round(percentile(ok.map((row) => row.latencyMs), 0.5)),
    p95ms: Math.round(percentile(ok.map((row) => row.latencyMs), 0.95)),
    // Latency of the successful attempts only: the price of the algorithm, not of the retry policy.
    p50CleanMs: Math.round(percentile(ok.filter((r) => r.calls.every((c) => c.failures.length === 0)).map((r) => r.latencyMs), 0.5)),
    tokensPerQuery: Math.round(mean(ok.map((row) => row.calls.reduce((sum, call) => sum + call.inputTokens, 0)))),
    usdPer1k: (mean(ok.map((row) => row.calls.reduce((sum, call) => sum + call.costUsd, 0))) * 1000).toFixed(3),
  };
});
console.table(table);

if (values.baseline) {
  const base = new Map((byStrategy.get(values.baseline) ?? []).map((row) => [row.queryId, row]));
  const diffs = [...byStrategy]
    .filter(([id]) => id !== values.baseline)
    .map(([strategyId, group]) => {
      const paired = group.filter((row) => base.has(row.queryId));
      const d = pairedDifference(paired.map(hit1), paired.map((row) => hit1(base.get(row.queryId)!)));
      const agree = mean(paired.map((row) => (row.ranking[0] === base.get(row.queryId)!.ranking[0] ? 1 : 0)));
      return {
        strategy: strategyId,
        vs: values.baseline,
        n: paired.length,
        hit1Diff: `${(d.mean * 100).toFixed(1)} [${(d.low * 100).toFixed(1)}, ${(d.high * 100).toFixed(1)}]`,
        sameTop1: pct(agree),
      };
    });
  console.table(diffs);
}

// Reliability by question size: share of attempts refused, grouped by options per request.
const bySize = Map.groupBy(rows.flatMap((row) => row.calls), (call) => (call.options <= 25 ? "≤25" : call.options <= 60 ? "26-60" : call.options <= 120 ? "61-120" : call.options <= 170 ? "121-170" : "171+"));
console.table(
  [...bySize].map(([size, calls]) => {
    const failed = calls.reduce((sum, call) => sum + call.failures.length, 0);
    const clean = calls.filter((call) => !call.error).map((call) => call.latencyMs);
    return {
      optionsPerRequest: size,
      calls: calls.length,
      refused: pct(failed / (failed + calls.filter((call) => !call.error).length)),
      p50ms: Math.round(percentile(clean, 0.5)),
      p95ms: Math.round(percentile(clean, 0.95)),
    };
  })
);

// Calibration of the top choice probability (single-call strategies): 10-bin ECE.
for (const [strategyId, group] of byStrategy) {
  const scored = group.filter((row) => row.top?.probabilities && Object.keys(row.top.probabilities).length > 0 && !row.error && !row.extra?.outOfCatalog);
  if (scored.length < 50) continue;
  const points = scored.map((row) => ({
    p: Math.max(...Object.values(row.top!.probabilities!)),
    correct: row.relevant.includes(Object.entries(row.top!.probabilities!).sort((a, b) => b[1] - a[1])[0]![0]) ? 1 : 0,
  }));
  const bins = Map.groupBy(points, ({ p }) => Math.min(9, Math.floor(p * 10)));
  const ece = [...bins.values()].reduce(
    (sum, bin) => sum + (bin.length / points.length) * Math.abs(mean(bin.map((b) => b.p)) - mean(bin.map((b) => b.correct))),
    0
  );
  console.log(`${strategyId}: ECE(top prob) ${ece.toFixed(3)}, mean top prob ${mean(points.map((b) => b.p)).toFixed(3)}, accuracy of top ${mean(points.map((b) => b.correct)).toFixed(3)}`);
}

// Abstention: separate in-catalog from out-of-catalog by a score; AUROC plus a threshold table.
const inCat = rows.filter((row) => row.extra?.fits && !row.extra.outOfCatalog && !row.error);
const outCat = rows.filter((row) => row.extra?.outOfCatalog && !row.error);
if (inCat.length && outCat.length) {
  const signals: Record<string, (row: Row) => number> = {
    topProbability: (row) => Math.max(...Object.values(row.top!.probabilities!)),
    confidence: (row) => row.top!.confidence ?? 0,
    maxFit: (row) => Math.max(...Object.values(row.extra!.fits as Record<string, number>)),
  };
  for (const [name, signal] of Object.entries(signals)) {
    const pos = inCat.map(signal);
    const neg = outCat.map(signal);
    const auroc = mean(pos.map((p) => mean(neg.map((n) => (p > n ? 1 : p === n ? 0.5 : 0)))));
    const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((t) => ({
      signal: name,
      threshold: t,
      keptInCatalog: pct(mean(pos.map((p) => (p >= t ? 1 : 0)))),
      // Of kept in-catalog rows, how many had the right top tool.
      keptCorrect: pct(mean(inCat.filter((row) => signal(row) >= t).map(hit1))),
      rejectedOutOfCatalog: pct(mean(neg.map((n) => (n < t ? 1 : 0)))),
    }));
    console.log(`${name}: AUROC in-catalog vs out-of-catalog ${auroc.toFixed(3)}`);
    console.table(thresholds);
  }
}
