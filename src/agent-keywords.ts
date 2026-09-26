import { generateText, jsonSchema, tool, type LanguageModel } from "ai";

// In production nobody feeds the user's sentence to BM25: the agent calls a tool-search tool with a
// query it wrote. This gives a small model exactly that tool — the AI SDK 7 `toolSearch()`
// description and input schema — forces one call, and keeps the query it sends. The model sees the
// request and the search tool, never the catalog.

export const KEYWORDS_MODEL = "anthropic/claude-haiku-4.5";
export const SEARCH_TOOL_NAME = "tool_search";

/** The AI SDK 7 `toolSearch()` description, verbatim. */
export const TOOL_SEARCH_DESCRIPTION =
  "Search for tools by keywords in their names and descriptions. Returns up to five matching tools. Matches become available on the next model step, after this execution finishes. Wait for their tool definitions before calling the discovered tools. If no tools match, try different keywords.";

export const KEYWORDS_SYSTEM =
  "You are a helpful assistant. Your tools load on demand: find the one you need with the tool search tool.";

const searchTool = tool({
  description: TOOL_SEARCH_DESCRIPTION,
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  }),
});

export async function writeSearchQuery(
  request: string,
  model: LanguageModel = KEYWORDS_MODEL
): Promise<string> {
  const { toolCalls } = await generateText({
    model,
    system: KEYWORDS_SYSTEM,
    prompt: request,
    temperature: 0,
    tools: { [SEARCH_TOOL_NAME]: searchTool },
    toolChoice: { type: "tool", toolName: SEARCH_TOOL_NAME },
  });
  // A forced tool choice the model ignores throws inside the SDK, so a call is always here.
  return (toolCalls[0]!.input as { query: string }).query;
}
