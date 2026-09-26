import { APICallError } from "ai";
import { Experimental_EvaluationMockModelV4 as MockModel } from "ai/test";
import { describe, expect, it } from "vitest";
import { createIndex, planChunks, search } from "../experiments/engine";

type Doc = { name: string; description: string };
type Question = { type: string; criteria: Record<string, unknown> };

const catalog = (size: number, describe = (i: number) => `tool number ${i}`): Doc[] =>
  Array.from({ length: size }, (_, i) => ({ name: `tool_${i}`, description: describe(i) }));

/** A mock Jev that puts all probability on `winner` when offered, else on the first option. */
function mockJev({ winner = "tool_7", fail }: { winner?: string; fail?: (call: number) => Error | undefined } = {}) {
  let calls = 0;
  const model = new MockModel({
    doEvaluate: async ({ questions }) => {
      calls++;
      const error = fail?.(calls);
      if (error) throw error;
      const { criteria } = questions.pick as unknown as Question;
      const options = Object.keys(criteria);
      const pick = options.includes(winner) ? winner : options[0]!;
      return {
        answers: { pick: { type: "choice", choice: pick, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 1 : 0])) } },
        usage: { inputTokens: 100 },
        warnings: [],
      };
    },
  });
  return { model, calls: () => calls };
}

const capacity = () =>
  new APICallError({ message: "Service temporarily unavailable", url: "x", requestBodyValues: {}, statusCode: 503, isRetryable: true });
const badKey = () =>
  new APICallError({ message: "Unauthorized", url: "x", requestBodyValues: {}, statusCode: 401, isRetryable: false });

describe("planChunks", () => {
  it("keeps every chunk under the token budget, even with mixed option lengths", () => {
    const index = createIndex({
      documents: catalog(300, (i) => (i % 7 === 0 ? "x".repeat(60) : "short")),
      id: (d) => d.name,
      describe: (d) => d.description,
      requestTokens: 1200,
    });
    const chunks = planChunks([...index.documents.keys()], index, 20);
    const room = 1200 - 40 - 20;
    for (const chunk of chunks) {
      expect(chunk.reduce((sum, id) => sum + index.tokens.get(id)!, 0)).toBeLessThanOrEqual(room);
    }
    expect(chunks.flat()).toHaveLength(300);
  });

  it("keeps room for options when the state alone exceeds the budget", () => {
    const index = createIndex({ documents: catalog(5), id: (d) => d.name, describe: (d) => d.description, requestTokens: 100 });
    expect(planChunks([...index.documents.keys()], index, 2000).flat()).toHaveLength(5);
  });
});

describe("search", () => {
  // Direct plan up to 400 tokens (≈ 20 tools here), unhedged, so request counts are exact.
  const build = (size: number, model: MockModel, config = {}) =>
    createIndex({ documents: catalog(size), id: (d) => d.name, describe: (d) => d.description, model, requestTokens: 400, directTokens: 400, hedge: 1, attempts: 2, ...config });

  it("answers a small catalog with one direct request", async () => {
    const { model, calls } = mockJev();
    const result = await search(build(10, model), { state: "User request: x" });
    expect(result.plan).toBe("direct");
    expect(result.hits[0]).toMatchObject({ id: "tool_7", probability: 1, stage: "final" });
    expect(calls()).toBe(1);
  });

  it("runs a tournament over a big catalog and honours a limit beyond the finalists", async () => {
    const { model } = mockJev();
    const result = await search(build(120, model), { state: "User request: x", limit: 50 });
    expect(result.plan).toBe("tournament");
    expect(result.hits[0]!.id).toBe("tool_7");
    expect(result.hits).toHaveLength(50);
    expect(result.hits.some((hit) => hit.stage === "round")).toBe(true);
  });

  it("degrades from a refused direct question to a tournament", async () => {
    const { model, calls } = mockJev({ fail: (call) => (call <= 2 ? capacity() : undefined) });
    const result = await search(build(200, model, { directTokens: 20000 }), { state: "x" });
    expect(result.plan).toBe("tournament");
    expect(result.degraded).toBe("direct refused");
    expect(result.hits[0]!.id).toBe("tool_7");
    expect(calls()).toBeGreaterThan(3);
  });

  it("hedges a direct question: one refusal among identical requests costs no attempt", async () => {
    const { model } = mockJev({ fail: (call) => (call === 1 ? capacity() : undefined) });
    const result = await search(build(10, model, { hedge: 2, directAttempts: 1 }), { state: "x" });
    expect(result.plan).toBe("direct");
    expect(result.requests[0]!.failures).toBe(0);
  });

  it("retries capacity errors and still answers", async () => {
    const { model } = mockJev({ fail: (call) => (call === 1 ? capacity() : undefined) });
    const result = await search(build(10, model), { state: "x" });
    expect(result.plan).toBe("direct");
    expect(result.requests[0]!.failures).toBe(1);
  });

  it("keeps the other chunks when one chunk keeps failing", async () => {
    // Chunk requests go out in order; make the first chunk's two attempts fail.
    const { model } = mockJev({ fail: (call) => (call === 1 || call === 9 ? capacity() : undefined) });
    const result = await search(build(120, model), { state: "x", limit: 3 });
    expect(result.plan).toBe("tournament");
    expect(result.hits[0]!.id).toBe("tool_7");
  });

  it("falls back to the caller's ranking when Jev keeps refusing", async () => {
    const { model } = mockJev({ fail: () => capacity() });
    const fallback = ["tool_3", "tool_1", "tool_2"];
    const result = await search(build(10, model), { state: "x", limit: 2, fallback });
    expect(result.plan).toBe("fallback");
    expect(result.hits.map((hit) => hit.id)).toEqual(["tool_3", "tool_1"]);
  });

  it("retries an answer the SDK rejects as inconsistent", async () => {
    const quirk = new Error('Question "pick" did not select a highest-probability option.');
    const { model } = mockJev({ fail: (call) => (call === 1 ? quirk : undefined) });
    const result = await search(build(10, model), { state: "x" });
    expect(result.plan).toBe("direct");
    expect(result.hits[0]!.id).toBe("tool_7");
  });

  it("throws configuration errors instead of hiding them behind a fallback", async () => {
    const { model, calls } = mockJev({ fail: () => badKey() });
    await expect(search(build(10, model), { state: "x" })).rejects.toThrow(/Unauthorized/);
    expect(calls()).toBe(1);
  });

  it("flags abstention against a probability floor", async () => {
    const { model } = mockJev({ winner: "none-of-these" });
    const result = await search(build(5, model), { state: "x", minProbability: 1.1 });
    expect(result.abstained).toBe(true);
  });
});
