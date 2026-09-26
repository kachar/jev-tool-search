import { describe, expect, it } from "vitest";
import {
  agentTools,
  claudeAgent,
  CUSTOM_SEARCH_TOOL,
  deferredTools,
  MAX_TURNS,
  toolNames,
  type ContentBlock,
  type MessagesClient,
  type MessagesRequest,
} from "../src/claude-agent";
import { vertexClient, VERTEX_VERSION } from "../src/vertex";
import { catalog, fixedRetriever, query } from "./fixtures";

const usage = { input_tokens: 1000, output_tokens: 100 };
const reply = (...content: ContentBlock[]) => ({ content, stop_reason: "end_turn", usage });
const price = { input: 1e-6, output: 1e-5 };

/** A scripted Claude: returns the replies in order and records every request. */
const scripted = (...replies: ReturnType<typeof reply>[]) => {
  const requests: MessagesRequest[] = [];
  const client: MessagesClient = async (request) => {
    requests.push(structuredClone(request));
    return replies[Math.min(requests.length - 1, replies.length - 1)]!;
  };
  return { client, requests };
};

describe("Claude models", () => {
  it("defaults to Opus 5.5 and prices every model it knows", async () => {
    const { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } = await import("../src/claude-agent");
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5-5");
    expect(CLAUDE_MODELS[DEFAULT_CLAUDE_MODEL]).toEqual({ input: 4e-6, output: 2e-5 });
    expect(CLAUDE_MODELS["claude-sonnet-4-5@20250929"]).toEqual({ input: 3e-6, output: 1.5e-5 });
  });

  it("charges the default model's price when none is given", async () => {
    const { client } = scripted(reply({ type: "tool_use", id: "1", name: "send_email", input: {} }));
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "none" } });
    expect((await agent.rank(query(), catalog)).costUsd).toBeCloseTo(1000 * 4e-6 + 100 * 2e-5);
  });
});

describe("toolNames", () => {
  it("makes names legal and unique, and maps them back", () => {
    const { toApi, fromApi } = toolNames([
      { name: "PDF&URLTool", description: "" },
      { name: "PDF?URLTool", description: "" },
      { name: "ok_name", description: "" },
      { name: "x".repeat(130), description: "" },
    ]);
    expect(toApi.get("PDF&URLTool")).toBe("PDF_URLTool");
    expect(toApi.get("PDF?URLTool")).toBe("PDF_URLTool_2");
    expect(toApi.get("ok_name")).toBe("ok_name");
    expect(toApi.get("x".repeat(130))).toHaveLength(128);
    expect(fromApi.get("PDF_URLTool_2")).toBe("PDF?URLTool");
  });
});

describe("agentTools", () => {
  it("defers every catalog tool behind a server search", () => {
    const tools = agentTools({ kind: "server", variant: "bm25" }, catalog) as { name?: string; type?: string; defer_loading?: boolean }[];
    expect(tools[0]).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
    expect(tools.slice(1).every(({ defer_loading }) => defer_loading)).toBe(true);
  });

  it("puts a custom search tool first, or loads everything when there is no search", () => {
    const custom = agentTools({ kind: "custom", search: fixedRetriever([]) }, catalog) as { name: string }[];
    expect(custom[0]!.name).toBe(CUSTOM_SEARCH_TOOL);
    const none = agentTools({ kind: "none" }, catalog) as { defer_loading?: boolean }[];
    expect(none).toHaveLength(catalog.length);
    expect(none.every(({ defer_loading }) => defer_loading === undefined)).toBe(true);
    expect(deferredTools(catalog)[0]).toMatchObject({ input_schema: { required: ["request"] } });
  });
});

describe("claudeAgent", () => {
  it("returns the first non-search tool Claude calls, with token cost", async () => {
    const { client } = scripted(
      reply(
        { type: "server_tool_use", name: "tool_search_tool_bm25" },
        { type: "tool_use", id: "1", name: "createCalendarEvent", input: {} }
      )
    );
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "server", variant: "bm25" }, price });
    expect(await agent.rank(query(), catalog)).toEqual({
      ranking: ["createCalendarEvent"],
      inputTokens: 1000,
      costUsd: 1000 * 1e-6 + 100 * 1e-5,
      details: { turns: 1, searches: 1, claudeInputTokens: 1000, claudeOutputTokens: 100, searchInputTokens: 0 },
    });
  });

  it("runs a custom search, answers with tool_reference blocks, then records the call", async () => {
    const { client, requests } = scripted(
      reply({ type: "tool_use", id: "s1", name: CUSTOM_SEARCH_TOOL, input: { query: "calendar" } }),
      reply({ type: "tool_use", id: "2", name: "createCalendarEvent", input: {} })
    );
    const seen: string[] = [];
    const search = {
      ...fixedRetriever(Array.from({ length: 7 }, (_, i) => (i === 0 ? "createCalendarEvent" : `t${i}`))),
      rank: async (q: { request: string; keywords?: string }) => {
        seen.push(q.request, q.keywords ?? "");
        return { ranking: ["createCalendarEvent", "t1", "t2", "t3", "t4", "t5"], inputTokens: 5, costUsd: 0.5 };
      },
    };
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "custom", search }, price });
    const result = await agent.rank(query(), catalog);
    expect(result.ranking).toEqual(["createCalendarEvent"]);
    expect(result.inputTokens).toBe(2000);
    expect(result.details).toMatchObject({ turns: 2, searches: 1, searchInputTokens: 5 });
    expect(seen[0]).toContain("The assistant searched for: calendar");
    expect(seen[1]).toBe("calendar");
    const toolResult = (requests[1]!.messages[2]!.content as { content: object[] }[])[0]!;
    expect(toolResult.content).toHaveLength(5);
    expect(toolResult.content[0]).toEqual({ type: "tool_reference", tool_name: "createCalendarEvent" });
  });

  it("tells Claude when a custom search found nothing, and gives up after the last turn", async () => {
    const { client, requests } = scripted(
      reply({ type: "tool_use", id: "s", name: CUSTOM_SEARCH_TOOL, input: { query: "nothing" } })
    );
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "custom", search: fixedRetriever([]) } });
    const result = await agent.rank(query(), catalog);
    expect(result.ranking).toEqual([]);
    expect(requests).toHaveLength(MAX_TURNS);
    expect((requests[1]!.messages[2]!.content as { content: object[] }[])[0]!.content).toEqual([
      { type: "text", text: "No matching tools. Try different words." },
    ]);
  });

  it("continues a paused server-side turn", async () => {
    const { client, requests } = scripted(
      { ...reply({ type: "server_tool_use", name: "tool_search_tool_bm25" }), stop_reason: "pause_turn" },
      reply({ type: "tool_use", id: "1", name: "createCalendarEvent", input: {} })
    );
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "server", variant: "bm25" } });
    expect((await agent.rank(query(), catalog)).ranking).toEqual(["createCalendarEvent"]);
    expect(requests[1]!.messages).toHaveLength(2);
  });

  it("stops when Claude answers without calling a tool", async () => {
    const { client, requests } = scripted(reply({ type: "text", text: "I can't help" }));
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "none" } });
    expect((await agent.rank(query(), catalog)).ranking).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("maps a sanitized tool name back to the catalog name", async () => {
    const odd = [{ name: "PDF&URLTool", description: "Export a PDF" }];
    const { client } = scripted(reply({ type: "tool_use", id: "1", name: "PDF_URLTool", input: {} }));
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "none" } });
    expect((await agent.rank(query(), odd)).ranking).toEqual(["PDF&URLTool"]);
  });

  it("keeps an unknown tool name as Claude sent it", async () => {
    const { client } = scripted(reply({ type: "tool_use", id: "1", name: "made_up", input: {} }));
    const agent = claudeAgent({ id: "a", label: "A", client, mode: { kind: "none" } });
    expect((await agent.rank(query(), catalog)).ranking).toEqual(["made_up"]);
  });
});

describe("vertexClient", () => {
  it("posts the Anthropic body with the Vertex version to rawPredict", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply({ type: "text", text: "hi" })), { status: 200 });
    }) as typeof fetch;
    const client = vertexClient({ project: "p", region: "r", model: "m", getToken: async () => "t", fetch: fetchImpl });
    const response = await client({ max_tokens: 1, messages: [], tools: [] });
    expect(response.content[0]!.text).toBe("hi");
    expect(calls[0]!.url).toBe(
      "https://r-aiplatform.googleapis.com/v1/projects/p/locations/r/publishers/anthropic/models/m:rawPredict"
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ anthropic_version: VERTEX_VERSION });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer t");
  });

  it("throws with the status and body on failure", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const client = vertexClient({ project: "p", region: "r", model: "m", getToken: async () => "t", fetch: fetchImpl });
    await expect(client({ max_tokens: 1, messages: [], tools: [] })).rejects.toThrow("Vertex 404: nope");
  });

  it("uses the global fetch by default", () => {
    expect(typeof vertexClient({ project: "p", region: "r", model: "m", getToken: async () => "t" })).toBe("function");
  });
});
