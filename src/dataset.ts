import { seededRandom } from "./stats";
import type { BenchQuery, ToolDoc } from "./types";

/** Fisher–Yates with a seeded PRNG: the same seed always gives the same order. */
export function shuffle<ITEM>(items: ITEM[], seed: number): ITEM[] {
  const random = seededRandom(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

/** At most `perTool` rows for each tool, drawn in seeded order, so no tool dominates the sample. */
export function samplePerTool<ROW extends { tool: string }>(
  rows: ROW[],
  perTool: number,
  seed: number
): ROW[] {
  const taken = new Map<string, number>();
  return shuffle(rows, seed).filter(({ tool }) => {
    const count = taken.get(tool) ?? 0;
    taken.set(tool, count + 1);
    return count < perTool;
  });
}

/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
}

/**
 * A seeded sample of `size` tools and the queries it can answer. Queries whose tools are not all in
 * the sample are dropped, so a smaller catalog never asks for a tool it does not hold.
 */
export function buildCatalog(
  tools: ToolDoc[],
  queries: BenchQuery[],
  { size, seed }: { size: number; seed: number }
): { catalog: ToolDoc[]; queries: BenchQuery[] } {
  const catalog = shuffle(tools, seed).slice(0, size);
  const names = new Set(catalog.map(({ name }) => name));
  return {
    catalog,
    queries: queries.filter(({ relevant }) => relevant.every((name) => names.has(name))),
  };
}

/** The server a tool belongs to: the part of its name before `__`, or the whole name. */
export const serverOf = (name: string) => {
  const cut = name.indexOf("__");
  return cut === -1 ? name : name.slice(0, cut);
};

/** The base catalog plus seeded distractors from `pool`, up to `size` tools. */
export function withDistractors(
  base: ToolDoc[],
  pool: ToolDoc[],
  { size, seed }: { size: number; seed: number }
): ToolDoc[] {
  const names = new Set(base.map(({ name }) => name));
  const extra = shuffle(pool, seed).filter(({ name }) => !names.has(name));
  return [...base, ...extra.slice(0, Math.max(0, size - base.length))];
}

/**
 * The catalog with every server that serves the query removed: the same request, but the tools that
 * could answer it are gone. The right answer is now "no tool fits".
 */
export function withoutServers(catalog: ToolDoc[], query: BenchQuery): ToolDoc[] {
  const gone = new Set(query.relevant.map(serverOf));
  return catalog.filter(({ name }) => !gone.has(serverOf(name)));
}
