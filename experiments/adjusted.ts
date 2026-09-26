// Judge-adjusted hit@1: a miss counts as correct when the blind judge preferred the arm's pick in
// both position orders. Paired bootstrap between arms judged on the same requests.
//   tsx experiments/adjusted.ts exp-final:single-full+hedged exp-final:t2-6x4 main:rerank ...
import { readFile } from "node:fs/promises";
import { pairedDifference } from "../src/stats";

type Verdict = { queryId: string; verdict: string };
type Row = { queryId: string; catalogSize: number; ranking: string[]; relevant: string[]; strategyId?: string; retrieverId?: string };
const results = new URL("../results/", import.meta.url);
const read = async <T,>(name: string) => JSON.parse(await readFile(new URL(name, results), "utf8")) as T;

const arms = await Promise.all(
  process.argv.slice(2).map(async (spec) => {
    const [file, arm] = spec.split(":") as [string, string];
    const rows = (await readFile(new URL(`${file}.jsonl`, results), "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Row)
      .filter((row) => (row.strategyId ?? row.retrieverId) === arm && row.catalogSize === 199 && row.queryId.startsWith("single-"));
    const [normal, swapped] = await Promise.all(["normal", "swapped"].map((mode) => read<Verdict[]>(`judge-${file}-${arm}-${mode}.json`)));
    const verdict = (list: Verdict[]) => new Map(list.map((v) => [v.queryId, v.verdict]));
    const [a, b] = [verdict(normal!), verdict(swapped!)];
    const scores = new Map(rows.map((row) => [row.queryId, row.relevant.includes(row.ranking[0]!) || (a.get(row.queryId) === "jev" && b.get(row.queryId) === "jev") ? 1 : 0]));
    const strict = rows.filter((row) => row.relevant.includes(row.ranking[0]!)).length;
    return { spec, scores, strict: strict / rows.length, judged: normal!.length, agree: [...a].filter(([q, v]) => b.get(q) === v).length };
  })
);
const ids = [...arms[0]!.scores.keys()].filter((q) => arms.every((arm) => arm.scores.has(q)));
for (const arm of arms) {
  const adjusted = ids.reduce((sum, q) => sum + arm.scores.get(q)!, 0) / ids.length;
  console.log(`${arm.spec}: strict ${(arm.strict * 100).toFixed(1)}%, adjusted ${(adjusted * 100).toFixed(1)}%, judged misses ${arm.judged}, order-consistent ${arm.agree}`);
}
const [base, ...rest] = arms;
for (const arm of rest) {
  const d = pairedDifference(ids.map((q) => arm.scores.get(q)!), ids.map((q) => base!.scores.get(q)!));
  console.log(`${arm.spec} vs ${base!.spec}: ${(d.mean * 100).toFixed(1)} [${(d.low * 100).toFixed(1)}, ${(d.high * 100).toFixed(1)}] (n = ${ids.length})`);
}
