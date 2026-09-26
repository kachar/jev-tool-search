/** One tool in the catalog the agent can search. */
export type ToolDoc = {
  name: string;
  description: string;
  /** The tool's JSON Schema, when the dataset has one (real MCP servers do). */
  inputSchema?: Record<string, unknown>;
};

/**
 * One benchmark query and the tools that answer it. `request` is what the user said; `keywords` is
 * the search query an agent wrote for its tool-search tool, which is what a lexical index sees in
 * production.
 */
export type BenchQuery = {
  id: string;
  request: string;
  keywords?: string;
  relevant: string[];
};

/** Which text of a query a lexical retriever searches with. */
export type QueryInput = "request" | "keywords";

export type Dataset = {
  name: string;
  source: string;
  license: string;
  tools: ToolDoc[];
  queries: BenchQuery[];
};

/** What a retriever returns for one query: tool names, best first. */
export type RankResult = {
  ranking: string[];
  inputTokens: number;
  costUsd: number;
  /** Model calls refused and retried inside this search (a search may make many calls). */
  refusedCalls?: number;
  /** Arm-specific counters, e.g. an agent's turns and searches. */
  details?: Record<string, number>;
};

export type Retriever = {
  id: string;
  label: string;
  rank: (query: BenchQuery, catalog: ToolDoc[]) => Promise<RankResult>;
  /** One-off, untimed setup per catalog (an index, embeddings) that production would do ahead of time. */
  prepare?: (catalog: ToolDoc[]) => Promise<unknown>;
};

export function queryText(query: BenchQuery, input: QueryInput): string {
  if (input === "request") {
    return query.request;
  }
  if (query.keywords === undefined) {
    throw new Error(`query ${query.id} has no agent-written keywords`);
  }
  return query.keywords;
}

/** One retriever on one query, with its latency and scores. */
export type QueryResult = {
  retrieverId: string;
  queryId: string;
  catalogSize: number;
  ranking: string[];
  relevant: string[];
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
  /** Messages of attempts that failed before this result, including the final one on error. */
  failures: string[];
  /** Model calls refused and retried inside the successful attempt. */
  refusedCalls?: number;
  details?: Record<string, number>;
  error?: string;
};

export type MetricName = "hit1" | "recall5" | "mrr" | "ndcg5";

export type MetricSummary = {
  mean: number;
  low: number;
  high: number;
};

export type RetrieverSummary = {
  retrieverId: string;
  label: string;
  catalogSize: number;
  queries: number;
  errors: number;
  /** Failed calls, retried ones included: availability, separate from final errors. */
  failedAttempts: number;
  metrics: Record<MetricName, MetricSummary>;
  latencyMs: { p50: number; p95: number };
  costPer1kQueriesUsd: number;
};
