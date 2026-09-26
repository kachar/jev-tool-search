# Integration surface for a Jev search library: AI SDK 7, AI Gateway, MCP

Research date: 2026-09-25. Versions read: `ai@7.0.114`, `@ai-sdk/gateway@4.0.92`, `@ai-sdk/provider@4.0.18`, `@ai-sdk/provider-utils@5.0.47`, `@orama/orama@3.1.18` (all installed under `node_modules/.pnpm/` in this worktree), `@ai-sdk/typesafe-ai@3.0.6` (npm tarball), `@modelcontextprotocol/server@2.1.0` / `@modelcontextprotocol/sdk@1.30.1` (GitHub + npm). This note builds on `research/tool-search/03-jev-model-and-evaluate-api.md` and `04-tool-search-landscape.md` and does not repeat their Jev pricing, limits or benchmark numbers.

Local package paths are abbreviated as:
- `AI` = `node_modules/.pnpm/ai@7.0.114_zod@4.4.3/node_modules/ai`
- `GW` = `node_modules/.pnpm/@ai-sdk+gateway@4.0.92_zod@4.4.3/node_modules/@ai-sdk/gateway`
- `OR` = `node_modules/.pnpm/@orama+orama@3.1.18/node_modules/@orama/orama/dist/esm`

The adapter signatures in the "Implications" section were compiled with `tsc --noEmit` against these installed types (exit 0) and smoke-tested at runtime with `Experimental_EvaluationMockModelV4` and `MockLanguageModelV4` from `ai/test`. The scratch files were deleted afterwards; copies are in the session scratchpad.

## TL;DR

- **`toolSearch()` cannot take a custom search function.** The factory takes no arguments. Its `execute` throws until the generation replaces it with a hardcoded word-overlap scorer (name match +2, description match +1, top 5) inside a private closure (`AI/src/tool-search/prepare-tool-search.ts` lines 93–127). The "discovered" set is private too, and `isToolSearch` is not exported.
- **`deferLoading: true` only works with the built-in `toolSearch()`.** Any tool with `deferLoading` is filtered out of every step until the built-in search discovers it (line 72). A custom search tool therefore cannot un-defer tools. We confirmed this at runtime: with `deferLoading` set and a custom search, the model saw only `["search"]` on all three steps.
- **The supported way to plug in Jev is `prepareStep` returning `activeTools`**, with the catalog tools *not* marked `deferLoading`. A Jev search tool returns names, and `prepareStep` reads them from `steps[].toolResults` and activates them on the next step. At runtime the model saw `["search"]`, then `["weather","stocks","search"]`. This changes the provider tool list per step, so it has the same cache cost the SDK docs call out for direct calling.
- **Anthropic server-side deferral is a second path.** Set `providerOptions.anthropic.deferLoading` per tool and have a custom tool return `{ type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName } } }` parts from `toModelOutput`. The types allow it (compiled). Whether AI Gateway forwards `tool_reference` and `defer_loading` to Anthropic is UNVERIFIED: the Gateway docs don't mention it, and Claude Code's docs say "most proxies don't forward `tool_reference` blocks".
- **`experimental_evaluate` retries 429s by default.** `maxRetries` defaults to 2, the backoff starts at 2000 ms with factor 2, and a Gateway 429 has `isRetryable = true`. A refused call therefore waits about 6 s (2 s + 4 s) before throwing `RetryError`, unless a `retry-after` header of 0–60 s overrides the delay. A search library should default to `maxRetries: 0` and fall back to lexical search itself. The benchmark's `jev.ts` already does this.
- **Gateway:** `gateway.evaluationModel(id)` and `gateway.evaluation(id)` exist, and `GatewayEvaluationModelId = 'typesafe-ai/jev' | (string & {})`. `providerOptions` are forwarded verbatim in the request body. Vercel documents that `/v1/evaluate` accepts the same `providerOptions` as other endpoints, with `gateway: { zeroDataRetention: true, only: ["typesafe-ai"] }` as the example, so provider pinning for evaluation is documented. `order` and `caching: 'auto'` exist in `GatewayProviderOptions`, but nothing documents them for evaluation (UNVERIFIED).
- **Doc inconsistency.** The installed reference page `14-evaluate.mdx` still says "Evaluation never implicitly falls back to Gateway". That line comes from the 7.0.104 changelog. 7.0.105 changed the behavior, and the code in `resolve-model.ts` does fall back to `gateway`. The guide and the code agree that string IDs go through Gateway.
- **Model id mismatch.** The AI SDK guide uses `'typesafe-ai/jev-latest'`, but the live Gateway catalog lists only `typesafe-ai/jev` as an evaluation model. Whether Gateway resolves `-latest` is UNVERIFIED. `@ai-sdk/typesafe-ai@3.0.6` (direct, `TYPESAFE_AI_API_KEY`) types its id as `'jev-latest' | (string & {})`.
- **Orama `afterSearch` works as a reranker, with two traps.** (1) Orama awaits a hook only if `hook.constructor.name === 'AsyncFunction'` (`OR/utils.js` line 297). A plain function that returns a promise is **not** awaited, and `search()` returns the unreranked BM25 order. We confirmed this at runtime. (2) The hook runs after `limit`/`offset` pagination, so it can only reorder the page it receives. To rerank the top 30 you search with `limit: 30`, and the plugin truncates.
- **MCP:** the TS SDK has no FastMCP-style "transform" hook. `McpServer.registerTool()` returns a handle with `enable()`/`disable()`/`update()` that emits `notifications/tools/list_changed`, and the low-level `Server.setRequestHandler('tools/list', …)` can be overridden. The pattern that works on every client is the one FastMCP uses: expose `search_tools` plus a `call_tool` proxy and keep the tool list fixed. The AI SDK MCP client parses the `tools.listChanged` capability but does not handle the notification: its client class is documented as not supporting "Accepting notifications", and any server-initiated notification is passed to `onError` as "Unsupported message type" (`packages/mcp/src/tool/mcp-client.ts` lines 402 and 464–473 on `main`; same string at `dist/index.js` line 2689 in `@ai-sdk/mcp@2.0.58`).

## Detailed findings

### 1. `experimental_evaluate`: exact types (ai 7.0.114)

Export surface (`AI/src/evaluate/index.ts`): `experimental_evaluate`, and the types `Experimental_EvaluationModel`, `Experimental_EvaluationQuestion`, `Experimental_EvaluationAnswer`, `Experimental_EvaluationResult`, `Experimental_EvaluateStartEvent`, `Experimental_EvaluateEndEvent`, `Experimental_EvaluationModelCallStartEvent`, `Experimental_EvaluationModelCallEndEvent`.

Signature (`AI/src/evaluate/evaluate.ts` lines 36–74):

```ts
function evaluate<
  const QUESTIONS extends Record<string, EvaluationQuestion>,
  RUNTIME_CONTEXT extends Context = Context,
>(args: {
  model: EvaluationModel;                         // string | Experimental_EvaluationModelV4
  state: EvaluationModelV4CallOptions['state'];   // string | Readonly<JSONObject> | readonly JSONValue[]
  questions: QUESTIONS;
  maxRetries?: number;                            // default 2, transient failures only
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  providerOptions?: ProviderOptions;
  telemetry?: TelemetryOptions<RUNTIME_CONTEXT>;
  runtimeContext?: RUNTIME_CONTEXT;
  onStart?: Callback<EvaluateStartEvent<RUNTIME_CONTEXT>>;
  onEnd?: Callback<EvaluateEndEvent<RUNTIME_CONTEXT>>;
}): Promise<EvaluationResult<QUESTIONS>>;
```

The `const QUESTIONS` generic gives literal inference: `answers.pick.choice` is typed as the union of the `criteria` keys. For a search library the keys are dynamic (`Object.fromEntries(...)`), so the choice type widens to `string`.

Question type (`@ai-sdk/provider` `dist/index.d.ts` lines 2262–2281):

```ts
type EvaluationModelV4Input = string | Readonly<JSONObject> | readonly JSONValue[];
type EvaluationModelV4Question =
  | { type: 'choice';  instructions: EvaluationModelV4Input; criteria: Readonly<Record<string, EvaluationModelV4Input | null>> }
  | { type: 'score';   instructions: EvaluationModelV4Input; criteria: readonly (EvaluationModelV4Input | null)[] }
  | { type: 'boolean'; instructions: EvaluationModelV4Input; criteria?: { true?: EvaluationModelV4Input | null; false?: EvaluationModelV4Input | null } };
```

Answer and result (`AI/src/evaluate/evaluation-result.ts`):

```ts
type EvaluationAnswer<Q> =
  Q extends { type: 'choice'; criteria: infer C } ? { type: 'choice'; choice: Extract<keyof C, string>; probabilities?: Record<Extract<keyof C, string>, number> }
  : Q extends { type: 'score' } ? { type: 'score'; score: number; probabilities?: Record<string, number> }
  : { type: 'boolean'; probability: number };

type EvaluationResult<QS> = {
  readonly answers: { [ID in keyof QS]: EvaluationAnswer<QS[ID]> };
  readonly usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined };
  readonly warnings: SharedV4Warning[];
  readonly rounding: { probabilityDecimals?: number; scoreDecimals?: number } | undefined;
  readonly providerMetadata: SharedV4ProviderMetadata | undefined;   // Record<string, JSONObject>
  readonly response: { id?: string; headers?: ...; body?: unknown } & { timestamp: Date; modelId: string };
};
```

- `probabilities` is optional in the type even for Jev, so a library needs a fallback such as `{ [choice]: 1 }`.
- `providerMetadata.typesafe.confidence` is **not typed**. `SharedV4ProviderMetadata` is `Record<string, JSONObject>`, so you narrow it yourself: `(result.providerMetadata?.typesafe as { confidence?: Record<string, number> })?.confidence?.[questionId]`. The guide documents the path and says it "is not the selected option's probability or a portable confidence measure" (`AI/docs/03-ai-sdk-core/32-evaluation.mdx`, "Probabilities and confidence").
- The Gateway response schema accepts `providerMetadata` as `record(string, record(string, unknown))` and passes it through (`GW/src/gateway-evaluation-model.ts` lines 168–170 and 84–85).

Model contract (`@ai-sdk/provider` lines 2340–2347):

```ts
type EvaluationModelV4 = {
  readonly specificationVersion: 'v4';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedQuestionTypes: readonly ('choice' | 'score' | 'boolean')[];
  doEvaluate(options: { state; questions; abortSignal?; headers?; providerOptions? }): PromiseLike<EvaluationModelV4Result>;
};
```

Errors and retries:
- `Experimental_EvaluationUnsupportedQuestionTypeError` (fields `questionId`, `questionType`, `provider`, `modelId`) is thrown before any I/O (`evaluate.ts` lines 79–88).
- `validateEvaluationAnswers` runs after the retry loop, so an `InvalidResponseDataError` is never retried (`evaluate.ts` lines 138–154).
- Retry policy (`AI/src/util/retry-with-exponential-backoff.ts`):
  - defaults: `maxRetries = 2`, `initialDelayInMs = 2000`, `backoffFactor = 2`
  - it retries only `APICallError` or `GatewayError` with `isRetryable === true`
  - it honors `retry-after-ms` and `retry-after` headers when they fall in 0–60 s
- `GatewayError` sets `isRetryable` for status 408, 409, 429 and ≥500 (`GW/src/errors/gateway-error.ts` lines 19–23).
- Consequence: a "provider at capacity" 429 costs about 6 s of backoff before the error surfaces, unless you pass `maxRetries: 0`.

Model resolution (`AI/src/model/resolve-model.ts` lines 220–257): a string ID resolves through `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway` and must expose `evaluationModel`. Otherwise it throws `NoSuchModelError` with `modelType: 'evaluationModel'`. A model whose `specificationVersion !== 'v4'` throws `UnsupportedModelVersionError`. Version history (`AI/CHANGELOG.md`):
- 7.0.103 added `experimental_evaluate`.
- 7.0.104 added `toolSearch` ("feat(ai): add native tool search tool") and registry resolution. That entry is where "Evaluation never implicitly falls back to Gateway" comes from.
- 7.0.105 added "Resolve evaluation model IDs through AI Gateway when no default provider is configured".
- 7.0.111 added telemetry for `experimental_evaluate`.

The reference page `AI/docs/07-reference/01-ai-sdk-core/14-evaluate.mdx` still carries the 7.0.104 sentence.

### 2. The mock model in `ai/test`

`Experimental_EvaluationMockModelV4` (`AI/dist/test/index.d.ts` line 59; source `AI/src/test/evaluation-mock-model-v4.ts`):

```ts
new Experimental_EvaluationMockModelV4({
  provider?: string;                 // 'mock-provider'
  modelId?: string;                  // 'mock-model-id'
  supportedQuestionTypes?: readonly ('choice'|'score'|'boolean')[];  // all three
  doEvaluate?: EvaluationModelV4['doEvaluate'];  // default throws notImplemented
});
```

It returns exactly what `doEvaluate` returns, and core validation still applies. In our smoke test, a mock that returned all-zero probabilities threw `AI_InvalidResponseDataError`, because distributions must sum to 1 within the tolerance plus rounding slack. A library's tests should therefore generate valid distributions. The mock can also return `providerMetadata: { typesafe: { confidence: {...} } }` to exercise confidence handling. It does not simulate 429s. To test the fallback path, throw `new GatewayRateLimitError(...)` from `@ai-sdk/gateway` inside `doEvaluate`; the export is listed in `GW/dist/index.d.ts` line 1379.

### 3. `toolSearch()`, deferred tools, `activeTools`, `prepareStep`

**Invocation** (`AI/docs/03-ai-sdk-core/19-tool-search.mdx`, `AI/docs/07-reference/01-ai-sdk-core/23-tool-search.mdx`):
- `tools: { search: toolSearch(), weather: tool({ deferLoading: true, ... }) }` with a multi-step `stopWhen`.
- Model input: `{ query: string }` with `minLength: 1`.
- Output: `{ tools: Array<{ name: string; description?: string }> }` with at most 5 entries and no schemas.
- Matches become callable on the **next** step. A parallel call in the same response cannot use them.
- It works with `generateText`, `streamText`, `ToolLoopAgent`, and `WorkflowAgent`.
- Code mode (`@ai-sdk/code-mode`, `toolDiscovery: 'conversation'`) announces discoveries in a user message instead of changing the tool list, and the docs say this "preserves the tool-definition cache".

**Implementation facts relevant to plugging in Jev:**
- `toolSearch()` returns `tool({... execute: () => { throw new Error('toolSearch must be bound by an AI SDK generation.') } })`, tagged with `Symbol.for('vercel.ai.toolSearch')` (`tool-search.ts` lines 3, 47–51). There is no options parameter.
- `createToolSearchState` runs once per generation. It filters every step's tools with `!tool.deferLoading || discovered.has(name)` and swaps in a synchronous `execute` that runs the fixed scorer (`prepare-tool-search.ts` lines 62–133). The tokenizer splits camelCase and lowercases, then matches `[\p{L}\p{N}]+` (lines 136–143). The `discovered` set lives in the closure.
- Because the symbol is global (`Symbol.for`), a third-party tool could tag itself to be treated as a search tool. The SDK would then overwrite its `execute` with the built-in scorer, so this does not help.
- The search tool itself must not set `deferLoading`, otherwise the SDK throws `InvalidArgumentError` (line 52).

**What a custom search can use instead:**
- `activeTools?: ReadonlyArray<keyof TOOLS & string>`, where `undefined` means no restriction (`AI/src/generate-text/active-tools.ts`).
- `prepareStep` receives `{ steps, stepNumber, model, instructions, messages, responseMessages, toolsContext, runtimeContext, ... }` and may return `activeTools`, `toolChoice`, `model`, `instructions`, `messages`, `providerOptions`, `toolOrder`, and more (`AI/src/generate-text/prepare-step.ts`). In `generateText` the order is `filterActiveTools(prepareStepResult.activeTools ?? activeTools)` → `prepareToolSearch(...)` → provider (`AI/src/generate-text/generate-text.ts` lines 891–935).
- `steps[i].toolResults: Array<TypedToolResult<TOOLS>>` carries `toolName` and `output` (`AI/src/generate-text/step-result.ts` line 225). That is enough to rebuild the discovered set statelessly on each step, and it also isolates state per generation.
- `dynamicTool()` is exported from `ai` (re-exported from provider-utils `dist/index.d.ts` line 2196). It is useful when catalog entries come from MCP or JSON schemas with unknown types. It doesn't change the discovery mechanics.

**Runtime check (scripted `MockLanguageModelV4`: step 0 calls `search`, step 1 calls `weather`):**

| Setup | Tool names the provider received on steps 0 / 1 / 2 |
|---|---|
| Jev search tool + `prepareStep` → `activeTools`, catalog **not** deferred | `["search"]` / `["weather","stocks","search"]` / same |
| Same, but catalog tools `deferLoading: true` | `["search"]` / `["search"]` / `["search"]` (never exposed) |
| Built-in `toolSearch()`, deferred catalog, query `"rain"` | `["search"]` / `["search"]` / `["search"]` (no word overlap with "Get the weather forecast") |

The first row shows `stocks` because the scratch adapter activated every returned name, including those at probability 0. A real adapter should apply a probability floor; the FastMCP Jev transform uses `fit_threshold` 0.3. The third row is the vocabulary-mismatch failure, reproduced in the SDK's own search.

**Anthropic `tool_reference` path** (https://github.com/vercel/ai/blob/main/content/providers/01-ai-sdk-providers/05-anthropic.mdx, "Custom Tool Search"):
- Deferred tools carry `providerOptions: { anthropic: { deferLoading: true } }`. This is an Anthropic API flag, separate from the SDK-level `tool.deferLoading`.
- A custom tool's `toModelOutput` returns `{ type: 'content', value: [{ type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName } } }] }`, which "sends `tool_reference` blocks to Anthropic".
- `ToolResultOutput`'s content union includes `{ type: 'custom'; providerOptions?: ProviderOptions }` (provider-utils `dist/index.d.ts` lines 610–619), so this compiles against the installed `ai` without `@ai-sdk/anthropic` installed.
- This path needs one step, not two, and keeps Anthropic's prompt cache (see note 04 §1).
- The Gateway language model posts the full call options, including tool `providerOptions` and prompt parts, as `body: args` (`GW/src/gateway-language-model.ts` line 92). Whether the Gateway server maps `anthropic.deferLoading` and `tool-reference` parts to Anthropic's API is not documented. A Vercel docs search for "tool search deferLoading tool_reference" returned only generic tool-calling pages, and a grep of https://vercel.com/docs/llms-full.txt (9.6 MB, fetched 2026-09-25) for `tool_reference`, `tool-reference`, `defer_loading` and `deferLoading` found no matches. UNVERIFIED; test it empirically.

### 4. `@ai-sdk/gateway` 4.0.92: evaluation factory, routing, caching

- Factory: `gateway.evaluationModel(modelId: GatewayEvaluationModelId): Experimental_EvaluationModelV4` and an alias `gateway.evaluation(...)` (`GW/dist/index.d.ts` lines 982–986). `GatewayEvaluationModelId = 'typesafe-ai/jev' | (string & {})` (line 7).
- Wire format (`GW/src/gateway-evaluation-model.ts`):
  - `POST ${baseURL}/evaluation-model`, where `baseURL` defaults to `https://ai-gateway.vercel.sh/v4/ai` (`GW/src/gateway-provider.ts` line 317)
  - headers `ai-evaluation-model-specification-version: 4` and `ai-model-id: <id>`
  - body `{ state, questions, providerOptions? }`, where `providerOptions` is the whole object, so `{ gateway: {...} }` reaches the server
  - `supportedQuestionTypes = ['choice','score','boolean']`
- `GatewayProviderOptions` (`GW/dist/index.d.ts` lines 1110–1161) includes:
  - routing: `order?: string[]`, `only?: string[]`, `models?: string[]` (fallback models), `sort?: 'cost'|'tps'|'ttft'`
  - caching and quotas: `caching?: 'auto'`, `quotaEntityId`, `serviceTier?: 'flex'|'priority'`
  - data handling: `zeroDataRetention?: boolean`, `disallowPromptTraining`
  - attribution and credentials: `tags`, `user`, `byok`
  - it also has an open index signature (`[key: string]: unknown`), with the comment "Service-owned options may be added by the Gateway without requiring an SDK release".
- For evaluation specifically, Vercel's evaluation page (last_updated 2026-09-22) says: "`/v1/evaluate` accepts the same `providerOptions` as other AI Gateway endpoints, so you can require zero data retention or restrict which providers may serve the request", with the example `"gateway": { "zeroDataRetention": true, "only": ["typesafe-ai"] }` (https://vercel.com/docs/ai-gateway/modalities/evaluation). The response example carries `providerMetadata.gateway.routing.{resolvedProvider, finalProvider}` and `cost`/`marketCost`. Note 03 records two listed providers (`typesafe-ai`, `digitalocean`). Pinning with `only`/`order` is how a library would test whether 429s depend on the provider. One wrinkle: on 2026-09-25 `GET https://ai-gateway.vercel.sh/v1/models/typesafe-ai/jev/endpoints` listed a single endpoint with `provider_name: "digitalocean"`, `has_zdr: false` and `supports_implicit_caching: false`, while the doc's response example reports `resolvedProvider: "typesafe-ai"`. How `only: ["typesafe-ai"]` and `zeroDataRetention: true` interact with that endpoint listing is UNVERIFIED. Whether `order` and fallback across those two providers actually happens for evaluation is UNVERIFIED.
- Caching: `caching: 'auto'` is typed as "Enables automatic caching behavior when supported by the Gateway". Nothing documents it for evaluation, and the Jev catalog entry has no cached-input price (note 03 §1). The endpoint listing reports `supports_implicit_caching: false` (https://ai-gateway.vercel.sh/v1/models/typesafe-ai/jev/endpoints, 2026-09-25). Treat it as having no effect for Jev (UNVERIFIED). Any caching of repeated queries has to happen in the library.
- `@ai-sdk/typesafe-ai@3.0.6` (published 2026-09-23T21:45:28Z per `npm view @ai-sdk/typesafe-ai time`) exports `typeSafeAi` and `createTypeSafeAi({ apiKey?, baseURL?, headers?, fetch? })`. `evaluationModel(id: 'jev-latest' | (string & {}))` reads `TYPESAFE_AI_API_KEY` and calls `https://api.typesafe.ai/v1/systemone` (default `baseURL` `https://api.typesafe.ai/v1`, npm tarball `dist/index.d.ts` and `dist/index.js`). It is the non-Gateway path. It has no Gateway routing, so the 429 behaviour may differ (UNVERIFIED).

### 5. Orama plugin surface (3.1.18)

- `OramaPluginSync` has `name`, `extra?`, and hooks, including `afterSearch?: (orama, params: SearchParams<T>, language, results: Results<TypedDocument<T>>) => SyncOrAsyncValue` (`OR/types.d.ts` lines 993–1016). The return value is ignored (`OR/components/hooks.js` lines 42–55). The hook receives the same `results` object that `search()` returns (`OR/methods/search-fulltext.js` lines 175–183), so a reranker works by **mutating** `results.hits`.
- `Result<D> = { id: string; score: number; document: D }`. `Results<D>` has `count`, `hits`, `elapsed`, `facets?` and `groups?` (`OR/types.d.ts` lines 576–660). `id` is Orama's document id, auto-generated if the doc has no `id` field, so a reranker should key Jev options by `hit.id`.
- **Async trap:** `isAsyncFunction(f) = f?.constructor?.name === 'AsyncFunction'` (`OR/utils.js` lines 293–298). Only then does `runAfterSearch` await the hook. Our runtime check:
  - declared `async` hook: `[['b', 1], ['a', 0]]`, reranked
  - a non-async wrapper returning the same promise: `[['a', 0.259], ['b', 0.146]]`, BM25 order, because the rerank landed after `search()` returned
  - the unawaited hook still runs later and mutates the same `results` object after the caller has it. A re-run on 2026-09-25 printed `['a','b']` right after `await search()` and `['b','a']` 20 ms later, so the trap is a race, not just a no-op
  - consequence: a library must ship the hook as a native `async` function and must not be transpiled below ES2017.
- **Pagination trap:** `fetchDocuments(orama, uniqueDocsArray, offset, limit)` runs before `afterSearch`, so the hook only sees `limit` hits (`search-fulltext.js` lines 145–150). A reranker plugin can reorder and truncate but cannot widen the candidate pool, so the caller passes `limit` equal to the pool size (e.g. 20–30).
- Once any `beforeSearch`/`afterSearch` hook exists, `search()` returns a Promise (`search-fulltext.js` lines 185–188). Its declared type is already `Results | Promise<Results>` (`OR/methods/search.d.ts`).
- `params.term` is the query string. For vector-only searches it may be empty, and the plugin should then do nothing.

### 6. MCP hosting

- **FastMCP (Python) analogue:**
  - `BaseSearchTransform(CatalogTransform)` replaces `list_tools()` output with a synthetic `search_tools` tool and a `call_tool` proxy. Subclasses implement `_make_search_tool()` and `async _search(tools, query)` (https://github.com/PrefectHQ/fastmcp/blob/main/fastmcp_slim/fastmcp/server/transforms/search/base.py, lines 1–28, 286–406).
  - `JevSearchTransform` is in https://github.com/PrefectHQ/fastmcp/blob/main/fastmcp_slim/fastmcp/experimental/transforms/jev_search.py. Defaults: `model="jev-latest"`, `timeout=10.0`, `shortlist=8`, `fit_threshold=0.3`, `chunk_size=150` (max 255), `max_results=5`, `close_read=True`. Candidates are capped at `min(3 * shortlist, 255)`. It validates `shortlist * 2 <= chunk_size` when `close_read` is on (lines 129–183).
  - It talks to TypeSafe through a `SystemOneClient` protocol (`async system_one(state, questions)`, line 54), not through Gateway.
- **TypeScript MCP SDK:**
  - The repo now ships split v2 packages (`@modelcontextprotocol/server` 2.1.0, released 2026-09-23 per the GitHub release list); the legacy `@modelcontextprotocol/sdk` is at 1.30.1.
  - In `packages/server/src/server/mcp.ts` (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts), the `tools/list` handler lists `_registeredTools` filtered by `tool.enabled` (lines 229–258), and `tools/call` rejects disabled tools (line 267).
  - `registerTool` returns a handle whose `enable()`, `disable()` and `update()` call `sendToolListChanged()` (lines 935–998).
  - `packages/middleware/*` are only runtime adapters for Express, Fastify, Hono and Node; per their README they "intentionally do not add new MCP features".
  - There is no transform or catalog-hook equivalent. The options are:
    1. **Search plus proxy (FastMCP pattern):** register only `search_tools` and `call_tool({ name, arguments })` on `McpServer`, and keep the real catalog in the library. This works on any client and needs no `list_changed` support.
    2. **Enable/disable:** register everything, `disable()` it, and `enable()` search hits. This depends on the client honoring `notifications/tools/list_changed`. It is also global to that `McpServer` instance, so in a stateful multi-session server it leaks across sessions unless you build one server per session.
    3. **Override the list handler:** use the low-level `Server` and write your own `tools/list` handler.
- **AI SDK as MCP client:** the tool-search guide says "MCP client tools work too: add `deferLoading: true` to the tools returned by `client.tools()`" (`19-tool-search.mdx`). That is the built-in lexical search again. With a Jev adapter you would instead pass `client.tools()` as the `catalog` of adapter (a). `@ai-sdk/mcp` (npm 2.0.58, published 2026-09-24) declares `tools.listChanged` in its capability schema (https://github.com/vercel/ai/blob/main/packages/mcp/src/tool/types.ts lines 133–137), but the client does not accept notifications. The `DefaultMCPClient` doc comment lists "Accepting notifications" under "Not supported", and `transport.onmessage` routes any message with a `method` and no `id` to `onError(new MCPClientError({ message: 'Unsupported message type' }))` (https://github.com/vercel/ai/blob/main/packages/mcp/src/tool/mcp-client.ts lines 398–405, 464–473). The published 2.0.58 `dist/index.js` has the same branch (line 2689). A scan of every non-test `.ts` file under `packages/mcp/src` found no other `list_changed` reference. So a `list_changed` notification reaches an AI SDK client as an error, not a refresh.

## Implications for a Jev search library

All four signatures below compiled with `tsc --noEmit` (TypeScript 5.9.3, `strict`, `noUncheckedIndexedAccess`) against `ai@7.0.114` and `@orama/orama@3.1.18`. Two option fields were added after the compile run and are plain optional properties: `minProbability` in (a) and `onError` in (b).

**Shared core.** One function, with the retry default flipped:

```ts
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from 'ai';

export type JevSearchDoc = { id: string; text: string };
export type JevRanked = { id: string; probability: number };
export type JevCoreOptions = {
  model?: Experimental_EvaluationModel;              // default 'typesafe-ai/jev'
  instructions?: string;
  maxRetries?: number;                               // default 0 (SDK default 2 = ~6 s on a 429)
  providerOptions?: Parameters<typeof evaluate>[0]['providerOptions']; // e.g. { gateway: { only: ['typesafe-ai'] } }
  abortSignal?: AbortSignal;
};
export function jevRank(query: string, docs: readonly JevSearchDoc[], opts?: JevCoreOptions):
  Promise<{ ranked: JevRanked[]; confidence?: number; inputTokens?: number }>;
```

**(a) AI SDK tool search.** `toolSearch()` can't be extended, so the adapter returns the tool set and a `prepareStep`:

```ts
import { type PrepareStepFunction, type Tool, type ToolSet } from 'ai';

type SearchInput = { query: string };
type SearchOutput = { tools: Array<{ name: string; description?: string }> }; // same shape as toolSearch()
export type JevSearchTool = /* ReturnType of the internal tool({...}) factory */ Tool<SearchInput, SearchOutput>;

export function jevToolSearch<TOOLS extends ToolSet>(opts: {
  catalog: TOOLS;                         // must NOT be deferLoading
  alwaysActive?: ReadonlyArray<keyof TOOLS & string>;
  maxResults?: number;                    // default 5, like toolSearch()
  minProbability?: number;                // probability floor; FastMCP uses 0.3
  describe?: (name: keyof TOOLS & string, tool: TOOLS[keyof TOOLS]) => string;
} & JevCoreOptions): {
  tools: TOOLS & { search: JevSearchTool };
  prepareStep: PrepareStepFunction<TOOLS & { search: JevSearchTool }>;
};

// usage
const { tools, prepareStep } = jevToolSearch({ catalog: await mcpClient.tools() });
await generateText({ model, tools, prepareStep, stopWhen: isStepCount(5), prompt });
```

Two implementation notes:
- The `search` tool's type must come from `ReturnType<typeof tool>` of the concrete factory. `tool()` returns `ExecutableTool<Tool<...>>`, which a plain `Tool<SearchInput, SearchOutput>` annotation rejected.
- If the user already has a `prepareStep`, the adapter needs a `compose` helper that merges `activeTools` (union). That is an API design choice, not an SDK feature.

**(a2) Anthropic-native variant.** One step, cache-friendly, needs `providerOptions.anthropic.deferLoading` on the catalog:

```ts
export function jevAnthropicToolSearch(opts: { catalog: readonly JevSearchDoc[]; maxResults?: number } & JevCoreOptions):
  Tool<SearchInput, string[]>;  // toModelOutput → { type: 'content', value: [{ type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName } } }] }
```

**(b) Orama reranker plugin:**

```ts
import type { OramaPluginSync } from '@orama/orama';

export function pluginJevRerank(opts: {
  toText: (doc: Record<string, unknown>) => string;  // what Jev reads per hit
  topK?: number;                                     // truncate after rerank
  minProbability?: number;                           // drop hits Jev rejects
  onError?: 'keep-bm25' | 'throw';                   // 429 → leave BM25 order
} & JevCoreOptions): OramaPluginSync;
// afterSearch MUST be declared `async` (Orama checks constructor.name); it replaces results.hits
// with Jev order and sets hit.score = probability.

// usage: widen the page to the rerank pool
const db = create({ schema, plugins: [pluginJevRerank({ toText: d => `${d.name}: ${d.description}` })] });
const res = await search(db, { term, limit: 20 });  // BM25 top-20 → Jev
```

This is the "BM25 top-20 then Jev" arm, which scored 70.6% in the prior benchmark and made ~0% 429s at 20 options.

**(c) Standalone engine.** It mirrors Orama's `create`/`insert`/`search` and returns an Orama-shaped `Results`:

```ts
export type JevDb<D extends { id: string }> = { docs: Map<string, D>; toText: (d: D) => string; options: JevCoreOptions; chunkSize: number };
export type JevSearchResult<D> = { count: number; hits: Array<{ id: string; score: number; document: D }>; elapsed: { raw: number; formatted: string }; confidence?: number };

export function createJev<D extends { id: string }>(opts: { toText: (d: D) => string; chunkSize?: number /* ≤255 */ } & JevCoreOptions): JevDb<D>;
export function insertJev<D extends { id: string }>(db: JevDb<D>, doc: D): string;
export function searchJev<D extends { id: string }>(db: JevDb<D>, params: {
  term: string; limit?: number; threshold?: number;
  candidates?: readonly string[];   // pre-filter (e.g. from BM25) → hybrid without the plugin
  abortSignal?: AbortSignal;
}): Promise<JevSearchResult<D>>;
```

- Unlike Orama, `search` is always async and costs a network call.
- Catalogs above `chunkSize` need the chunked wide pass plus close read that FastMCP uses; the scratch version truncated.
- `insert` is a map write. There is no index to build, so "insert" mostly exists for API familiarity and for keeping a `toText` projection.

**(d) Bonus: a `RerankingModel` backed by Jev.** With it, `ai`'s own `rerank()` works:

```ts
import type { RerankingModel } from 'ai';
type RerankingModelV4Like = Exclude<RerankingModel, string | { specificationVersion: 'v3' }>;
export function jevRerankingModel(opts?: JevCoreOptions): RerankingModelV4Like; // doRerank({ documents, query, topN }) → { ranking: [{ index, relevanceScore }] }
```

This puts Jev on the same interface as the five Gateway reranking models (note 03 §1), which makes swapping Voyage/Cohere/Jev in one benchmark arm trivial.

**Design consequences:**
1. The library's value over `toolSearch()` is the ranker. The discovery plumbing has to be rebuilt with `prepareStep`, because the SDK keeps it private. It's worth filing an upstream request for `toolSearch({ search: (query, candidates) => Promise<string[]> })`. The SDK's structure makes that a small change: the scorer is a single `.map/.filter/.sort` block, although it is synchronous today.
2. Default to `maxRetries: 0`, plus a lexical fallback (built-in word overlap, or Orama BM25) on `GatewayRateLimitError` or `RetryError`. Combined with the prior 48% 429 rate on 199-option calls, this makes hybrid (b) the safer default than whole-catalog search. Expose `providerOptions.gateway.only`/`order` so users can pin providers.
3. Cache by `(catalogHash, query)` inside the library. There is no documented Gateway caching for evaluation.
4. For MCP, ship the search-plus-`call_tool` proxy as a helper on `McpServer`. Don't rely on `list_changed`.

## Open questions

1. Does AI Gateway forward `providerOptions.anthropic.deferLoading` and `tool-reference` custom parts to Anthropic, so that (a2) works through `anthropic/claude-*` Gateway ids? A one-call test settles it.
2. Does `order: ['digitalocean','typesafe-ai']` (or the reverse) change the 429 rate on 199-option calls? Does Gateway fall back between the two providers on a 429, or return it?
3. Does Gateway send `retry-after` on Jev 429s? If it does, the SDK waits up to 60 s per retry instead of 2 s and 4 s.
4. Does Gateway resolve `typesafe-ai/jev-latest`, which the AI SDK guide uses, when the catalog lists only `typesafe-ai/jev`?
5. Does `caching: 'auto'` do anything for `/v1/evaluate`?
6. (Answered: no. `@ai-sdk/mcp` 2.0.58 treats server notifications as errors; see §6.) Would Vercel accept notification support upstream, or should an MCP-backed catalog simply re-call `client.tools()` per generation?
7. Would Vercel accept a pluggable `search` option in `toolSearch()`? The CHANGELOG shows the feature landed in 7.0.104 and is young.
8. Does `jev-1.13` accuracy on 20-candidate reranks depend on which fields `toText` includes (name only, name + description, + argument names)? FastMCP uses a 160-char summary for the wide pass and full descriptions for the close read.

## Sources

Installed packages (read directly; `ai` 7.0.114 and `@orama/orama` 3.1.18 are pinned in `package.json`; `@ai-sdk/gateway`, `@ai-sdk/provider` and `@ai-sdk/provider-utils` are transitive dependencies of `ai` resolved in the lockfile, not pinned directly):
- `AI/src/tool-search/tool-search.ts`, `AI/src/tool-search/prepare-tool-search.ts`
- `AI/src/generate-text/generate-text.ts`, `prepare-step.ts`, `active-tools.ts`, `step-result.ts`
- `AI/src/evaluate/evaluate.ts`, `evaluation-result.ts`, `index.ts`; `AI/src/test/evaluation-mock-model-v4.ts`; `AI/dist/test/index.d.ts`
- `AI/src/model/resolve-model.ts`; `AI/src/util/prepare-retries.ts`; `AI/src/util/retry-with-exponential-backoff.ts`
- `AI/docs/03-ai-sdk-core/19-tool-search.mdx`, `32-evaluation.mdx`; `AI/docs/07-reference/01-ai-sdk-core/14-evaluate.mdx`, `23-tool-search.mdx`; `AI/CHANGELOG.md`
- `@ai-sdk/provider@4.0.18` `dist/index.d.ts` (evaluation and reranking types); `@ai-sdk/provider-utils@5.0.47` `dist/index.d.ts` (`Tool`, `ToolResultOutput`, `deferLoading`)
- `GW/src/gateway-evaluation-model.ts`, `GW/src/errors/gateway-error.ts`, `GW/src/errors/as-gateway-error.ts`, `GW/src/gateway-provider.ts`, `GW/dist/index.d.ts`, `GW/docs/00-ai-gateway.mdx`, `GW/CHANGELOG.md`
- `OR/types.d.ts`, `OR/methods/search-fulltext.js`, `OR/methods/search.d.ts`, `OR/methods/create.js`, `OR/components/hooks.js`, `OR/components/plugins.js`, `OR/utils.js`

Web and GitHub:
- https://vercel.com/docs/ai-gateway/modalities/evaluation (fetched as `.md`, last_updated 2026-09-22)
- https://ai-gateway.vercel.sh/v1/models (evaluation-type ids, fetched 2026-09-25)
- https://github.com/vercel/ai/blob/main/content/providers/01-ai-sdk-providers/05-anthropic.mdx (Tool Search, Custom Tool Search)
- https://github.com/vercel/ai/blob/main/packages/mcp/src/tool/types.ts
- https://github.com/vercel/ai/blob/main/packages/mcp/src/tool/mcp-client.ts
- https://ai-gateway.vercel.sh/v1/models/typesafe-ai/jev/endpoints (fetched 2026-09-25)
- https://vercel.com/docs/llms-full.txt (grep for `tool_reference`, fetched 2026-09-25)
- https://www.npmjs.com/package/@ai-sdk/typesafe-ai (3.0.6 tarball, published 2026-09-23)
- https://www.npmjs.com/package/@ai-sdk/mcp (2.0.58)
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts
- https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/middleware (README)
- https://github.com/modelcontextprotocol/typescript-sdk/releases (`@modelcontextprotocol/server-legacy@2.1.0`, 2026-09-23); https://www.npmjs.com/package/@modelcontextprotocol/sdk (1.30.1)
- https://github.com/PrefectHQ/fastmcp/blob/main/fastmcp_slim/fastmcp/server/transforms/search/base.py
- https://github.com/PrefectHQ/fastmcp/blob/main/fastmcp_slim/fastmcp/experimental/transforms/jev_search.py
- https://code.claude.com/docs/en/mcp (proxies and `tool_reference`, via note 04)

## Verification log

Adversarial re-check on 2026-09-25. Local paths use the `AI`/`GW`/`OR` abbreviations above; every local file was re-read at the cited lines.

| # | Claim | Verdict | Source checked |
|---|---|---|---|
| 1 | `toolSearch()` takes no arguments; the built-in scorer is name +2 / description +1, score > 0, top 5, in a closure (lines 93–127); `isToolSearch` is not exported | CONFIRMED | `AI/src/tool-search/tool-search.ts` lines 15–58; `prepare-tool-search.ts` lines 93–127; `AI/src/index.ts` line 58 exports only `toolSearch`; `isToolSearch` absent from `AI/dist/index.d.ts` |
| 2 | Deferred tools are filtered by `!tool.deferLoading \|\| discovered.has(name)` (line 72); the search tool itself may not defer (`InvalidArgumentError`, line 52) | CONFIRMED | `AI/src/tool-search/prepare-tool-search.ts` lines 42–72 |
| 3 | `generateText` applies `filterActiveTools(prepareStepResult.activeTools ?? activeTools)` before `prepareToolSearch` | CONFIRMED | `AI/src/generate-text/generate-text.ts` lines 921–930 |
| 4 | Retry defaults `maxRetries = 2`, `initialDelayInMs = 2000`, `backoffFactor = 2`; only retryable `APICallError`/`GatewayError`; `retry-after(-ms)` honored in 0–60 s; `maxRetries: 0` rethrows the raw error | CONFIRMED | `AI/src/util/retry-with-exponential-backoff.ts` lines 10–96; `AI/src/util/prepare-retries.ts`; `provider-utils/src/retry-with-exponential-backoff.ts`; `AI/src/evaluate/evaluate.ts` lines 91–147 |
| 5 | `GatewayError.isRetryable` is true for 408, 409, 429, ≥500 | CONFIRMED | `GW/src/errors/gateway-error.ts` lines 19–23; `GatewayRateLimitError` defaults to 429 |
| 6 | String evaluation IDs fall back to `gateway`; the reference page still says "Evaluation never implicitly falls back to Gateway"; changelog 7.0.103 / 7.0.104 / 7.0.105 / 7.0.111 entries | CONFIRMED | `AI/src/model/resolve-model.ts` lines 220–257; `AI/docs/07-reference/01-ai-sdk-core/14-evaluate.mdx` lines 66–69; `AI/CHANGELOG.md` lines 53–57, 132–165 |
| 7 | `gateway.evaluation`/`evaluationModel`, `GatewayEvaluationModelId = 'typesafe-ai/jev' \| (string & {})`, `POST {baseURL}/evaluation-model` with base `https://ai-gateway.vercel.sh/v4/ai`, headers, `GatewayProviderOptions` fields and the "Service-owned options" comment | CONFIRMED | `GW/dist/index.d.ts` lines 7, 975–987, 1110–1135; `GW/src/gateway-evaluation-model.ts` lines 24, 101–107; `GW/src/gateway-provider.ts` lines 315–317 |
| 8 | Vercel evaluation page (last_updated 2026-09-22) quote on `/v1/evaluate` `providerOptions`, the `zeroDataRetention`/`only` example, `routing.{resolvedProvider, finalProvider}` and `marketCost` in the response | CONFIRMED | https://vercel.com/docs/ai-gateway/modalities/evaluation.md lines 6, 268–303 |
| 9 | The live catalog lists only `typesafe-ai/jev` as an evaluation model | CONFIRMED | https://ai-gateway.vercel.sh/v1/models: one id containing `jev`, type `evaluation`, input `0.000000042`, output `0` |
| 10 | `@ai-sdk/typesafe-ai@3.0.6` was published 2026-09-16 | CORRECTED to 2026-09-23T21:45:28Z; also filled in the base URL `https://api.typesafe.ai/v1` | `npm view @ai-sdk/typesafe-ai time`; tarball `dist/index.js` lines 121–130, 202 |
| 11 | Orama awaits a hook only when `constructor.name === 'AsyncFunction'`; a non-async wrapper is not awaited | CONFIRMED, with an addition: the unawaited hook mutates `results` after `search()` resolves (race) | `OR/utils.js` lines 293–298; `OR/components/hooks.js` lines 42–56; runtime re-run with a 5 ms async rerank |
| 12 | Orama paginates (`fetchDocuments(..., offset, limit)`) before `afterSearch`, and `search()` returns a Promise once any hook exists | CONFIRMED | `OR/methods/search-fulltext.js` lines 145–150, 175–188; runtime re-run with `limit: 1` returned 1 hit, `count: 2` |
| 13 | FastMCP `JevSearchTransform` defaults (`jev-latest`, 10.0 s, shortlist 8, fit 0.3, chunk 150 ≤ 255, max_results 5, close_read), `min(3*shortlist, 255)` cap, `shortlist*2 <= chunk_size` check, `SystemOneClient` protocol | CONFIRMED | `gh api` raw of `fastmcp_slim/fastmcp/experimental/transforms/jev_search.py` lines 50–57, 132–183; `server/transforms/search/base.py` lines 286–383 |
| 14 | MCP TS SDK: `tools/list` filters `enabled`, `tools/call` rejects disabled, `enable()`/`disable()`/`update()` call `sendToolListChanged()`; `@modelcontextprotocol/server` 2.1.0 released 2026-09-23; `@modelcontextprotocol/sdk` 1.30.1 | CONFIRMED | `gh api` raw of `packages/server/src/server/mcp.ts` lines 229–267, 935–998; GitHub releases API (`@modelcontextprotocol/server@2.1.0` 2026-09-23T15:43:11Z, `1.30.1` 2026-09-23T15:59:38Z); `npm view @modelcontextprotocol/sdk time` |
| 15 | The AI SDK MCP client has no handler for `tools/list_changed` (was UNVERIFIED) | CORRECTED: settled and sharpened. The client explicitly does not accept notifications and reports them via `onError` as "Unsupported message type" | https://github.com/vercel/ai/blob/main/packages/mcp/src/tool/mcp-client.ts lines 398–405, 464–473; `@ai-sdk/mcp@2.0.58` tarball `dist/index.js` line 2689; scan of all 22 non-test `.ts` files in `packages/mcp/src` |
| 16 | Anthropic "Custom Tool Search": `providerOptions.anthropic.deferLoading` plus `toModelOutput` returning `custom` parts with `type: 'tool-reference'`; "This sends `tool_reference` blocks to Anthropic" | CONFIRMED | `gh api` raw of `content/providers/01-ai-sdk-providers/05-anthropic.mdx` lines 1522–1571 |
| 17 | Claude Code docs: "most proxies don't forward `tool_reference` blocks" | CONFIRMED | https://code.claude.com/docs/en/mcp.md line 1429 |
| 18 | Whether AI Gateway forwards `defer_loading`/`tool_reference` to Anthropic | UNVERIFIED (no documentation either way; `llms-full.txt` has zero matches) | https://vercel.com/docs/llms-full.txt; `GW/src/gateway-language-model.ts` line 92 (`body: args`) |
| 19 | Whether Gateway resolves `typesafe-ai/jev-latest` (used in the AI SDK guide, line 135) | UNVERIFIED (not live-tested; no paid call made) | `AI/docs/03-ai-sdk-core/32-evaluation.mdx` line 135; https://ai-gateway.vercel.sh/v1/models |
| 20 | Package versions "pinned in `package.json`" | CORRECTED: only `ai` 7.0.114 and `@orama/orama` 3.1.18 are pinned there; gateway/provider packages are transitive | `package.json` lines 19–20 |

Also checked and CONFIRMED in passing: the benchmark sets `maxRetries: 0` (`src/jev.ts` line 35, `src/rerank.ts` line 17); the five Gateway reranking models match note 03; the Jev endpoint reports `has_zdr: false` and `supports_implicit_caching: false` (added to §4).

Totals: 15 CONFIRMED, 3 CORRECTED, 2 UNVERIFIED.
