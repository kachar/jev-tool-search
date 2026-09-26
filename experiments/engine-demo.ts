import { create, insertMultiple, search as oramaSearch } from "@orama/orama";
import { catalogOf } from "./lib";
import { createIndex, pluginJev, search } from "./engine";

const { catalog, single } = await catalogOf(199);
const index = createIndex({ documents: catalog, id: (t) => t.name, describe: (t) => t.description });
for (const query of single.slice(0, 3)) {
  const r = await search(index, { state: `User request: ${query.request}`, limit: 3, minProbability: 0.3 });
  console.log(query.request, "→", r.hits.map((h) => `${h.id}:${h.probability}`), r.plan, r.requests.length, r.fellBack ?? "", "| expected", query.relevant);
}
const db = create({
  schema: { name: "string", description: "string" } as const,
  plugins: [pluginJev({ describe: (doc) => String(doc.description), state: () => `User request: ${single[0]!.request}` })],
});
await insertMultiple(db, catalog);
const q = single[0]!;
const res = await oramaSearch(db, { term: q.keywords!, limit: 20 });
console.log("orama+jev", q.keywords, "→", res.hits.slice(0, 3).map((h) => `${h.document.name}:${h.score}`), "| expected", q.relevant);
