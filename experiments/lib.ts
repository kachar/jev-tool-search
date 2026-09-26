import { appendFile, readFile } from "node:fs/promises";
import { experimental_evaluate as evaluate } from "ai";
import { BM25_TUNED, bm25Retriever } from "../src/bm25";
import { buildCatalog, shuffle } from "../src/dataset";
import { gatewayCostUsd } from "../src/judged";
import { JEV_MODEL, TOOL_CHOICE_INSTRUCTIONS } from "../src/jev";
import { mapConcurrent } from "../src/runner";
import type { BenchQuery, Dataset, ToolDoc } from "../src/types";

// Experiment harness for the "Orama for Jev" plan: each strategy is one way a Jev search library
// could turn a query and a catalog into a ranking. Every Jev call is logged (latency, tokens, cost,
// provider, failures) so a strategy's reliability is measured next to its accuracy.

export const CATALOG_SEED = 11;
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1000;
const RESULTS = new URL("../results/", import.meta.url).pathname;

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "boolean"; instructions: string };

export type CallLog = {
  options: number;
  questions: number;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
  provider?: string;
  failures: string[];
  error?: string;
};

export type Answer = {
  choice?: string;
  probabilities?: Record<string, number>;
  probability?: number;
  confidence?: number;
};

export type Provider = "typesafe-ai" | "digitalocean";

/** How `ask` retries a refused call: attempt count and the wait before attempt n+1. */
export type RetryPolicy = { attempts: number; delayMs: (attempt: number) => number; hedge?: number };
export const BACKOFF: RetryPolicy = { attempts: MAX_ATTEMPTS, delayMs: (attempt) => RETRY_DELAY_MS * 2 ** (attempt - 1) };

export type Ctx = { calls: CallLog[]; pin?: Provider; retry?: RetryPolicy };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One Jev request with retries; every attempt lands in `ctx.calls`. Throws after the last one. */
export async function ask(
  ctx: Ctx,
  state: string,
  questions: Record<string, Question>
): Promise<Record<string, Answer>> {
  const options = Object.values(questions).reduce(
    (sum, question) => sum + (question.type === "choice" ? Object.keys(question.criteria).length : 0),
    0
  );
  const failures: string[] = [];
  const policy = ctx.retry ?? BACKOFF;
  const once = () =>
    evaluate({
      model: JEV_MODEL,
      maxRetries: 0,
      state,
      questions,
      ...(ctx.pin && { providerOptions: { gateway: { only: [ctx.pin] } } }),
    });
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    try {
      // Hedging: send `hedge` identical requests and keep the first success.
      const result = policy.hedge ? await Promise.any(Array.from({ length: policy.hedge }, once)) : await once();
      const confidence = (result.providerMetadata?.typesafe?.confidence ?? {}) as Record<string, number>;
      const routing = result.providerMetadata?.gateway?.routing as { finalProvider?: string } | undefined;
      const inputTokens = result.usage.inputTokens ?? 0;
      ctx.calls.push({
        options,
        questions: Object.keys(questions).length,
        latencyMs: performance.now() - started,
        inputTokens,
        costUsd: gatewayCostUsd(result.providerMetadata) ?? 0,
        provider: routing?.finalProvider,
        failures,
      });
      return Object.fromEntries(
        Object.entries(result.answers).map(([key, answer]) => [
          key,
          { ...(answer as Answer), confidence: confidence[key] },
        ])
      );
    } catch (error) {
      failures.push(errorMessage(error instanceof AggregateError ? error.errors[0] : error));
      if (attempt === policy.attempts) {
        ctx.calls.push({
          options,
          questions: Object.keys(questions).length,
          latencyMs: performance.now() - started,
          inputTokens: 0,
          costUsd: 0,
          failures,
          error: errorMessage(error),
        });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, policy.delayMs(attempt)));
    }
  }
}

export type OptionText = "full" | "name" | "short";
const SHORT_CHARS = 60;

export function criteriaFor(tools: ToolDoc[], text: OptionText = "full") {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      text === "name" ? null : text === "short" ? tool.description.slice(0, SHORT_CHARS) : tool.description,
    ])
  );
}

export const stateFor = (query: BenchQuery) => `User request: ${query.request}`;

export const toolChoice = (tools: ToolDoc[], text: OptionText = "full"): Question => ({
  type: "choice",
  instructions: TOOL_CHOICE_INSTRUCTIONS,
  criteria: criteriaFor(tools, text),
});

/** Every option by probability, best first; ties keep their position in `order`, unlisted last. */
export function ranked(probabilities: Record<string, number>, order: string[]) {
  const position = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return Object.keys(probabilities).sort(
    (a, b) => probabilities[b]! - probabilities[a]! || position(a) - position(b) || a.localeCompare(b)
  );
}

/** `items` split into `parts` near-equal chunks. */
export function chunk<ITEM>(items: ITEM[], parts: number): ITEM[][] {
  const size = Math.ceil(items.length / parts);
  return Array.from({ length: parts }, (_, index) => items.slice(index * size, (index + 1) * size)).filter(
    (part) => part.length > 0
  );
}

export type Outcome = {
  ranking: string[];
  top?: Answer;
  extra?: Record<string, unknown>;
};

export type Strategy = {
  id: string;
  run: (query: BenchQuery, catalog: ToolDoc[], ctx: Ctx) => Promise<Outcome>;
};

export type Row = {
  experiment: string;
  strategyId: string;
  queryId: string;
  catalogSize: number;
  relevant: string[];
  ranking: string[];
  top?: Answer;
  extra?: Record<string, unknown>;
  latencyMs: number;
  calls: CallLog[];
  error?: string;
};

export async function loadDataset(): Promise<Dataset> {
  return JSON.parse(
    await readFile(new URL("../data/metatool/dataset.json", import.meta.url), "utf8")
  ) as Dataset;
}

export async function catalogOf(size: number) {
  const dataset = await loadDataset();
  const { catalog, queries } = buildCatalog(dataset.tools, dataset.queries, { size, seed: CATALOG_SEED });
  return { dataset, catalog, single: queries.filter(({ id }) => id.startsWith("single-")) };
}

/** The tuned BM25 on the agent's query (default) or the user's words: shortlist and tie-break order. */
export function bm25Ranker(input: "keywords" | "request" = "keywords") {
  const retriever = bm25Retriever({
    id: "bm25-tuned",
    label: "BM25",
    options: BM25_TUNED,
    input,
  });
  return async (query: BenchQuery, catalog: ToolDoc[]) => (await retriever.rank(query, catalog)).ranking;
}

async function loadRows(file: string): Promise<Row[]> {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);
  } catch {
    return [];
  }
}

/** Runs every strategy over every query, appending to results/<experiment>.jsonl; resumable. */
export async function runExperiment({
  experiment,
  strategies,
  queries,
  catalog,
  concurrency = 4,
  pin,
}: {
  experiment: string;
  strategies: Strategy[];
  queries: BenchQuery[];
  catalog: ToolDoc[];
  concurrency?: number;
  pin?: Provider;
}): Promise<Row[]> {
  const file = `${RESULTS}${experiment}.jsonl`;
  const existing = await loadRows(file);
  const key = (strategyId: string, queryId: string, size: number) => `${strategyId}|${queryId}|${size}`;
  const done = new Set(existing.map((row) => key(row.strategyId, row.queryId, row.catalogSize)));
  const pending = shuffle(
    strategies.flatMap((strategy) => queries.map((query) => ({ strategy, query }))),
    7
  ).filter(({ strategy, query }) => !done.has(key(strategy.id, query.id, catalog.length)));
  console.log(`${experiment}: ${pending.length} pending, ${existing.length} stored`);
  let count = 0;
  const fresh = await mapConcurrent(pending, concurrency, async ({ strategy, query }) => {
    const ctx: Ctx = { calls: [], pin };
    const started = performance.now();
    let row: Row;
    try {
      const outcome = await strategy.run(query, catalog, ctx);
      row = { ...base(), ...outcome, latencyMs: performance.now() - started, calls: ctx.calls };
    } catch (error) {
      row = { ...base(), ranking: [], latencyMs: performance.now() - started, calls: ctx.calls, error: errorMessage(error) };
    }
    await appendFile(file, `${JSON.stringify(row)}\n`);
    if (++count % 100 === 0) console.log(`  ${count}/${pending.length}`);
    return row;

    function base() {
      return {
        experiment,
        strategyId: strategy.id,
        queryId: query.id,
        catalogSize: catalog.length,
        relevant: query.relevant,
      };
    }
  });
  return [...existing, ...fresh];
}
