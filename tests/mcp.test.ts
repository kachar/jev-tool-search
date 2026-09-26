import { Experimental_EvaluationMockModelV4, MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { abstainRate, runAbstain } from "../src/abstain";
import { anthropicSchema } from "../src/claude-agent";
import { serverOf, withDistractors, withoutServers } from "../src/dataset";
import { embeddingRetriever, toolText } from "../src/embed";
import { chunk, detail, fitInstructions, jevSearch, summary } from "../src/jev-search";
import { createMcpArms, MCP_SHORTLIST } from "../src/mcp-arms";
import { withRetry } from "../src/retry";
import type { QueryResult, ToolDoc } from "../src/types";
import { fixedRetriever, query } from "./fixtures";

const tools = (count: number, server = "srv"): ToolDoc[] =>
  Array.from({ length: count }, (_, index) => ({ name: `${server}__t${index}`, description: `Tool number ${index}.` }));

describe("dataset helpers for MCP catalogs", () => {
  it("reads the server from a server__tool name", () => {
    expect(serverOf("github__create_issue")).toBe("github");
    expect(serverOf("plain")).toBe("plain");
  });

  it("grows a catalog with distractors it does not already hold", () => {
    const base = tools(3);
    const pool = [...tools(3), ...tools(5, "other")];
    const grown = withDistractors(base, pool, { size: 6, seed: 1 });
    expect(grown).toHaveLength(6);
    expect(grown.slice(0, 3)).toEqual(base);
    expect(grown.slice(3).every(({ name }) => serverOf(name) === "other")).toBe(true);
    expect(withDistractors(base, pool, { size: 2, seed: 1 })).toEqual(base);
  });

  it("drops every server that could serve the query", () => {
    const catalog = [...tools(2, "a"), ...tools(2, "b"), ...tools(2, "c")];
    const left = withoutServers(catalog, query({ relevant: ["a__t0", "b__t1"] }));
    expect(left.map(({ name }) => serverOf(name))).toEqual(["c", "c"]);
  });
});

describe("withRetry", () => {
  it("retries until the call succeeds and reports each failure", async () => {
    let calls = 0;
    const failures: unknown[] = [];
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw new Error(`fail ${calls}`);
        return "ok";
      },
      { delayMs: 0, onFailure: (error) => failures.push(error) }
    );
    expect(result).toBe("ok");
    expect(failures).toHaveLength(2);
  });

  it("gives up after the last attempt, with the default reporter", async () => {
    await expect(withRetry(async () => Promise.reject(new Error("no")), { attempts: 2, delayMs: 0 })).rejects.toThrow("no");
  });
});

describe("jev search text", () => {
  it("summarizes the first paragraph, falls back to the name, and clips", () => {
    expect(summary({ name: "a", description: "First.\n\nSecond." }, 50)).toBe("First.");
    expect(summary({ name: "get_weather", description: "" }, 50)).toBe("get weather");
    expect(summary({ name: "a", description: "x".repeat(20) }, 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("details name, description and parameters", () => {
    const text = detail(
      {
        name: "search",
        description: "Search the web.",
        inputSchema: { properties: { q: { type: "string", description: "Query" }, n: {} } },
      },
      500
    );
    expect(text).toBe("## search\nSearch the web.\nParameters:\n- q (string): Query\n- n");
    expect(detail({ name: "x", description: "Only." }, 500)).toBe("## x\nOnly.");
  });

  it("chunks lists and names the fit question after the tool", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(fitInstructions("x")).toContain("tools.x");
  });
});

/** A mock Jev: ranks options by their numeric suffix (higher first) and says a tool fits when `fits` says so. */
const mockJev = (fits: (name: string) => number, { failFirst = 0, bare = false } = {}) => {
  const calls: { questions: Record<string, { type: string; criteria?: Record<string, unknown> }> }[] = [];
  let failures = failFirst;
  const model = new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      if (failures-- > 0) throw new Error("at capacity");
      const questions = options.questions as Record<string, { type: string; criteria?: Record<string, unknown> }>;
      calls.push({ questions });
      const names = Object.keys(questions.which!.criteria!);
      const score = (name: string) => Number(name.split("t").pop());
      const total = names.reduce((sum, name) => sum + score(name) + 1, 0);
      const best = [...names].sort((a, b) => score(b) - score(a))[0]!;
      const state = options.state as { tools?: Record<string, string> };
      const toolNames = Object.keys(state.tools ?? {});
      return {
        answers: {
          which: bare
            ? { type: "choice", choice: best }
            : { type: "choice", choice: best, probabilities: Object.fromEntries(names.map((name) => [name, (score(name) + 1) / total])) },
          ...Object.fromEntries(
            Object.keys(questions)
              .filter((key) => key.startsWith("fit_"))
              .map((key) => [key, { type: "boolean", probability: fits(toolNames[Number(key.slice(4))]!) }])
          ),
        },
        usage: { inputTokens: 100 },
        warnings: [],
      };
    },
  });
  return { model, calls };
};

describe("jevSearch", () => {
  it("narrows a big catalog in chunks, closes the read, and drops tools that do not fit", async () => {
    const { model, calls } = mockJev((name) => (name.endsWith("t59") ? 0.1 : 0.9));
    const search = jevSearch({ id: "j", label: "J", model, options: { chunkSize: 30, shortlist: 4 } });
    const result = await search.rank(query(), tools(60));
    // 60 tools > 12 candidates: two chunks of 30 keep 4 each, then one close read over 8.
    expect(calls).toHaveLength(3);
    expect(calls[2]!.questions.which!.criteria).toHaveProperty("srv__t58");
    expect(result.ranking[0]).toBe("srv__t58");
    expect(result.ranking).not.toContain("srv__t59");
    expect(result.inputTokens).toBe(300);
    expect(result.refusedCalls).toBe(0);
  });

  it("returns nothing when no tool fits, and ranks everything when ungated", async () => {
    const { model } = mockJev(() => 0);
    expect((await jevSearch({ id: "j", label: "J", model }).rank(query(), tools(5))).ranking).toEqual([]);
    const ungated = jevSearch({ id: "j", label: "J", model, options: { gate: false } });
    expect((await ungated.rank(query(), tools(5))).ranking).toEqual(["srv__t4", "srv__t3", "srv__t2", "srv__t1", "srv__t0"]);
  });

  it("retries refused calls and counts them, and reads a bare choice", async () => {
    const { model } = mockJev(() => 1, { failFirst: 2, bare: true });
    const result = await jevSearch({ id: "j", label: "J", model, retryDelayMs: 0 }).rank(query(), tools(3));
    expect(result.refusedCalls).toBe(2);
    expect(result.ranking[0]).toBe("srv__t2");
  });

  it("reads a bare choice in the wide pass too", async () => {
    const { model } = mockJev(() => 1, { bare: true });
    const result = await jevSearch({ id: "j", label: "J", model, options: { chunkSize: 30, shortlist: 4 } }).rank(query(), tools(40));
    expect(result.ranking).toContain("srv__t29");
  });
});

describe("embeddingRetriever", () => {
  it("embeds the catalog once and ranks by cosine similarity", async () => {
    let batches = 0;
    const model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => {
        batches += values.filter((value) => String(value).includes("Send email")).length;
        return {
          embeddings: values.map((value) => (String(value).includes("calendar") ? [1, 0] : [0, 1])),
          usage: { tokens: 7 },
          providerMetadata: { gateway: { marketCost: "0.001" } },
          warnings: [],
        };
      },
    });
    const catalog = [
      { name: "a", description: "Send email" },
      { name: "b", description: "Create a calendar event" },
    ];
    const retriever = embeddingRetriever({ id: "e", label: "E", input: "keywords", model });
    await retriever.prepare!(catalog);
    const result = await retriever.rank(query(), catalog);
    await retriever.rank(query(), catalog);
    expect(result).toEqual({ ranking: ["b", "a"], inputTokens: 7, costUsd: 0.001 });
    expect(batches).toBe(1);
    expect(retriever.id).toBe("e@keywords");
    expect(toolText(catalog[0]!)).toBe("a: Send email");
  });

  it("costs 0 when the provider reports nothing", async () => {
    const model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1]), usage: { tokens: 1 }, warnings: [] }),
    });
    const retriever = embeddingRetriever({ id: "e", label: "E", input: "request", model });
    expect((await retriever.rank(query(), [{ name: "a", description: "x" }])).costUsd).toBe(0);
  });
});

describe("runAbstain", () => {
  it("runs each query without its servers, files results under the full size, and skips done keys", async () => {
    const catalog = [...tools(2, "a"), ...tools(2, "b")];
    const seen: number[] = [];
    const empty = { id: "empty", label: "E", rank: async (_q: unknown, c: ToolDoc[]) => (seen.push(c.length), { ranking: [], inputTokens: 0, costUsd: 0 }) };
    const results = await runAbstain({
      retrievers: [empty, fixedRetriever(["b__t0"], "always")],
      queries: [query({ id: "q1", relevant: ["a__t0"] }), query({ id: "q2", relevant: ["a__t1"] })],
      catalog,
      done: new Set(["always|4|q2"]),
      onResult: () => {},
    });
    expect(results).toHaveLength(3);
    expect(seen).toEqual([2, 2]);
    expect(results.every(({ catalogSize }) => catalogSize === 4)).toBe(true);
    expect(abstainRate(results, "empty")).toEqual({ rate: 1, queries: 2 });
    expect(abstainRate(results, "always")).toEqual({ rate: 0, queries: 1 });
  });

  it("works without a callback", async () => {
    const results = await runAbstain({ retrievers: [fixedRetriever([])], queries: [query()], catalog: tools(1) });
    expect(results).toHaveLength(1);
  });
});

describe("createMcpArms", () => {
  it("includes whole-catalog rerank only where Voyage accepts the catalog", () => {
    const small = createMcpArms(525).map(({ id }) => id);
    expect(small).toContain("rerank");
    expect(small).toContain(`bm25-jev-${MCP_SHORTLIST}`);
    expect(createMcpArms(2000).map(({ id }) => id)).not.toContain("rerank");
    expect(new Set(small).size).toBe(small.length);
  });
});

describe("anthropicSchema", () => {
  it("keeps names, types, descriptions, enums and item types, dropping the rest", () => {
    expect(
      anthropicSchema({
        type: "object",
        $schema: "http://json-schema.org/draft-07/schema#",
        properties: {
          q: { type: "string", description: "Query", minLength: 1 },
          tags: { type: "array", items: { type: "string" } },
          ids: { type: "array", items: { anyOf: [] } },
          mode: { enum: ["a", "b"] },
          odd: { type: ["string", "null"] },
        },
        required: ["q", "missing"],
      })
    ).toEqual({
      type: "object",
      properties: {
        q: { type: "string", description: "Query" },
        tags: { type: "array", items: { type: "string" } },
        ids: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["a", "b"] },
        odd: { type: "string" },
      },
      required: ["q"],
    });
  });

  it("falls back to one free-text argument without properties", () => {
    expect(anthropicSchema(undefined)).toMatchObject({ required: ["request"] });
    expect(anthropicSchema({ type: "object", properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });
});

describe("summary counts refused calls", () => {
  it("adds in-search refusals to failed attempts", async () => {
    const { summarize } = await import("../src/summary");
    const row: QueryResult = {
      retrieverId: "x",
      queryId: "task-001",
      catalogSize: 5,
      ranking: ["a"],
      relevant: ["a"],
      latencyMs: 1,
      inputTokens: 0,
      costUsd: 0,
      failures: ["one"],
      refusedCalls: 3,
    };
    expect(summarize([row], [fixedRetriever([], "x")])[0]!.failedAttempts).toBe(4);
  });
});
