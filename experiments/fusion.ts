// Offline: does mixing round-1 (chunk) probabilities into the final help? Reads stored t2-* rows.
//   tsx experiments/fusion.ts exp-round2 t2-6x4
import { readFile } from "node:fs/promises";
import type { Row } from "./lib";

const [file, strategyId] = process.argv.slice(2) as [string, string];
const rows = (await readFile(new URL(`../results/${file}.jsonl`, import.meta.url), "utf8"))
  .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row)
  .filter((row) => row.strategyId === strategyId && !row.error);

type Rule = (final: number, round1: number) => number;
const rules: Record<string, Rule> = {
  "final only": (final) => final,
  "final × round-1": (final, round1) => final * round1,
  "final + round-1": (final, round1) => final + round1,
  "round-1 only": (_, round1) => round1,
};
for (const [name, rule] of Object.entries(rules)) {
  // Ties on the fused score are broken by the stored ranking (final order, then round-1, then BM25).
  const correct = rows.filter((row) => {
    const round1 = row.extra!.round1 as Record<string, number>;
    const final = row.top!.probabilities!;
    const position = (id: string) => row.ranking.indexOf(id);
    const best = Object.keys(round1).sort((a, b) => rule(final[b] ?? 0, round1[b]!) - rule(final[a] ?? 0, round1[a]!) || position(a) - position(b))[0]!;
    return row.relevant.includes(best);
  }).length;
  console.log(`${name}: ${((correct / rows.length) * 100).toFixed(1)}% (n = ${rows.length})`);
}
