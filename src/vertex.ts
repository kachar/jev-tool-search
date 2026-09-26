import type { MessagesClient, MessagesResponse } from "./claude-agent";

// Claude on Google Vertex AI, the one route where Anthropic's server-side tool search ran for us:
// AI Gateway's Anthropic-compatible endpoint accepted the tool-search tool and silently ignored it
// on every provider route we pinned (2026-09-25).

export const VERTEX_VERSION = "vertex-2023-10-16";

type VertexOptions = {
  project: string;
  region: string;
  model: string;
  /** An OAuth access token, e.g. `gcloud auth print-access-token`. */
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
};

export function vertexClient({
  project,
  region,
  model,
  getToken,
  fetch: fetchImpl = fetch,
}: VertexOptions): MessagesClient {
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model}:rawPredict`;
  return async (request) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await getToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ anthropic_version: VERTEX_VERSION, ...request }),
    });
    if (!response.ok) {
      throw new Error(`Vertex ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return (await response.json()) as MessagesResponse;
  };
}
