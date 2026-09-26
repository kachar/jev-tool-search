import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { jevSearch } from "../src/jev-search";
import { runQuery } from "../src/runner";
import { query } from "./fixtures";

const one = [{ name: "srv__t0", description: "Tool number 0." }];

describe("edge branches", () => {
  it("treats missing token usage as zero", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => ({
        answers: { which: { type: "choice", choice: "srv__t0" }, fit_0: { type: "boolean", probability: 1 } },
        usage: {},
        warnings: [],
      }),
    });
    const result = await jevSearch({ id: "j", label: "J", model }).rank(query(), one);
    expect(result).toMatchObject({ ranking: ["srv__t0"], inputTokens: 0, costUsd: 0 });
  });

  it("keeps a search's refused-call count on the result", async () => {
    const retriever = {
      id: "r",
      label: "R",
      rank: async () => ({ ranking: [], inputTokens: 0, costUsd: 0, refusedCalls: 2, details: { turns: 3 } }),
    };
    const result = await runQuery(retriever, query(), one);
    expect(result.refusedCalls).toBe(2);
    expect(result.details).toEqual({ turns: 3 });
  });
});
