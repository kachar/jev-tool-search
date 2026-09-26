import type { AnyOrama, OramaPluginSync, Results, SearchParams, TypedDocument } from "@orama/orama";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel, type ProviderMetadata } from "ai";

// Spike of "Orama for Jev" (docs/plans/2026-09-25-jev-search-engine.md): a catalog you index once
// and search many times, ranked by Jev's probability instead of a lexical score. It owns what a raw
// `evaluate` call leaves to the caller: request sizing, a tournament over a big catalog, retrying
// capacity errors, and a fallback ranking instead of a thrown error. Defaults are measured ones;
// see research/jev-search-engine/20-experiments.md.

export const JEV_MODEL = "typesafe-ai/jev";
/** Hard cap per choice question (docs.typesafe.ai/api.md). */
export const MAX_OPTIONS = 255;

export type IndexConfig = {
  model: Experimental_EvaluationModel;
  instructions: string;
  /** Instructions for the deciding question, which reads `detail` text when given. */
  finalInstructions: string;
  /** Finalists the detail-reading question sees (only when `detail` is given). */
  finalSize: number;
  /** Characters of description per option. Full text beat 60 chars by ~2 pts; names alone lose 21. */
  optionChars: number;
  /**
   * Whole pool in ONE question when it fits this many input tokens: the most accurate plan
   * (75.9% vs 73.9% for a tournament, interleaved). Refused ~35–55% at 6.7k (the largest size
   * measured), so it runs hedged and degrades to the tournament after `directAttempts`. Must sit
   * above the catalog's real size: at 7,000 a 6.7k-token catalog was planned as a tournament.
   */
  directTokens: number;
  directAttempts: number;
  /** Identical requests per direct attempt; the first answer wins. */
  hedge: number;
  /** Tournament chunk size in input tokens, state included (1.6k beat 1.2k; ~1–10% refused). */
  requestTokens: number;
  /** Chunk winners kept for the next round. */
  keepPerChunk: number;
  /** Attempts per request. Only errors the SDK marks retryable (capacity 503s) are retried. */
  attempts: number;
  /** Requests in flight per search; the account limit is 1,200 requests/min (docs.typesafe.ai). */
  maxConcurrency: number;
  /** Whole-search deadline before returning the fallback ranking (5 s cut 7 of 398 under load). */
  deadlineMs: number;
};

export const DEFAULT_CONFIG: IndexConfig = {
  model: JEV_MODEL,
  instructions: "An AI assistant received the user request in the state. Which tool should it call first to handle it?",
  finalSize: 8,
  finalInstructions:
    "Exactly one of these tools is the right one to call for the user's request in the state. Which one? Read what each tool actually does and what parameters it takes, not just its name.",
  optionChars: 1000,
  directTokens: 10000,
  directAttempts: 2,
  hedge: 2,
  requestTokens: 1600,
  keepPerChunk: 4,
  attempts: 4,
  maxConcurrency: 8,
  deadlineMs: 10000,
};

// Starting estimate, then corrected from each response's real `usage.inputTokens` (an earlier
// fixed estimate under-counted by 12–30%).
const CHARS_PER_TOKEN = 4;
const OPTION_OVERHEAD_TOKENS = 7;
const REQUEST_OVERHEAD_TOKENS = 40;
const RETRY_JITTER_MS = [100, 300] as const;
/** Option room every request keeps, whatever the length of the state. */
const MIN_OPTION_ROOM_TOKENS = 800;
/** Weight of the newest observation in the running token-estimate correction. */
const CALIBRATION_WEIGHT = 0.2;

export type JevIndex<DOC> = {
  documents: Map<string, DOC>;
  options: Map<string, string>;
  /** What the deciding question reads per option (description + parameters); defaults to `options`. */
  details: Map<string, string>;
  /** Estimated tokens per option before calibration. */
  tokens: Map<string, number>;
  /** Real / estimated input tokens, learned from responses. */
  calibration: number;
  config: IndexConfig;
  insert: (doc: DOC) => string;
};

export function createIndex<DOC>({
  documents = [],
  id,
  describe,
  detail,
  ...config
}: {
  documents?: DOC[];
  id: (doc: DOC) => string;
  /** Short text the wide rounds read per option. */
  describe: (doc: DOC) => string;
  /** Richer text for the deciding question only (e.g. description + parameters). */
  detail?: (doc: DOC) => string;
} & Partial<IndexConfig>): JevIndex<DOC> {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const index: JevIndex<DOC> = {
    documents: new Map(),
    options: new Map(),
    details: new Map(),
    tokens: new Map(),
    calibration: 1,
    config: merged,
    insert: (doc) => {
      const key = id(doc);
      const text = describe(doc).slice(0, merged.optionChars);
      index.documents.set(key, doc);
      index.options.set(key, text);
      if (detail) index.details.set(key, detail(doc));
      index.tokens.set(key, estimateTokens(key + text) + OPTION_OVERHEAD_TOKENS);
      return key;
    },
  };
  documents.forEach(index.insert);
  return index;
}

const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export type Hit<DOC> = {
  id: string;
  probability: number;
  document: DOC;
  /** "final": probability from the deciding question. "round": from a chunk; not comparable. */
  stage: "final" | "round" | "fallback";
};
export type Plan = "direct" | "tournament" | "fallback";
/** Why a direct search became a tournament. */
export type Degraded = "direct refused";
export type RequestLog = { options: number; inputTokens: number; failures: number; ms: number; error?: string };

export type SearchResult<DOC> = {
  hits: Hit<DOC>[];
  /** Final top probability below `minProbability` (off unless set from the harness). */
  abstained: boolean;
  plan: Plan;
  /** Some chunks failed; their best candidates advanced by fallback order instead. */
  partial: boolean;
  degraded?: Degraded;
  requests: RequestLog[];
  inputTokens: number;
  costUsd: number;
  fellBack?: string;
};

type SearchOptions = {
  /** The situation to decide on: the user's request, not search keywords. */
  state: string;
  limit?: number;
  minProbability?: number;
  /** Restrict to these ids (a lexical shortlist). */
  candidates?: string[];
  /** Ranking used for ties, failed chunks and the full fallback (e.g. BM25 order). */
  fallback?: string[];
};

type Probabilities = Record<string, number>;
type Run = { requests: RequestLog[]; inputTokens: number; costUsd: number; signal: AbortSignal; slots: () => Promise<() => void> };

const costOf = (metadata: ProviderMetadata | undefined) => {
  const cost = metadata?.gateway?.marketCost ?? metadata?.gateway?.cost;
  return typeof cost === "string" || typeof cost === "number" ? Number(cost) : 0;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Retry capacity errors and network failures, plus one Jev quirk: its `choice` occasionally
// disagrees with its own rounded probabilities and the SDK rejects the answer as invalid
// (3 of 2,891 requests); asking again resolves it.
const isRetryable = (error: unknown) =>
  (error as { isRetryable?: boolean }).isRetryable === true ||
  (error instanceof TypeError && /fetch/i.test(error.message)) ||
  (error instanceof Error && /did not select a highest-probability option/.test(error.message));

/** A tiny semaphore: at most `limit` requests of one search in flight. */
function semaphore(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async () => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    return () => {
      active--;
      waiting.shift()?.();
    };
  };
}

/** FNV-1a: a stable order that breaks up catalogs grouped by server before chunking. */
const hash = (text: string) => [...text].reduce((h, char) => Math.imul(h ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);

/**
 * Split under the per-request token budget (state included) and the option cap, then rebalance
 * by tokens so no chunk is a near-empty tail and none exceeds the budget.
 */
export function planChunks<DOC>(ids: string[], index: JevIndex<DOC>, stateTokens: number, budget = index.config.requestTokens): string[][] {
  const scale = index.calibration;
  // A long request must not fail the search: the budget stretches so every chunk still has room
  // for options (a 2k-token task in LiveMCPBench hit this).
  const room = Math.max(budget / scale - REQUEST_OVERHEAD_TOKENS - stateTokens, MIN_OPTION_ROOM_TOKENS);
  const cost = (id: string) => index.tokens.get(id) ?? OPTION_OVERHEAD_TOKENS;
  const greedy = (limit: number) => {
    const chunks: string[][] = [[]];
    let used = 0;
    for (const id of ids) {
      const current = chunks.at(-1)!;
      if (current.length > 0 && (used + cost(id) > limit || current.length === MAX_OPTIONS)) {
        chunks.push([]);
        used = 0;
      }
      chunks.at(-1)!.push(id);
      used += cost(id);
    }
    return chunks;
  };
  const first = greedy(room);
  if (first.length === 1) return first;
  const total = ids.reduce((sum, id) => sum + cost(id), 0);
  const balanced = greedy(Math.min(room, Math.ceil(total / first.length) * 1.1));
  return balanced.length <= first.length ? balanced : first;
}

/** One choice question in its own request; retries only what the SDK marks retryable. */
async function choose<DOC>(
  index: JevIndex<DOC>,
  state: string,
  ids: string[],
  run: Run,
  estimated: number,
  { attempts = index.config.attempts, hedge = 1, final = false }: { attempts?: number; hedge?: number; final?: boolean } = {}
) {
  const { model } = index.config;
  const instructions = final && index.details.size > 0 ? index.config.finalInstructions : index.config.instructions;
  const text = (id: string) => (final ? (index.details.get(id) ?? index.options.get(id)!) : index.options.get(id)!);
  const release = await run.slots();
  const log: RequestLog = { options: ids.length, inputTokens: 0, failures: 0, ms: 0 };
  const started = performance.now();
  run.requests.push(log);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const once = () =>
          evaluate({
            model,
            maxRetries: 0,
            abortSignal: run.signal,
            state,
            questions: { pick: { type: "choice", instructions, criteria: Object.fromEntries(ids.map((id) => [id, text(id)])) } },
          });
        // Hedging: identical requests, first success wins (a refusal returns fast, so it is cheap).
        const result = hedge > 1
          ? await Promise.any(Array.from({ length: hedge }, once)).catch((error: AggregateError) => { throw error.errors[0]; })
          : await once();
        const inputTokens = result.usage.inputTokens ?? 0;
        log.inputTokens = inputTokens;
        run.inputTokens += inputTokens;
        run.costUsd += costOf(result.providerMetadata);
        if (inputTokens > 0) {
          index.calibration += CALIBRATION_WEIGHT * (inputTokens / estimated - index.calibration);
        }
        const answer = result.answers.pick;
        return answer.probabilities ?? { [answer.choice]: 1 };
      } catch (error) {
        log.failures++;
        if (!isRetryable(error) || attempt >= attempts || run.signal.aborted) {
          log.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
        await pause(RETRY_JITTER_MS[0] + Math.random() * (RETRY_JITTER_MS[1] - RETRY_JITTER_MS[0]));
      }
    }
  } finally {
    log.ms = performance.now() - started;
    release();
  }
}

const byProbability = (probabilities: Probabilities, order: string[]) => {
  const position = new Map(order.map((id, index) => [id, index]));
  return Object.keys(probabilities).sort(
    (a, b) => probabilities[b]! - probabilities[a]! || (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity)
  );
};

export async function search<DOC>(
  index: JevIndex<DOC>,
  { state, limit = 5, minProbability = 0, candidates, fallback }: SearchOptions
): Promise<SearchResult<DOC>> {
  const pool = candidates ?? [...index.documents.keys()];
  const order = fallback ?? pool;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error(`deadline ${index.config.deadlineMs} ms`)), index.config.deadlineMs);
  const run: Run = { requests: [], inputTokens: 0, costUsd: 0, signal: controller.signal, slots: semaphore(index.config.maxConcurrency) };
  const stateTokens = estimateTokens(state + index.config.instructions);
  const summary = () => ({ requests: [...run.requests], inputTokens: run.inputTokens, costUsd: run.costUsd });
  const round1: Probabilities = {};
  let partial = false;

  try {
    // Rounds: each chunk is its own request (batching chunk questions into one request is refused
    // as often as one big question). Winners advance until one request holds them all; the last
    // round's distribution is the only one whose probabilities compare across candidates.
    const estimate = (ids: string[]) => stateTokens + REQUEST_OVERHEAD_TOKENS + ids.reduce((s, id) => s + index.tokens.get(id)!, 0);
    const rank = (final: Probabilities, plan: Plan, degraded?: Degraded) => {
      // Finalists first, then everything else by its round probability, then by fallback order,
      // so `limit` is honoured even when it exceeds the number of finalists.
      const ranked = byProbability(final, order);
      const rest = [...pool].filter((id) => !(id in final)).sort(
        (a, b) => (round1[b] ?? -1) - (round1[a] ?? -1) || order.indexOf(a) - order.indexOf(b)
      );
      const hits: Hit<DOC>[] = [
        ...ranked.map((id) => ({ id, probability: final[id] ?? 0, document: index.documents.get(id)!, stage: "final" as const })),
        ...rest.map((id) => ({ id, probability: round1[id] ?? 0, document: index.documents.get(id)!, stage: "round" as const })),
      ].slice(0, limit);
      return { hits, abstained: (hits[0]?.probability ?? 0) < minProbability, plan, partial, ...(degraded && { degraded }), ...summary() };
    };

    // With detail text, the deciding question reads rich text for a few finalists only: a question
    // over the short text first narrows the field to `finalSize` (FastMCP's 32 → 8 step).
    const hasDetails = index.details.size > 0;
    const decide = async (ids: string[], plan: Plan, degraded: Degraded | undefined, options: { attempts?: number; hedge?: number } = {}) => {
      let finalists = ids;
      if (hasDetails && ids.length > index.config.finalSize) {
        const narrowed = await choose(index, state, ids, run, estimate(ids), options);
        Object.assign(round1, narrowed);
        finalists = byProbability(narrowed, order).slice(0, index.config.finalSize);
      }
      const final = await choose(index, state, finalists, run, estimate(finalists), { ...options, final: true });
      return rank(final, plan, degraded);
    };

    // Plan 1: the whole pool in one question, hedged. Most accurate when Jev answers it.
    let degraded: Degraded | undefined;
    if (planChunks(pool, index, stateTokens, index.config.directTokens).length === 1) {
      try {
        return await decide(pool, "direct", undefined, { attempts: index.config.directAttempts, hedge: index.config.hedge });
      } catch (error) {
        if (!isRetryable(error) || controller.signal.aborted) throw error;
        degraded = "direct refused";
      }
    }

    // Plan 2: tournament. Each chunk is its own request (batching chunk questions into one request
    // is refused as often as one big question). Winners advance until one request holds them all;
    // only the last round's probabilities compare across candidates.
    let contenders = [...pool].sort((a, b) => hash(a) - hash(b));
    let chunks = planChunks(contenders, index, stateTokens);
    while (chunks.length > 1) {
      const settled = await Promise.allSettled(chunks.map((ids) => choose(index, state, ids, run, estimate(ids))));
      const nonRetryable = settled.find((r) => r.status === "rejected" && !isRetryable(r.reason) && !controller.signal.aborted);
      if (nonRetryable?.status === "rejected") throw nonRetryable.reason; // configuration error: surface it
      if (settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
      contenders = settled.flatMap((result, part) => {
        if (result.status === "fulfilled") {
          Object.assign(round1, result.value);
          return byProbability(result.value, order).slice(0, index.config.keepPerChunk);
        }
        // A failed chunk does not sink the search: its best candidates by fallback order advance.
        partial = true;
        const ids = new Set(chunks[part]);
        return order.filter((id) => ids.has(id)).slice(0, index.config.keepPerChunk);
      });
      chunks = planChunks(contenders, index, stateTokens);
    }
    return await decide(chunks[0]!, "tournament", degraded);
  } catch (error) {
    if (!isRetryable(error) && !controller.signal.aborted) throw error;
    return {
      hits: order.slice(0, limit).map((id) => ({ id, probability: 0, document: index.documents.get(id)!, stage: "fallback" as const })),
      abstained: false,
      plan: "fallback",
      partial,
      ...summary(),
      fellBack: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(deadline);
    controller.abort(); // stop stragglers so nothing keeps spending after we return
  }
}

/**
 * Orama plugin: BM25 retrieves `limit` hits, Jev re-orders them. `state` must be the user's
 * request (Jev reads requests; BM25 reads keywords). Orama awaits a hook only when it is a native
 * `async function` (components/hooks.js checks AsyncFunction); otherwise it races.
 */
export function pluginJev({
  describe,
  state,
  ...config
}: {
  describe: (doc: TypedDocument<AnyOrama>) => string;
  state: (params: SearchParams<AnyOrama>) => string;
} & Partial<IndexConfig>): OramaPluginSync {
  return {
    name: "jev-rerank",
    afterSearch: async function afterSearch(
      _orama: AnyOrama,
      params: SearchParams<AnyOrama>,
      _language: string | undefined,
      results: Results<TypedDocument<AnyOrama>>
    ) {
      if (results.hits.length < 2) return;
      const index = createIndex({ documents: results.hits, id: (hit) => hit.id, describe: (hit) => describe(hit.document), ...config });
      const bm25Order = results.hits.map((hit) => hit.id);
      const { hits, plan } = await search(index, { state: state(params), limit: results.hits.length, fallback: bm25Order });
      if (plan === "fallback") return;
      results.hits = hits.map(({ document, probability }) => ({ ...document, score: probability }));
    },
  } as OramaPluginSync;
}
