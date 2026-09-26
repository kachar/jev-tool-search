import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { KEYWORDS_SYSTEM, SEARCH_TOOL_NAME, writeSearchQuery } from "../src/agent-keywords";
import { createArms, SHORTLIST } from "../src/arms";
import { buildCatalog, parseCsv, samplePerTool, shuffle } from "../src/dataset";
import { catalog, query } from "./fixtures";

describe("shuffle and samplePerTool", () => {
  it("shuffles deterministically without losing items", () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(shuffle(items, 3)).toEqual(shuffle(items, 3));
    expect(shuffle(items, 3)).not.toEqual(items);
    expect([...shuffle(items, 3)].sort((a, b) => a - b)).toEqual(items);
  });

  it("keeps at most n rows per tool", () => {
    const rows = ["a", "a", "a", "b"].map((tool, index) => ({ tool, index }));
    const sample = samplePerTool(rows, 2, 1);
    expect(sample.filter(({ tool }) => tool === "a")).toHaveLength(2);
    expect(sample.filter(({ tool }) => tool === "b")).toHaveLength(1);
  });
});

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines, CRLF", () => {
    const text = 'Query,Tool\r\n"Hi, there",A\n"She said ""go""\nnow",B\nplain,C';
    expect(parseCsv(text)).toEqual([
      { Query: "Hi, there", Tool: "A" },
      { Query: 'She said "go"\nnow', Tool: "B" },
      { Query: "plain", Tool: "C" },
    ]);
  });

  it("fills missing cells and ignores a trailing newline", () => {
    expect(parseCsv("a,b\n1\n")).toEqual([{ a: "1", b: "" }]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("buildCatalog", () => {
  it("samples tools and keeps only queries the sample can answer", () => {
    const queries = [
      query(),
      query({ id: "q2", relevant: ["send_email"] }),
      query({ id: "q3", relevant: ["send_email", "get_weather"] }),
    ];
    const full = buildCatalog(catalog, queries, { size: 4, seed: 1 });
    expect(full.catalog).toHaveLength(4);
    expect(full.queries).toHaveLength(3);
    const small = buildCatalog(catalog, queries, { size: 1, seed: 1 });
    const names = small.catalog.map(({ name }) => name);
    expect(small.queries.every(({ relevant }) => relevant.every((name) => names.includes(name)))).toBe(true);
    expect(small.queries.length).toBeLessThan(3);
  });
});

describe("writeSearchQuery", () => {
  const model = (content: unknown[]) =>
    new MockLanguageModelV4({
      doGenerate: {
        content: content as never,
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      },
    });

  it("forces one search call and returns its query", async () => {
    const mock = model([
      {
        type: "tool-call",
        toolCallId: "1",
        toolName: SEARCH_TOOL_NAME,
        input: JSON.stringify({ query: "calendar event" }),
      },
    ]);
    expect(await writeSearchQuery("book a meeting", mock)).toBe("calendar event");
    const [call] = mock.doGenerateCalls;
    expect(call?.toolChoice).toEqual({ type: "tool", toolName: SEARCH_TOOL_NAME });
    expect(call?.prompt[0]).toEqual({ role: "system", content: KEYWORDS_SYSTEM });
  });

  it("throws when the model does not call the search tool", async () => {
    await expect(writeSearchQuery("hi", model([{ type: "text", text: "hello" }]))).rejects.toThrow(
      "did not contain a call to the required tool"
    );
  });
});

describe("createArms", () => {
  it("builds every arm with a unique id", () => {
    const ids = createArms().map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "keyword@request",
      "keyword@keywords",
      "bm25-plain@request",
      "bm25-plain@keywords",
      "bm25-tuned@request",
      "bm25-tuned@keywords",
      "jev",
      `bm25-jev-${SHORTLIST}`,
      "rerank",
      `bm25-rerank-${SHORTLIST}`,
    ]);
  });
});
