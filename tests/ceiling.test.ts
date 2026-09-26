import { describe, expect, it } from "vitest";
import { lexicalCeilings } from "../src/ceiling";
import { fixedRetriever, query } from "./fixtures";

const catalog = ["a", "b", "c", "d"].map((name) => ({ name, description: `Tool ${name}` }));

describe("lexicalCeilings", () => {
  it("scores the share of tasks with a right tool in the lexical top K, per catalog", async () => {
    const lexical = fixedRetriever(["c", "a", "b"]);
    const queries = [query({ id: "1", relevant: ["a"] }), query({ id: "2", relevant: ["d"] })];
    expect(await lexicalCeilings(lexical, queries, [catalog], [1, 2])).toEqual([
      { catalogSize: 4, k: 1, hit: 0 },
      { catalogSize: 4, k: 2, hit: 0.5 },
    ]);
  });
});
