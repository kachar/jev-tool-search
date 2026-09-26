import { describe, expect, it } from "vitest";
import {
  BM25_PLAIN,
  BM25_TUNED,
  bm25Retriever,
  extractKeywords,
  normalizeQuery,
  splitIdentifier,
} from "../src/bm25";
import { keywordRetriever, keywordScores, tokenize } from "../src/keyword";
import { queryText } from "../src/types";
import { catalog, query } from "./fixtures";

describe("queryText", () => {
  it("reads the request or the agent's keywords", () => {
    expect(queryText(query(), "request")).toContain("Anna");
    expect(queryText(query(), "keywords")).toBe("calendar event");
  });

  it("refuses a keywords search on a query without keywords", () => {
    expect(() => queryText(query({ keywords: undefined }), "keywords")).toThrow("no agent-written");
  });
});

describe("keyword retriever (AI SDK toolSearch port)", () => {
  it("splits camel case and keeps letter/number runs", () => {
    expect(tokenize("createCalendarEvent v2!")).toEqual(["create", "calendar", "event", "v2"]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("weights name hits 2 and description hits 1, dropping zero scores", () => {
    expect(keywordScores("calendar forecast", catalog)).toEqual([
      { name: "createCalendarEvent", score: 3 },
      { name: "get_weather", score: 1 },
    ]);
  });

  it("ranks by the chosen query text at zero cost", async () => {
    const result = await keywordRetriever("keywords").rank(query(), catalog);
    expect(result).toEqual({ ranking: ["createCalendarEvent"], inputTokens: 0, costUsd: 0 });
    expect(keywordRetriever("request").id).toBe("keyword@request");
  });
});

describe("bm25 retriever", () => {
  it("splits identifiers and normalizes queries", () => {
    expect(splitIdentifier("create_calendarEvent-now")).toBe("create calendar Event now");
    expect(normalizeQuery("WebSearch?!")).toBe("Web Search");
  });

  it("extracts distinct content words, capped at twenty", () => {
    expect(extractKeywords(catalog[1]!)).toEqual(["create", "calendar", "event", "new", "user"]);
    const long = { name: "x", description: Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ") };
    expect(extractKeywords(long)).toHaveLength(20);
  });

  it("finds the calendar tool under both presets and reuses the index", async () => {
    for (const options of [BM25_PLAIN, BM25_TUNED]) {
      const retriever = bm25Retriever({ id: "bm25", label: "BM25", options, input: "keywords" });
      const first = await retriever.rank(query(), catalog);
      const second = await retriever.rank(query(), catalog);
      expect(first.ranking[0]).toBe("createCalendarEvent");
      expect(second).toEqual(first);
      expect(retriever.id).toBe("bm25@keywords");
    }
  });

  it("tolerates a one-letter typo only in the tuned preset", async () => {
    const typo = query({ keywords: "calendr" });
    const plain = bm25Retriever({ id: "p", label: "p", options: BM25_PLAIN, input: "keywords" });
    const production = bm25Retriever({ id: "q", label: "q", options: BM25_TUNED, input: "keywords" });
    expect((await plain.rank(typo, catalog)).ranking).toEqual([]);
    expect((await production.rank(typo, catalog)).ranking[0]).toBe("createCalendarEvent");
  });
});
