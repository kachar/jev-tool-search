import { seededRandom } from "../src/stats";
import { shuffle } from "../src/dataset";
import type { BenchQuery, ToolDoc } from "../src/types";
import { createIndex, search, type IndexConfig } from "./engine";
import {
  ask,
  bm25Ranker,
  chunk,
  ranked,
  stateFor,
  toolChoice,
  type Answer,
  type RetryPolicy,
  type OptionText,
  type Question,
  type Strategy,
} from "./lib";

// Candidate algorithms for a Jev search library. Each maps (query, catalog) to a full ranking.

const bm25 = bm25Ranker();
const bm25RequestRanker = () => bm25Ranker("request");
const querySeed = (query: BenchQuery) => [...query.id].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) >>> 0;
const rest = (head: string[], order: string[]) => [...head, ...order.filter((name) => !head.includes(name))];

/** One choice over the whole catalog. `shuffled` re-orders options per query (order sensitivity). */
export function single(text: OptionText = "full", shuffled = false): Strategy {
  return {
    id: `single-${text}${shuffled ? "-shuffled" : ""}`,
    run: async (query, catalog, ctx) => {
      const tools = shuffled ? shuffle(catalog, querySeed(query)) : catalog;
      const order = await bm25(query, catalog);
      const { tool } = await ask(ctx, stateFor(query), { tool: toolChoice(tools, text) });
      return { ranking: rest(ranked(tool!.probabilities!, order), order), top: tool };
    },
  };
}

/** The relevant tool plus N-1 random distractors: accuracy against cardinality, no retrieval confound. */
export function randomN(size: number): Strategy {
  return {
    id: `random-${size}`,
    run: async (query, catalog, ctx) => {
      const random = seededRandom(querySeed(query) + size);
      const others = catalog.filter(({ name }) => !query.relevant.includes(name));
      const picked = shuffle(others, Math.floor(random() * 1e9)).slice(0, size - query.relevant.length);
      const tools = shuffle(
        [...catalog.filter(({ name }) => query.relevant.includes(name)), ...picked],
        querySeed(query)
      );
      const { tool } = await ask(ctx, stateFor(query), { tool: toolChoice(tools) });
      return { ranking: ranked(tool!.probabilities!, tools.map(({ name }) => name)), top: tool };
    },
  };
}

/** BM25 top-k, then one Jev choice over the shortlist. */
export function prefilter(k: number): Strategy {
  return {
    id: `prefilter-${k}`,
    run: async (query, catalog, ctx) => {
      const order = await bm25(query, catalog);
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const shortlist = order.slice(0, k).map((name) => byName.get(name)!);
      if (shortlist.length === 0) return { ranking: order };
      const { tool } = await ask(ctx, stateFor(query), { tool: toolChoice(shortlist) });
      return { ranking: rest(ranked(tool!.probabilities!, order), order), top: tool, extra: { recallCeiling: order.slice(0, k).some((n) => query.relevant.includes(n)) } };
    },
  };
}

/**
 * Tournament: split the catalog into `parts` chunks, keep each chunk's top `keep`, then one final
 * choice over the finalists. `mode` "batched" sends all chunk questions in ONE request (Jev answers
 * each question independently); "parallel" sends one request per chunk. `final: false` merges the
 * chunk probabilities directly instead of running a final round.
 */
export function tournament({
  parts,
  keep,
  mode,
  final = true,
}: {
  parts: number;
  keep: number;
  mode: "batched" | "parallel";
  final?: boolean;
}): Strategy {
  return {
    id: `tournament-${mode}-${parts}x${keep}${final ? "" : "-merge"}`,
    run: async (query, catalog, ctx) => {
      const order = await bm25(query, catalog);
      const chunks = chunk(catalog, parts);
      const questions: Record<string, Question> = Object.fromEntries(
        chunks.map((tools, index) => [`chunk${index}`, toolChoice(tools)])
      );
      const state = stateFor(query);
      const answers: Answer[] =
        mode === "batched"
          ? Object.values(await ask(ctx, state, questions))
          : await Promise.all(
              Object.entries(questions).map(async ([key, question]) => (await ask(ctx, state, { [key]: question }))[key]!)
            );
      const merged = Object.assign({}, ...answers.map((answer) => answer.probabilities));
      const byChunkProbability = ranked(merged, order);
      if (!final) return { ranking: rest(byChunkProbability, order), top: { probabilities: merged } };
      const finalists = answers.flatMap((answer) => ranked(answer.probabilities!, order).slice(0, keep));
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const { tool } = await ask(ctx, state, { tool: toolChoice(finalists.map((name) => byName.get(name)!)) });
      return {
        ranking: rest(rest(ranked(tool!.probabilities!, order), byChunkProbability), order),
        top: tool,
        extra: { finalistsHit: finalists.some((name) => query.relevant.includes(name)) },
      };
    },
  };
}

export const FIT_INSTRUCTIONS =
  "An AI assistant received the user request in the state. Can this tool, on its own, carry out what the user asked for?";

/**
 * Close read (FastMCP-style): the single choice, then a boolean fit question per top-`read`
 * candidate, batched in one request. Re-ranks by fit and exposes the max fit for abstention.
 */
export function closeRead(read = 3, exclude = false): Strategy {
  return {
    id: `closeread-${read}${exclude ? "-ooc" : ""}`,
    run: async (query, fullCatalog, ctx) => {
      const catalog = exclude ? fullCatalog.filter(({ name }) => !query.relevant.includes(name)) : fullCatalog;
      const order = await bm25(query, catalog);
      const state = stateFor(query);
      const { tool } = await ask(ctx, state, { tool: toolChoice(catalog) });
      const choiceOrder = ranked(tool!.probabilities!, order);
      const byName = new Map(catalog.map((t) => [t.name, t]));
      const candidates = choiceOrder.slice(0, read);
      const fit = await ask(
        ctx,
        state,
        Object.fromEntries(
          candidates.map((name, index) => [
            `fit${index}`,
            { type: "boolean", instructions: `${FIT_INSTRUCTIONS}\nTool: ${name}\nDescription: ${byName.get(name)!.description}` },
          ])
        )
      );
      const fits = Object.fromEntries(candidates.map((name, index) => [name, fit[`fit${index}`]!.probability!]));
      return {
        ranking: rest(rest(ranked(fits, candidates), choiceOrder), order),
        top: tool,
        extra: { fits, outOfCatalog: exclude },
      };
    },
  };
}

/** The same strategy under a different retry policy. */
export function withRetry(strategy: Strategy, retry: RetryPolicy, label: string): Strategy {
  return { id: `${strategy.id}+${label}`, run: (query, catalog, ctx) => strategy.run(query, catalog, { ...ctx, retry }) };
}

const jitter = (low: number, high: number) => low + Math.random() * (high - low);
export const FAST_RETRY: RetryPolicy = { attempts: 8, delayMs: () => jitter(100, 300) };
export const HEDGED: RetryPolicy = { attempts: 4, delayMs: () => jitter(100, 300), hedge: 2 };

/** One try at the whole catalog; if refused, fall back to the batched tournament (smaller questions). */
export function degrade(): Strategy {
  const direct = single();
  const small = tournament({ parts: 4, keep: 3, mode: "batched" });
  return {
    id: "single-full+degrade",
    run: async (query, catalog, ctx) => {
      try {
        return await direct.run(query, catalog, { ...ctx, retry: { attempts: 1, delayMs: () => 0 } });
      } catch {
        return { ...(await small.run(query, catalog, { ...ctx, retry: FAST_RETRY })), extra: { degraded: true } };
      }
    },
  };
}

const SC_THRESHOLD = 0.6;
const average = (maps: Record<string, number>[]) =>
  Object.fromEntries(Object.keys(maps[0]!).map((key) => [key, maps.reduce((sum, map) => sum + (map[key] ?? 0), 0) / maps.length]));

/**
 * Tournament v2: parallel chunk requests, finalists into one final choice. Stores round-1
 * probabilities so fusion rules can be scored offline. `selfConsistency` re-asks the final with
 * the finalists reversed when its top probability is under 0.6, and averages the two.
 */
export function tournamentV2({ parts, keep, selfConsistency = false }: { parts: number; keep: number; selfConsistency?: boolean }): Strategy {
  return {
    id: `t2-${parts}x${keep}${selfConsistency ? "-sc" : ""}`,
    run: async (query, catalog, ctx) => {
      const order = await bm25(query, catalog);
      const state = stateFor(query);
      const retried = { ...ctx, retry: ctx.retry ?? FAST_RETRY };
      const rounds = await Promise.all(
        chunk(catalog, parts).map(async (tools) => (await ask(retried, state, { tool: toolChoice(tools) })).tool!.probabilities!)
      );
      const round1 = Object.assign({}, ...rounds) as Record<string, number>;
      const finalists = rounds.flatMap((probabilities) => ranked(probabilities, order).slice(0, keep));
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const askFinal = async (names: string[]) =>
        (await ask(retried, state, { tool: toolChoice(names.map((name) => byName.get(name)!)) })).tool!;
      const first = await askFinal(finalists);
      let final = first.probabilities!;
      if (selfConsistency && Math.max(...Object.values(final)) < SC_THRESHOLD) {
        final = average([final, (await askFinal([...finalists].reverse())).probabilities!]);
      }
      return {
        ranking: rest(rest(ranked(final, order), ranked(round1, order)), order),
        top: { ...first, probabilities: final },
        extra: { round1: Object.fromEntries(finalists.map((name) => [name, round1[name]])), finalistsHit: finalists.some((name) => query.relevant.includes(name)) },
      };
    },
  };
}

/** Union of BM25 over the agent's keywords and the user's words (interleaved), top-k, then Jev. */
export function unionPrefilter(k: number): Strategy {
  const byRequest = bm25RequestRanker();
  return {
    id: `union-${k}`,
    run: async (query, catalog, ctx) => {
      const [a, b] = await Promise.all([bm25(query, catalog), byRequest(query, catalog)]);
      const order = [...new Set(a.flatMap((name, index) => [name, b[index]]).concat(b.slice(a.length)).filter(Boolean) as string[])];
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const shortlist = order.slice(0, k).map((name) => byName.get(name)!);
      const { tool } = await ask({ ...ctx, retry: ctx.retry ?? FAST_RETRY }, stateFor(query), { tool: toolChoice(shortlist) });
      return { ranking: rest(ranked(tool!.probabilities!, order), order), top: tool, extra: { recallCeiling: order.slice(0, k).some((n) => query.relevant.includes(n)) } };
    },
  };
}

/** The engine spike end to end, as a library user would call it (its own retries and fallback). */
export function engineStrategy(mode: "catalog" | "shortlist", config: Partial<IndexConfig> = {}, label = ""): Strategy {
  const indexes = new WeakMap<ToolDoc[], ReturnType<typeof createIndex<ToolDoc>>>();
  const byRequest = bm25RequestRanker();
  return {
    id: `engine-${mode}${label}`,
    run: async (query, catalog, ctx) => {
      const index = indexes.get(catalog) ?? createIndex({ documents: catalog, id: (t) => t.name, describe: (t) => t.description, ...config });
      indexes.set(catalog, index);
      const [a, b] = await Promise.all([bm25(query, catalog), byRequest(query, catalog)]);
      const union = [...new Set([...a.flatMap((name, i) => [name, b[i]]), ...b.slice(a.length)].filter(Boolean) as string[])];
      const result = await search(index, {
        state: stateFor(query),
        limit: 20,
        fallback: union,
        ...(mode === "shortlist" && { candidates: union.slice(0, 40) }),
      });
      // One CallLog per Jev request, so analyze.ts reports real request counts and refusal rates.
      ctx.calls.push(...result.requests.map((request) => ({ options: request.options, questions: 1, latencyMs: request.ms, inputTokens: request.inputTokens, costUsd: 0, failures: Array.from({ length: request.failures }, () => "retryable"), ...(request.error && { error: request.error }) })));
      if (ctx.calls[0]) ctx.calls[0].costUsd = result.costUsd;
      const finals = result.hits.filter((hit) => hit.stage === "final");
      return { ranking: rest(result.hits.map((hit) => hit.id), union), top: { probabilities: Object.fromEntries(finals.map((h) => [h.id, h.probability])) }, extra: { plan: result.plan, partial: result.partial, requests: result.requests.length, ...(result.fellBack && { fellBack: result.fellBack }) } };
    },
  };
}
