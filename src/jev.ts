import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { gatewayCostUsd, type Judge } from "./judged";
import { withRetry } from "./retry";

// Jev (`typesafe-ai/jev`) as a tool judge: one `choice` question whose options are the candidate
// tools, answered with a probability per tool. Jev rounds to two decimals, so most of a long tail
// ties at 0 and keeps the lexical order.

export const JEV_MODEL = "typesafe-ai/jev";
/** The most options one Jev choice question accepts (docs.typesafe.ai/api.md). */
export const JEV_MAX_OPTIONS = 255;
/** $0.042 per million input tokens, output free (ai-gateway.vercel.sh/v1/models, 2026-09-25). */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const TOOL_CHOICE_INSTRUCTIONS =
  "An AI assistant received the user request in the state. Which tool should it call first to handle it?";

/** Tools by probability, best first; ties keep their order in `tieBreak`, then name order. */
export function rankByProbability(probabilities: Record<string, number>, tieBreak: string[]) {
  const position = (name: string) => {
    const index = tieBreak.indexOf(name);
    return index === -1 ? tieBreak.length : index;
  };
  return Object.keys(probabilities).sort(
    (a, b) =>
      probabilities[b]! - probabilities[a]! || position(a) - position(b) || a.localeCompare(b)
  );
}

/** Long MCP descriptions are clipped so a 200-option question stays inside Jev's 32k-token budget. */
export const JUDGE_DESCRIPTION_CHARS = 400;

export const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

export function jevJudge(
  model: Experimental_EvaluationModel = JEV_MODEL,
  { retryDelayMs }: { retryDelayMs?: number } = {}
): Judge {
  return {
    maxCandidates: JEV_MAX_OPTIONS,
    rank: async (request, candidates, tieBreak) => {
      let refusedCalls = 0;
      const { answers, usage, providerMetadata } = await withRetry(
        () =>
          evaluate({
            model,
            maxRetries: 0,
            state: `User request: ${request}`,
            questions: {
              tool: {
                type: "choice",
                instructions: TOOL_CHOICE_INSTRUCTIONS,
                criteria: Object.fromEntries(
                  candidates.map((tool) => [tool.name, clip(tool.description, JUDGE_DESCRIPTION_CHARS)])
                ),
              },
            },
          }),
        { delayMs: retryDelayMs, onFailure: () => void refusedCalls++ }
      );
      const inputTokens = usage.inputTokens ?? 0;
      return {
        ranking: rankByProbability(
          answers.tool.probabilities ?? { [answers.tool.choice]: 1 },
          tieBreak
        ),
        inputTokens,
        costUsd: gatewayCostUsd(providerMetadata) ?? inputTokens * JEV_USD_PER_INPUT_TOKEN,
        ...(refusedCalls ? { refusedCalls } : {}),
      };
    },
  };
}
