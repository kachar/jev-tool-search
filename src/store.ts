import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QueryResult } from "./types";

// Where per-query results live between runs, so an interrupted run resumes instead of re-paying for
// model calls. The package ships a JSONL file store; the blog wires a Postgres one behind the same
// interface.

export type ResultStore = {
  load: (runId: string) => Promise<QueryResult[]>;
  save: (runId: string, result: QueryResult) => Promise<void>;
};

export function fileStore(directory: string): ResultStore {
  const path = (runId: string) => `${directory}/${runId}.jsonl`;
  return {
    load: async (runId) => {
      const text = await readFile(path(runId), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as QueryResult);
    },
    save: async (runId, result) => {
      await mkdir(dirname(path(runId)), { recursive: true });
      await appendFile(path(runId), `${JSON.stringify(result)}\n`);
    },
  };
}
