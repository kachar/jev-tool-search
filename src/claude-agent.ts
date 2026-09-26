import type { RankResult, Retriever, ToolDoc } from "./types";

// End to end: Claude with a deferred tool catalog, searching for tools the way it does in production,
// until it makes its first real tool call. The arm is right when that call names a relevant tool.
// Built-in search runs on Anthropic's side (`tool_search_tool_bm25` / `_regex`); a custom search is
// our own tool that answers with `tool_reference` blocks, the documented client-side contract
// (platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool#custom-tool-search-implementation).

/** The slice of the Anthropic Messages API this harness speaks. */
export type ContentBlock = {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
};
export type Message = { role: "user" | "assistant"; content: string | ContentBlock[] | object[] };
export type MessagesRequest = {
  max_tokens: number;
  messages: Message[];
  tools: object[];
  system?: string;
};
export type MessagesResponse = {
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
};
export type MessagesClient = (request: MessagesRequest) => Promise<MessagesResponse>;

/** List price per token for a Claude model. */
export type TokenPrice = { input: number; output: number };

const PER_MILLION = 1_000_000;

/**
 * Vertex model ids and their list prices (ai-gateway.vercel.sh/v1/models, 2026-09-26). Opus 5.5 is
 * the default: the newest Claude on the tool-search compatibility table. Sonnet 4.5 is kept because
 * the published run used it.
 */
export const CLAUDE_MODELS = {
  "claude-opus-5-5": { input: 4 / PER_MILLION, output: 20 / PER_MILLION },
  "claude-sonnet-4-5@20250929": { input: 3 / PER_MILLION, output: 15 / PER_MILLION },
} satisfies Record<string, TokenPrice>;

export type ClaudeModel = keyof typeof CLAUDE_MODELS;
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = "claude-opus-5-5";

export const MAX_TURNS = 4;
export const MAX_TOKENS = 1024;
export const SEARCH_RESULTS = 5;
export const CUSTOM_SEARCH_TOOL = "find_tools";

export const SYSTEM =
  "You are a helpful assistant with a large catalog of tools. Use the tool search to find the right tool, then call it to handle the user's request. Always call a tool; never answer from memory.";

const NAME_PATTERN = /[^a-zA-Z0-9_-]/g;
const MAX_NAME_LENGTH = 128;

/**
 * Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$. Maps each catalog name to a legal, unique
 * one and back, so a dataset name like `PDF&URLTool` survives the round trip.
 */
export function toolNames(catalog: ToolDoc[]) {
  const toApi = new Map<string, string>();
  const fromApi = new Map<string, string>();
  for (const { name } of catalog) {
    const base = name.replace(NAME_PATTERN, "_").slice(0, MAX_NAME_LENGTH);
    let legal = base;
    for (let suffix = 2; fromApi.has(legal); suffix++) {
      legal = `${base.slice(0, MAX_NAME_LENGTH - String(suffix).length - 1)}_${suffix}`;
    }
    toApi.set(name, legal);
    fromApi.set(legal, name);
  }
  return { toApi, fromApi };
}

const FALLBACK_SCHEMA = {
  type: "object",
  properties: { request: { type: "string", description: "What the user wants done" } },
  required: ["request"],
};
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

type PropertySpec = { type?: unknown; description?: unknown; enum?: unknown; items?: { type?: unknown } };

/**
 * A flat, always-valid copy of an MCP tool's schema: property names, types, descriptions, enums and
 * array item types. Real servers ship schemas Anthropic's validator rejects; selection only needs
 * what a property is called and what it is for.
 */
export function anthropicSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") {
    return FALLBACK_SCHEMA;
  }
  const clean = Object.fromEntries(
    Object.entries(properties as Record<string, PropertySpec>).map(([name, spec]) => {
      const type = typeof spec?.type === "string" && JSON_TYPES.has(spec.type) ? spec.type : "string";
      return [
        name,
        {
          type,
          ...(typeof spec?.description === "string" ? { description: spec.description } : {}),
          ...(Array.isArray(spec?.enum) ? { enum: spec.enum } : {}),
          ...(type === "array"
            ? { items: { type: typeof spec.items?.type === "string" && JSON_TYPES.has(spec.items.type) ? spec.items.type : "string" } }
            : {}),
        },
      ];
    })
  );
  const required = Array.isArray(schema.required) ? schema.required.filter((name) => name in clean) : [];
  return { type: "object", properties: clean, ...(required.length ? { required } : {}) };
}

/** Every catalog tool as a deferred Anthropic tool. The datasets carry no schemas, so one free-text argument stands in. */
export function deferredTools(catalog: ToolDoc[], deferLoading = true) {
  const { toApi } = toolNames(catalog);
  return catalog.map((tool) => ({
    name: toApi.get(tool.name)!,
    description: tool.description,
    input_schema: anthropicSchema(tool.inputSchema),
    ...(deferLoading ? { defer_loading: true } : {}),
  }));
}

const customSearchTool = {
  name: CUSTOM_SEARCH_TOOL,
  description:
    "Find the tools that can handle a task. Describe what you need to do in plain words. Returns the best matching tools, which become available to call.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "What you need a tool for" } },
    required: ["query"],
  },
};

/** How the agent finds tools: Anthropic's server search, our own search, or none (all tools loaded). */
export type SearchMode =
  | { kind: "server"; variant: "bm25" | "regex" }
  | { kind: "custom"; search: Retriever }
  | { kind: "none" };

export function agentTools(mode: SearchMode, catalog: ToolDoc[]): object[] {
  switch (mode.kind) {
    case "server":
      return [
        { type: `tool_search_tool_${mode.variant}_20251119`, name: `tool_search_tool_${mode.variant}` },
        ...deferredTools(catalog),
      ];
    case "custom":
      return [customSearchTool, ...deferredTools(catalog)];
    case "none":
      return deferredTools(catalog, false);
  }
}

const isSearch = (name: string | undefined) =>
  name === CUSTOM_SEARCH_TOOL || name?.startsWith("tool_search_tool_") === true;

type AgentOptions = {
  id: string;
  label: string;
  client: MessagesClient;
  mode: SearchMode;
  price?: TokenPrice;
};

/**
 * Claude as a retriever: the "ranking" is the one tool it chose to call first, or nothing. Cost is
 * Claude's tokens at list price plus whatever the custom search spent.
 */
export function claudeAgent({
  id,
  label,
  client,
  mode,
  price = CLAUDE_MODELS[DEFAULT_CLAUDE_MODEL],
}: AgentOptions): Retriever {
  return {
    id,
    label,
    rank: async (query, catalog): Promise<RankResult> => {
      const tools = agentTools(mode, catalog);
      const { toApi, fromApi } = toolNames(catalog);
      const messages: Message[] = [{ role: "user", content: query.request }];
      // Claude's own tokens and the search's are kept apart: they are priced ~70x apart.
      const details = { turns: 0, searches: 0, claudeInputTokens: 0, claudeOutputTokens: 0, searchInputTokens: 0 };
      let costUsd = 0;
      const done = (ranking: string[]): RankResult => ({
        ranking,
        inputTokens: details.claudeInputTokens,
        costUsd,
        details,
      });
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await client({ max_tokens: MAX_TOKENS, system: SYSTEM, messages, tools });
        details.turns++;
        details.claudeInputTokens += response.usage.input_tokens;
        details.claudeOutputTokens += response.usage.output_tokens;
        costUsd += response.usage.input_tokens * price.input + response.usage.output_tokens * price.output;
        details.searches += response.content.filter((block) => block.type === "server_tool_use").length;
        const calls = response.content.filter((block) => block.type === "tool_use");
        const chosen = calls.find((block) => !isSearch(block.name));
        if (chosen) {
          return done([fromApi.get(chosen.name!) ?? chosen.name!]);
        }
        if (response.stop_reason === "pause_turn") {
          // A long server-side turn pauses; sending it back as-is lets Claude carry on.
          messages.push({ role: "assistant", content: response.content });
          continue;
        }
        const searches = calls.filter((block) => block.name === CUSTOM_SEARCH_TOOL);
        if (searches.length === 0 || mode.kind !== "custom") {
          // Server search resolves inside one response; a reply with no tool call ends the attempt.
          break;
        }
        details.searches += searches.length;
        messages.push({ role: "assistant", content: response.content });
        const results = await Promise.all(
          searches.map(async (block) => {
            const { query: text } = block.input as { query: string };
            const found = await mode.search.rank(
              { ...query, request: `${query.request}\nThe assistant searched for: ${text}`, keywords: text },
              catalog
            );
            details.searchInputTokens += found.inputTokens;
            costUsd += found.costUsd;
            return {
              type: "tool_result",
              tool_use_id: block.id,
              // An empty search is a plain text result: Claude can rephrase and search again.
              content: found.ranking.length
                ? found.ranking
                    .slice(0, SEARCH_RESULTS)
                    .map((name) => ({ type: "tool_reference", tool_name: toApi.get(name)! }))
                : [{ type: "text", text: "No matching tools. Try different words." }],
            };
          })
        );
        messages.push({ role: "user", content: results });
      }
      return done([]);
    },
  };
}
