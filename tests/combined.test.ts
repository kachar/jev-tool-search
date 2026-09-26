import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { clip, jevJudge, JUDGE_DESCRIPTION_CHARS } from "../src/jev";
import { judgedRetriever } from "../src/judged";
import { COMBINED_SEARCH_SHORTLIST, COMBINED_SHORTLISTS, createMcpArms } from "../src/mcp-arms";
import { shortlisted } from "../src/shortlist";
import { fixedRetriever, query } from "./fixtures";

const catalog = ["a", "b", "c", "d"].map((name) => ({ name, description: `Tool ${name}` }));

describe("shortlisted", () => {
  it("runs the inner search over the lexical top K only and adds up the spend", async () => {
    const seen: string[][] = [];
    const inner = {
      id: "inner",
      label: "Inner",
      rank: async (_query: unknown, candidates: typeof catalog) => {
        seen.push(candidates.map(({ name }) => name));
        return { ranking: [], inputTokens: 10, costUsd: 1, refusedCalls: 2 };
      },
    };
    const retriever = shortlisted({ id: "s", label: "S", lexical: fixedRetriever(["c", "a", "b"]), inner, size: 2 });
    const result = await retriever.rank(query(), catalog);
    expect(seen).toEqual([["a", "c"]]);
    // Nothing from the lexical tail: an inner "none fit" stays empty.
    expect(result).toEqual({ ranking: [], inputTokens: 11, costUsd: 1.5, refusedCalls: 2 });
  });

  it("returns the lexical result when it found nothing", async () => {
    const inner = fixedRetriever(["x"], "inner");
    const retriever = shortlisted({ id: "s", label: "S", lexical: fixedRetriever([]), inner, size: 5 });
    expect((await retriever.rank(query(), catalog)).ranking).toEqual([]);
  });
});

describe("jevJudge retries and clipping", () => {
  it("clips long descriptions and counts refused calls", async () => {
    let failures = 1;
    const criteria: Record<string, unknown>[] = [];
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        if (failures-- > 0) throw new Error("at capacity");
        criteria.push((options.questions.tool as { criteria: Record<string, unknown> }).criteria);
        return { answers: { tool: { type: "choice", choice: "a" } }, usage: { inputTokens: 1 }, warnings: [] };
      },
    });
    const long = [{ name: "a", description: "x".repeat(1000) }];
    const result = await jevJudge(model, { retryDelayMs: 0 }).rank("request", long, []);
    expect(result.refusedCalls).toBe(1);
    expect(String(criteria[0]!.a)).toHaveLength(JUDGE_DESCRIPTION_CHARS);
    expect(clip("short", 10)).toBe("short");
  });

  it("carries the judge's refused calls through a judged retriever", async () => {
    const judge = { maxCandidates: 10, rank: async () => ({ ranking: ["a"], inputTokens: 1, costUsd: 0, refusedCalls: 3 }) };
    const retriever = judgedRetriever({ id: "j", label: "J", lexical: fixedRetriever(["a"]), judge });
    expect((await retriever.rank(query(), catalog)).refusedCalls).toBe(3);
  });
});

describe("combined arms", () => {
  it("adds a Jev arm per shortlist size and a shortlisted Jev search", () => {
    const ids = createMcpArms(525).map(({ id }) => id);
    for (const size of COMBINED_SHORTLISTS) {
      expect(ids).toContain(`bm25-jev-${size}`);
    }
    expect(ids).toContain(`bm25-jev-search-${COMBINED_SEARCH_SHORTLIST}`);
    expect(ids).toContain(`embed-jev-search-${COMBINED_SEARCH_SHORTLIST}`);
  });
});
