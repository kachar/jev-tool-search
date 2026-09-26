import { Experimental_EvaluationMockModelV4, MockRerankingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { gatewayCostUsd, judgedRetriever, type Judge } from "../src/judged";
import { jevJudge, JEV_USD_PER_INPUT_TOKEN, rankByProbability, TOOL_CHOICE_INSTRUCTIONS } from "../src/jev";
import { rerankJudge } from "../src/rerank";
import { catalog, fixedRetriever, query } from "./fixtures";

const evaluationModel = (
  answer: { choice: string; probabilities?: Record<string, number> },
  extra: { inputTokens?: number; providerMetadata?: Record<string, Record<string, string>> } = {}
) => {
  const calls: Parameters<Experimental_EvaluationMockModelV4["doEvaluate"]>[0][] = [];
  const model = new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      calls.push(options);
      return {
      answers: { tool: { type: "choice", ...answer } },
      usage: { inputTokens: extra.inputTokens },
      warnings: [],
      providerMetadata: extra.providerMetadata,
      };
    },
  });
  return Object.assign(model, { calls });
};

describe("gatewayCostUsd", () => {
  it("prefers the market cost, falls back to cost, else undefined", () => {
    expect(gatewayCostUsd({ gateway: { cost: "0", marketCost: "0.25" } })).toBe(0.25);
    expect(gatewayCostUsd({ gateway: { cost: 0.5 } })).toBe(0.5);
    expect(gatewayCostUsd({ gateway: {} })).toBeUndefined();
    expect(gatewayCostUsd(undefined)).toBeUndefined();
  });
});

describe("rankByProbability", () => {
  it("orders by probability, then lexical order, then name", () => {
    const probabilities = { d: 0, c: 0, b: 0.2, a: 0.8, e: 0 };
    expect(rankByProbability(probabilities, ["c", "d"])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("puts unranked ties after lexically ranked ones, alphabetically", () => {
    expect(rankByProbability({ z: 0, y: 0, x: 0 }, ["y"])).toEqual(["y", "x", "z"]);
  });
});

describe("jevJudge", () => {
  it("asks one choice question over the candidates and ranks by its distribution", async () => {
    const model = evaluationModel(
      { choice: "createCalendarEvent", probabilities: { send_email: 0.1, createCalendarEvent: 0.9 } },
      { inputTokens: 1000 }
    );
    const result = await jevJudge(model).rank("book a meeting", catalog.slice(0, 2), []);
    expect(result).toEqual({
      ranking: ["createCalendarEvent", "send_email"],
      inputTokens: 1000,
      costUsd: 1000 * JEV_USD_PER_INPUT_TOKEN,
    });
    const [call] = model.calls;
    expect(call?.state).toBe("User request: book a meeting");
    expect(call?.questions.tool).toMatchObject({ type: "choice", instructions: TOOL_CHOICE_INSTRUCTIONS });
  });

  it("uses the gateway's cost and reads a bare choice as certainty", async () => {
    const model = evaluationModel(
      { choice: "send_email" },
      { providerMetadata: { gateway: { marketCost: "0.01" } } }
    );
    const result = await jevJudge(model).rank("email Bob", catalog.slice(0, 2), []);
    expect(result).toEqual({ ranking: ["send_email"], inputTokens: 0, costUsd: 0.01 });
  });
});

describe("rerankJudge", () => {
  it("maps reranked indexes back to tool names and reads the gateway cost", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async ({ documents }) => {
        expect(documents).toMatchObject({ type: "text" });
        return {
          ranking: [
            { index: 1, relevanceScore: 0.9 },
            { index: 0, relevanceScore: 0.1 },
          ],
          providerMetadata: { gateway: { marketCost: "0.002" } },
        };
      },
    });
    const result = await rerankJudge(model).rank("book a meeting", catalog.slice(0, 2), []);
    expect(result).toEqual({
      ranking: ["createCalendarEvent", "send_email"],
      inputTokens: 0,
      costUsd: 0.002,
    });
  });

  it("costs 0 when the provider reports nothing", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({ ranking: [{ index: 0, relevanceScore: 1 }] }),
    });
    expect((await rerankJudge(model).rank("x", catalog.slice(0, 1), [])).costUsd).toBe(0);
  });
});

describe("judgedRetriever", () => {
  const judge = (ranking: string[], maxCandidates = 10): Judge & { seen: string[][] } => {
    const seen: string[][] = [];
    return {
      seen,
      maxCandidates,
      rank: async (request, candidates) => {
        seen.push([request, ...candidates.map(({ name }) => name)]);
        return { ranking, inputTokens: 10, costUsd: 1 };
      },
    };
  };

  it("judges the whole catalog and appends the lexical tail", async () => {
    const lexical = fixedRetriever(["search_web", "get_weather", "send_email"]);
    const spy = judge(["get_weather"]);
    const retriever = judgedRetriever({ id: "j", label: "J", lexical, judge: spy });
    const result = await retriever.rank(query(), catalog);
    expect(spy.seen[0]).toEqual([query().request, ...catalog.map(({ name }) => name)]);
    expect(result).toEqual({
      ranking: ["get_weather", "search_web", "send_email"],
      inputTokens: 11,
      costUsd: 1.5,
    });
  });

  it("judges only the lexical shortlist when asked", async () => {
    const lexical = fixedRetriever(["search_web", "get_weather", "send_email"]);
    const spy = judge(["get_weather", "search_web"]);
    await judgedRetriever({ id: "j", label: "J", lexical, judge: spy, shortlist: 2 }).rank(
      query(),
      catalog
    );
    expect(spy.seen[0]).toEqual([query().request, "search_web", "get_weather"]);
  });

  it("returns the lexical result when the shortlist is empty", async () => {
    const lexical = fixedRetriever([]);
    const spy = judge([]);
    const result = await judgedRetriever({ id: "j", label: "J", lexical, judge: spy, shortlist: 5 }).rank(
      query(),
      catalog
    );
    expect(result.ranking).toEqual([]);
    expect(spy.seen).toHaveLength(0);
  });

  it("refuses more candidates than the judge accepts", async () => {
    const retriever = judgedRetriever({
      id: "j",
      label: "J",
      lexical: fixedRetriever([]),
      judge: judge([], 2),
    });
    await expect(retriever.rank(query(), catalog)).rejects.toThrow("exceed the judge's limit of 2");
  });
});
