import { cosineSimilarity, embed, embedMany, type EmbeddingModel } from "ai";
import { gatewayCostUsd } from "./judged";
import { queryText, type QueryInput, type Retriever, type ToolDoc } from "./types";

// Dense retrieval, the usual next step after BM25 and the one Anthropic's own cookbook uses for a
// custom tool search: embed every tool once, embed the query, rank by cosine similarity.

export const EMBEDDING_MODEL = "voyage/voyage-4";

export const toolText = (tool: ToolDoc) => `${tool.name}: ${tool.description}`;

export function embeddingRetriever({
  id,
  label,
  input,
  model = EMBEDDING_MODEL,
}: {
  id: string;
  label: string;
  input: QueryInput;
  model?: EmbeddingModel;
}): Retriever {
  // The catalog is embedded once per catalog object and reused for every query; that one-off cost
  // is not charged to any query, as it would not be in production.
  const indexes = new WeakMap<ToolDoc[], Promise<number[][]>>();
  const indexFor = (catalog: ToolDoc[]) => {
    let index = indexes.get(catalog);
    if (!index) {
      index = embedMany({ model, values: catalog.map(toolText), maxRetries: 2 }).then(({ embeddings }) => embeddings);
      indexes.set(catalog, index);
    }
    return index;
  };

  return {
    id: `${id}@${input}`,
    label,
    prepare: indexFor,
    rank: async (query, catalog) => {
      const [vectors, { embedding, usage, providerMetadata }] = await Promise.all([
        indexFor(catalog),
        embed({ model, value: queryText(query, input), maxRetries: 0 }),
      ]);
      const ranking = catalog
        .map((tool, index) => ({ name: tool.name, score: cosineSimilarity(embedding, vectors[index]!) }))
        .sort((a, b) => b.score - a.score)
        .map(({ name }) => name);
      return { ranking, inputTokens: usage.tokens, costUsd: gatewayCostUsd(providerMetadata) ?? 0 };
    },
  };
}
