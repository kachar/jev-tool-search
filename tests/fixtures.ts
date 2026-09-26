import type { BenchQuery, Retriever, ToolDoc } from "../src/types";

export const catalog: ToolDoc[] = [
  { name: "send_email", description: "Send an email message to one or more recipients." },
  { name: "createCalendarEvent", description: "Create a new event on the user's calendar." },
  { name: "search_web", description: "Search the public web and return result snippets." },
  { name: "get_weather", description: "Get the current weather forecast for a location." },
];

export const query = (overrides: Partial<BenchQuery> = {}): BenchQuery => ({
  id: "single-001",
  request: "Book a meeting with Anna on my calendar next Tuesday",
  keywords: "calendar event",
  relevant: ["createCalendarEvent"],
  ...overrides,
});

/** A retriever that always returns `ranking`, for testing what wraps it. */
export const fixedRetriever = (ranking: string[], id = "fixed"): Retriever => ({
  id,
  label: id,
  rank: async () => ({ ranking, inputTokens: 1, costUsd: 0.5 }),
});
