import { create, insertMultiple, search } from "@orama/orama";
import { queryText, type QueryInput, type Retriever, type ToolDoc } from "./types";

// BM25 through Orama 3.1.18. Orama's defaults: k1 = 1.2, b = 0.75, a length-dependent bonus d = 0.5
// inside the numerator (not BM25+'s constant delta), and threshold 1 (a document matching any query
// term is a hit). Two presets: plain Orama over name + description, and a tuned shape - an extra
// display-name and keyword field, per-field boosts, and one edit of typo tolerance.

const schema = {
  name: "string",
  displayName: "string",
  description: "string",
  keywords: "string[]",
} as const;

type Field = keyof typeof schema;

export type Bm25Options = {
  fields: Field[];
  boost: Partial<Record<Field, number>>;
  /** Levenshtein edits a query term may be away from an indexed one. */
  tolerance: number;
};

export const BM25_PLAIN: Bm25Options = {
  fields: ["name", "description"],
  boost: {},
  tolerance: 0,
};

export const BM25_TUNED: Bm25Options = {
  fields: ["name", "displayName", "description", "keywords"],
  boost: { name: 2.5, displayName: 2, keywords: 1.8, description: 1.5 },
  tolerance: 1,
};

const MAX_KEYWORDS = 20;
const MIN_KEYWORD_LENGTH = 2;
const STOP_WORDS = new Set(
  "the and for with from that this into your you are was were will can use using used when what which who how all any each not but has have had its via per about also only more most other such than then them they their there these those been being does did get gets set sets"
    .split(" ")
);

/** `create_calendarEvent` → `create calendar Event`: split snake, kebab and camel case. */
export function splitIdentifier(text: string): string {
  return text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

/** The tuned preset's keyword field: distinct content words from the name and description. */
export function extractKeywords({ name, description }: ToolDoc): string[] {
  const words = `${splitIdentifier(name)} ${description}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > MIN_KEYWORD_LENGTH && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

/** Query normalization: split identifiers, drop trailing punctuation. */
export function normalizeQuery(query: string): string {
  return splitIdentifier(query).replace(/[.,;:!?]+$/g, "");
}

export function bm25Retriever({
  id,
  label,
  options,
  input,
}: {
  id: string;
  label: string;
  options: Bm25Options;
  input: QueryInput;
}): Retriever {
  // One index per catalog object: the runner reuses a catalog across every query.
  const indexes = new WeakMap<ToolDoc[], ReturnType<typeof create<typeof schema>>>();
  const indexFor = (catalog: ToolDoc[]) => {
    const cached = indexes.get(catalog);
    if (cached) {
      return cached;
    }
    const db = create({ schema });
    insertMultiple(
      db,
      catalog.map((tool) => ({
        name: tool.name,
        displayName: splitIdentifier(tool.name),
        description: tool.description,
        keywords: extractKeywords(tool),
      }))
    );
    indexes.set(catalog, db);
    return db;
  };

  return {
    id: `${id}@${input}`,
    label,
    rank: async (query, catalog) => {
      const { hits } = await search(indexFor(catalog), {
        term: normalizeQuery(queryText(query, input)),
        properties: options.fields,
        boost: options.boost,
        tolerance: options.tolerance,
        limit: catalog.length,
      });
      return { ranking: hits.map((hit) => hit.document.name), inputTokens: 0, costUsd: 0 };
    },
  };
}
