import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, mapConcurrent, resultKey, runBenchmark, runQuery } from "../src/runner";
import { fileStore } from "../src/store";
import { compare, summarize } from "../src/summary";
import type { QueryResult, Retriever } from "../src/types";
import { catalog, fixedRetriever, query } from "./fixtures";

const flaky = (failures: number, error: unknown = new Error("at capacity")): Retriever => {
  let calls = 0;
  return {
    id: "flaky",
    label: "Flaky",
    rank: async () => {
      if (++calls <= failures) {
        throw error;
      }
      return { ranking: Array.from({ length: 30 }, (_, i) => `t${i}`), inputTokens: 5, costUsd: 0.1 };
    },
  };
};

describe("runQuery", () => {
  it("records a success with the ranking cut to depth 20", async () => {
    const result = await runQuery(flaky(0), query(), catalog);
    expect(result.ranking).toHaveLength(20);
    expect(result).toMatchObject({ retrieverId: "flaky", queryId: "single-001", catalogSize: 4, failures: [] });
    expect(result.error).toBeUndefined();
  });

  it("retries a failed call and keeps every failure message", async () => {
    const result = await runQuery(flaky(2), query(), catalog, { retryDelayMs: 0 });
    expect(result.failures).toEqual(["at capacity", "at capacity"]);
    expect(result.error).toBeUndefined();
  });

  it("gives up after the last attempt with an empty ranking", async () => {
    const result = await runQuery(flaky(MAX_ATTEMPTS, "boom"), query(), catalog, { retryDelayMs: 0 });
    expect(result).toMatchObject({ ranking: [], costUsd: 0, error: "boom" });
    expect(result.failures).toHaveLength(MAX_ATTEMPTS);
  });
});

describe("mapConcurrent", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapConcurrent([30, 10, 20, 0], 2, async (ms) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight--;
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 0]);
    expect(peak).toBe(2);
  });
});

describe("runBenchmark", () => {
  it("runs every retriever on every query, skips done keys, and reports each result", async () => {
    const queries = [query(), query({ id: "single-002" })];
    const retrievers = [fixedRetriever(["createCalendarEvent"], "a"), fixedRetriever([], "b")];
    const seen: string[] = [];
    const done = new Set([resultKey({ retrieverId: "b", queryId: "single-002", catalogSize: 4 })]);
    const results = await runBenchmark({
      retrievers,
      queries,
      catalog,
      done,
      onResult: (result) => void seen.push(resultKey(result)),
    });
    expect(results).toHaveLength(3);
    expect(seen).toEqual(["a|4|single-001", "a|4|single-002", "b|4|single-001"]);
  });

  it("works without a callback", async () => {
    const results = await runBenchmark({ retrievers: [fixedRetriever([])], queries: [query()], catalog });
    expect(results).toHaveLength(1);
  });
});

const result = (overrides: Partial<QueryResult>): QueryResult => ({
  retrieverId: "a",
  queryId: "single-001",
  catalogSize: 4,
  ranking: ["x"],
  relevant: ["x"],
  latencyMs: 100,
  inputTokens: 0,
  costUsd: 0.001,
  failures: [],
  ...overrides,
});

describe("summarize and compare", () => {
  const results = [
    result({}),
    result({ queryId: "single-002", ranking: ["y", "x"], failures: ["429"], latencyMs: 300 }),
    result({ retrieverId: "b", ranking: [], error: "boom", failures: ["boom"] }),
    result({ retrieverId: "b", queryId: "single-002", ranking: ["x"] }),
    result({ catalogSize: 2 }),
  ];
  const retrievers = [fixedRetriever([], "a"), fixedRetriever([], "b"), fixedRetriever([], "unused")];

  it("summarizes per size and retriever, skipping retrievers without rows", () => {
    const rows = summarize(results, retrievers);
    expect(rows.map(({ retrieverId, catalogSize }) => `${retrieverId}@${catalogSize}`)).toEqual([
      "a@2",
      "a@4",
      "b@4",
    ]);
    const a = rows[1]!;
    expect(a).toMatchObject({ queries: 2, errors: 0, failedAttempts: 1, costPer1kQueriesUsd: 1 });
    expect(a.metrics.hit1.mean).toBe(0.5);
    expect(a.metrics.mrr.mean).toBe(0.75);
    expect(a.latencyMs).toEqual({ p50: 100, p95: 300 });
    expect(rows[2]).toMatchObject({ errors: 1, failedAttempts: 1 });
  });

  it("compares two retrievers on the queries both answered", () => {
    const difference = compare([...results, result({ retrieverId: "a", queryId: "single-003" })], {
      a: "a",
      b: "b",
      metric: "hit1",
      catalogSize: 4,
    });
    expect(difference.queries).toBe(2);
    expect(difference.mean).toBe(0);
  });
});

describe("fileStore", () => {
  it("returns nothing for an unknown run and round-trips saved results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bench-"));
    const store = fileStore(join(directory, "nested"));
    expect(await store.load("run")).toEqual([]);
    await store.save("run", result({}));
    await store.save("run", result({ queryId: "single-002" }));
    expect((await store.load("run")).map(({ queryId }) => queryId)).toEqual(["single-001", "single-002"]);
  });

  it("surfaces read errors other than a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bench-"));
    await writeFile(join(directory, "file"), "not a directory");
    await expect(fileStore(join(directory, "file")).load("run")).rejects.toThrow();
  });
});
