import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { clip, JEV_MAX_OPTIONS, JEV_MODEL, JEV_USD_PER_INPUT_TOKEN } from "./jev";
import { gatewayCostUsd } from "./judged";
import { withRetry } from "./retry";
import type { RankResult, Retriever, ToolDoc } from "./types";

// Jev tool search for catalogs of any size, ported from FastMCP's JevSearchTransform
// (PrefectHQ/fastmcp PR #5170 and #5199, v4.0.6), which generalises TypeSafe's skill-suggestion
// cookbook. Wide passes rank fixed-size chunks on one-line summaries and keep each chunk's top few
// whole, because probabilities from different chunks are not comparable. A close read then asks one
// choice over the survivors' full details, plus one yes/no per survivor: does this tool do the
// specific thing asked? Survivors under the fit threshold are dropped, so an empty answer means
// "no tool fits" - the one thing a lexical index cannot say.

export type JevSearchOptions = {
  chunkSize: number;
  shortlist: number;
  fitThreshold: number;
  summaryChars: number;
  detailChars: number;
  /** Drop survivors whose fit answer is under the threshold. Off, the close read only ranks. */
  gate: boolean;
};

/** FastMCP's defaults. */
export const JEV_SEARCH_DEFAULTS: JevSearchOptions = {
  chunkSize: 150,
  shortlist: 8,
  fitThreshold: 0.3,
  summaryChars: 160,
  detailChars: 1200,
  gate: true,
};

export const WIDE_INSTRUCTIONS =
  "Which of these tools is the right one to call to carry out the user's request in `request`? Each option is a tool name; its description summarizes what the tool does.";
export const RERANK_INSTRUCTIONS =
  "Exactly one of these tools is the right one to call for the user's request in `request`. Which one? Read what each tool actually does and what parameters it takes, not just its name.";
export const fitInstructions = (name: string) =>
  `Does the tool described at \`tools.${name}\` do the specific thing the user's request in \`request\` asks for?`;

/** First paragraph of the description, or the name in words when there is none. */
export function summary(tool: ToolDoc, limit: number): string {
  const first = tool.description.split("\n\n")[0]!.trim();
  return clip(first || tool.name.replace(/_/g, " "), limit);
}

/** Name, description and parameters as the close read sees them. */
export function detail(tool: ToolDoc, limit: number): string {
  const properties = (tool.inputSchema?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
  const parameters = Object.entries(properties).map(
    ([name, spec]) => `- ${name}${spec.type ? ` (${spec.type})` : ""}${spec.description ? `: ${spec.description}` : ""}`
  );
  const text = [`## ${tool.name}`, tool.description, ...(parameters.length ? ["Parameters:", ...parameters] : [])].join("\n");
  return clip(text, limit);
}

export function chunk<ITEM>(items: ITEM[], size: number): ITEM[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );
}

type Spend = { inputTokens: number; costUsd: number; refusedCalls: number };

export function jevSearch({
  id,
  label,
  model = JEV_MODEL,
  options: overrides = {},
  retryDelayMs,
}: {
  id: string;
  label: string;
  model?: Experimental_EvaluationModel;
  options?: Partial<JevSearchOptions>;
  retryDelayMs?: number;
}): Retriever {
  const options = { ...JEV_SEARCH_DEFAULTS, ...overrides };
  const maxCandidates = Math.min(3 * options.shortlist, JEV_MAX_OPTIONS);

  type Ask = Parameters<typeof evaluate>[0];
  const ask = async (spend: Spend, state: Ask["state"], questions: Ask["questions"]) => {
    const result = await withRetry(() => evaluate({ model, maxRetries: 0, state, questions }), {
      delayMs: retryDelayMs,
      onFailure: () => void spend.refusedCalls++,
    });
    const inputTokens = result.usage.inputTokens ?? 0;
    spend.inputTokens += inputTokens;
    spend.costUsd += gatewayCostUsd(result.providerMetadata) ?? inputTokens * JEV_USD_PER_INPUT_TOKEN;
    return result.answers;
  };

  const rankChunk = async (spend: Spend, request: string, tools: ToolDoc[]) => {
    const answers = await ask(spend, { request }, {
      which: {
        type: "choice",
        instructions: WIDE_INSTRUCTIONS,
        criteria: Object.fromEntries(tools.map((tool) => [tool.name, summary(tool, options.summaryChars)])),
      },
    });
    const which = answers.which as { probabilities?: Record<string, number>; choice: string };
    const probabilities = which.probabilities ?? { [which.choice]: 1 };
    return [...tools]
      .sort((a, b) => (probabilities[b.name] ?? 0) - (probabilities[a.name] ?? 0))
      .slice(0, options.shortlist);
  };

  return {
    id,
    label,
    rank: async (query, catalog): Promise<RankResult> => {
      const spend: Spend = { inputTokens: 0, costUsd: 0, refusedCalls: 0 };
      let names = catalog;
      // Every full chunk shrinks from chunkSize to shortlist, so each round at least halves the set.
      while (names.length > maxCandidates) {
        const ranked = await Promise.all(
          chunk(names, options.chunkSize).map((part) => rankChunk(spend, query.request, part))
        );
        names = ranked.flat();
      }
      const fits = names.map((_, index) => `fit_${index}`);
      const answers = await ask(
        spend,
        {
          request: query.request,
          tools: Object.fromEntries(names.map((tool) => [tool.name, summary(tool, options.summaryChars)])),
        },
        {
          which: {
            type: "choice",
            instructions: RERANK_INSTRUCTIONS,
            criteria: Object.fromEntries(names.map((tool) => [tool.name, detail(tool, options.detailChars)])),
          },
          ...Object.fromEntries(
            names.map((tool, index) => [fits[index], { type: "boolean", instructions: fitInstructions(tool.name) }])
          ),
        }
      );
      const which = answers.which as { probabilities?: Record<string, number>; choice: string };
      const probabilities = which.probabilities ?? { [which.choice]: 1 };
      const fitting = names.filter(
        (_, index) =>
          !options.gate || (answers[fits[index]!] as { probability: number }).probability >= options.fitThreshold
      );
      return {
        ranking: fitting
          .map(({ name }) => name)
          .sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0)),
        ...spend,
      };
    },
  };
}
