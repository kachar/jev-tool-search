// Blind adjudication of misses: is Jev's pick a defensible answer that MetaTool's single label misses?
//   tsx --env-file=.env.local experiments/judge-misses.ts exp-round2 t2-6x4
import { readFile, writeFile } from "node:fs/promises";
import { generateText } from "ai";
import { mapConcurrent } from "../src/runner";
import { loadDataset, type Row } from "./lib";

const [file, strategyId, mode = "normal"] = process.argv.slice(2) as [string, string, ("normal" | "swapped" | "random")?];
const JUDGE = "anthropic/claude-sonnet-5";
const dataset = await loadDataset();
const tools = new Map(dataset.tools.map((t) => [t.name, t.description]));
const requests = new Map(dataset.queries.map((q) => [q.id, q.request]));
const rows = (await readFile(new URL(`../results/${file}.jsonl`, import.meta.url), "utf8"))
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row & { retrieverId?: string })
  // Also reads the prior benchmark's rows (results/main.jsonl: `retrieverId`, several catalog sizes).
  .map((r) => ({ ...r, strategyId: r.strategyId ?? r.retrieverId! }))
  .filter((r) => r.strategyId === strategyId && r.catalogSize === 199 && r.queryId.startsWith("single-"))
  .filter((r) => !r.error && r.ranking.length > 0 && !r.relevant.includes(r.ranking[0]!));

const verdicts = await mapConcurrent(rows, 6, async (row) => {
  const labeled = row.relevant[0]!;
  // Control "random": a random other tool in place of Jev's pick; the judge should prefer the label.
  const others = dataset.tools.map((t) => t.name).filter((n) => !row.relevant.includes(n));
  const chosen = mode === "random" ? others[(row.queryId.charCodeAt(7) * 31 + row.queryId.charCodeAt(9)) % others.length]! : row.ranking[0]!;
  // Control "swapped": the opposite A/B order from the normal run, to expose position bias.
  const swap = (row.queryId.charCodeAt(row.queryId.length - 1) % 2 === 0) !== (mode === "swapped");
  const [a, b] = swap ? [chosen, labeled] : [labeled, chosen];
  const { text } = await generateText({
    model: JUDGE,
    prompt: `A user sent this request to an AI assistant:\n"${requests.get(row.queryId)}"\n\nThe assistant can call exactly one of two tools.\nTool A: ${a} - ${tools.get(a)}\nTool B: ${b} - ${tools.get(b)}\n\nWhich tool is the better first call for this request? Answer with exactly one word: A, B, or BOTH (if they would serve it about equally well).`,
  });
  const answer = text.trim().toUpperCase().replace(/[^AB OTH]/g, "").split(/\s+/)[0];
  const verdict = answer === "BOTH" ? "both" : (answer === "A") === (a === chosen) ? "jev" : "label";
  return { queryId: row.queryId, labeled, chosen, verdict };
});
const count = (v: string) => verdicts.filter((x) => x.verdict === v).length;
console.log(`[${mode}] ${verdicts.length} misses judged by ${JUDGE}: label better ${count("label")}, Jev's pick better ${count("jev")}, both fine ${count("both")}`);
await writeFile(new URL(`../results/judge-${file}-${strategyId}-${mode}.json`, import.meta.url), JSON.stringify(verdicts, null, 2));
