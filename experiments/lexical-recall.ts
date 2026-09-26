// Recall@k of lexical first stages on the 199-tool catalog: the ceiling any "BM25 top-k, then Jev"
// pipeline can reach. No network calls.
import { create, insertMultiple, search } from "@orama/orama";
import { extractKeywords, normalizeQuery, splitIdentifier } from "../src/bm25";
import { catalogOf } from "./lib";

const { catalog, single } = await catalogOf(199);
type Variant = { id: string; keywordsAsString: boolean; stemming: boolean };
const variants: Variant[] = [
  { id: "production (keywords string[])", keywordsAsString: false, stemming: false },
  { id: "keywords joined", keywordsAsString: true, stemming: false },
  { id: "keywords joined + stemming", keywordsAsString: true, stemming: true },
];
const K = [5, 10, 20, 40];
const rows = [];
for (const variant of variants) {
  const db = create({
    schema: { name: "string", displayName: "string", description: "string", keywords: variant.keywordsAsString ? "string" : "string[]" } as const,
    components: { tokenizer: { stemming: variant.stemming, language: "english" } },
  });
  await insertMultiple(db, catalog.map((tool) => ({
    name: tool.name,
    displayName: splitIdentifier(tool.name),
    description: tool.description,
    keywords: variant.keywordsAsString ? extractKeywords(tool).join(" ") : extractKeywords(tool),
  })) as never);
  const rank = async (term: string) =>
    (await search(db, { term: normalizeQuery(term), properties: ["name", "displayName", "description", "keywords"], boost: { name: 2.5, displayName: 2, keywords: 1.8, description: 1.5 }, tolerance: 1, limit: 199 })).hits.map((h) => h.document.name as string);
  for (const input of ["request", "keywords", "union"] as const) {
    const recalls = K.map(() => 0);
    let hits = 0;
    for (const query of single) {
      const ranking = input === "union"
        ? [...new Set((await Promise.all([rank(query.keywords!), rank(query.request)])).flatMap((r, i) => r.map((n, j) => [j * 2 + i, n] as const)).sort((a, b) => a[0] - b[0]).map(([, n]) => n))]
        : await rank(input === "request" ? query.request : query.keywords!);
      hits += ranking.length;
      K.forEach((k, i) => { recalls[i]! += ranking.slice(0, k).some((n) => query.relevant.includes(n)) ? 1 : 0; });
    }
    rows.push({ variant: variant.id, input, meanHits: Math.round(hits / single.length), ...Object.fromEntries(K.map((k, i) => [`recall@${k}`, `${((recalls[i]! / single.length) * 100).toFixed(1)}%`])) });
  }
}
console.table(rows);
