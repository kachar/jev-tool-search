# Orama's architecture, and where Jev plugs in

Researched 2026-09-25 against the Orama monorepo at tag `v3.2.0` (commit `4e7cbe0`), cross-checked against `v3.1.18` (commit `2fe41e1`), the version our benchmark pins. Every code claim below was read in the source; the behaviour claims marked "measured" were run locally against `@orama/orama@3.1.18`.

Permalink base used below: `V = https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src`. Six files under `packages/orama/src` differ between `v3.1.18` and `v3.2.0` (`git diff --stat v3.1.18 v3.2.0 -- packages/orama/src`): `search-fulltext.ts` and `search-hybrid.ts` differ by one import line each (line numbers match); `components/tokenizer/index.ts` gains two lines at L39-L41, so its line numbers after L39 are 2 higher at v3.2.0 than at v3.1.18; `search.ts` loses the 101 lines moved to the new `fetch-documents.ts`; `tokenizer/languages.ts` gains 7 lines. Every other core file cited is line-for-line identical. All line numbers below refer to the v3.2.0 permalinks.

## TL;DR

- **Versions.** We pin `3.1.18` (npm, 2025-12-19). It is still npm `latest`, and it is also the latest GitHub Release. A `v3.2.0` tag exists (2026-06-27) with a CHANGELOG entry, but npm returns 404 for it and there is no GitHub Release. In core, 3.2.0 changes only a circular-import fix and some language/diacritics handling. Scoring is unchanged. Upgrading gains us nothing.
- **What Orama is.** A zero-dependency TypeScript in-memory engine. `create({schema})` returns a plain object. Around that object sit free functions: `insert`/`insertMultiple`/`search`/`remove`/`update`/`upsert`/`save`/`load`. Everything is synchronous until a hook is registered. For `search()` the trigger is any `beforeSearch`/`afterSearch` hook, async or not: measured on 3.1.18, a plugin with a plain synchronous `afterSearch` makes `search()` return a Promise ([search-fulltext.ts#L246-L251](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search-fulltext.ts#L246-L251)). `package.json` has no `dependencies`, is `sideEffects: false`, and ships deno/browser/esm/cjs builds.
- **Size.** The npm description says "less than 2kb". Measured: `create+insert+insertMultiple+search` bundles to 65,356 B minified and **22,148 B gzipped** with esbuild. The whole namespace is 25,141 B gzipped. The 2 kB figure is marketing.
- **Orama's BM25 is not textbook BM25.** (a) The score is `idf·(d + tf·(k+1)) / (tf + k·(1−b+b·len/avg))`, so `d` sits *inside* the numerator. That makes it a length-dependent bonus, not the constant BM25+ δ. (b) `tf` is stored as `count/fieldLength`. (c) The default tokenizer de-duplicates tokens. Together, (b) and (c) mean term frequency is effectively ignored by default. Measured: "search search search engine" and "search engine" score identically (0.1716).
- **A bug that touches the tuned preset.** In `string[]` fields, each array element overwrites the previous element's field length and term frequencies. Scores therefore depend on array order. Measured: two docs with the same `kw` elements in swapped order score 0.3498 vs 0.2410 for "alpha" (in a 3-doc index; the third doc is `kw: ['delta']`, and the absolute numbers depend on it). Our `BM25_TUNED` preset indexes `keywords: "string[]"` at boost 1.8, and `extractKeywords` in `bm25.ts` emits one word per element, so only the last keyword of each tool keeps term-frequency credit; the other keywords score on the `d` term alone.
- **Extension model.** The model has three layers. (1) Swappable **object components**: `tokenizer`, `index`, `documentsStore`, `sorter`, `pinning`. (2) **Function components**: `validateSchema`, `getDocumentIndexId`, `getDocumentProperties`, `formatElapsedTime`. (3) **Plugins**: `{ name, extra?, <21 hooks>, getComponents? }`. The official scorers QPS and PT15 are plugins that replace the whole `index` component through `getComponents`.
- **Only the async hooks can host Jev.** Index scoring (`calculateResultScores`, `search`) and the sorter are synchronous, so a network call cannot run inside them. `beforeSearch`/`afterSearch` may be async, and registering one turns `search()` into a Promise. `@orama/plugin-embeddings` and `@orama/plugin-secure-proxy` already make network/model calls in `beforeSearch`.
- **A reranker plugin pattern works on 3.1.18.** Tested with a stub scorer: `beforeSearch` raises `params.limit` to K, and `afterSearch` scores `results.hits`, re-sorts and trims. Three caveats. `afterSearch` sees only the post-pagination `limit` hits. `results.count` still reports the BM25 match count. `params` is the caller's object, so any mutation leaks unless the plugin undoes it.
- **Why "BM25 as a library" worked.** Zero install friction, a typed schema literal, a synchronous build (in-memory, one call), deterministic and inspectable scores, and runs-anywhere packaging. Scale: 825,562 downloads last week, 10,563 GitHub stars. A Jev library can copy the DX and the packaging. It cannot copy the sync, offline and deterministic properties, and it should say so up front.

## Detailed findings

### 1. Versions and release state

| Item | Value | Source |
|---|---|---|
| Our pin | `"@orama/orama": "3.1.18"` in `package.json` line 19 | local repo |
| 3.1.18 published | npm 2025-12-19T22:14:30Z; GitHub Release 2025-12-19T22:13:02Z; body is only a compare link | `npm view @orama/orama time`; https://github.com/oramasearch/orama/releases/tag/v3.1.18 |
| npm dist-tags | `{"latest": "3.1.18"}` | `npm view @orama/orama dist-tags` (2026-09-25) |
| 3.2.0 | Git tag on commit `4e7cbe0` (2026-06-27), CHANGELOG section "[3.2.0] - 2026-06-27"; `npm view @orama/orama@3.2.0` returns E404; no GitHub Release | https://github.com/oramasearch/orama/blob/main/CHANGELOG.md |
| 3.2.0 changes | Vietnamese support (#1013), experimental Korean tokenizer (#1018), plugin-astro on Astro 5 (#1020), plugin-nextra peer deps (#1025), markdown-it bump (#1017), "resolved a circular dependency in the search module" behind Metro/Expo `fetchDocuments is not a function` (#961, #1026) | same CHANGELOG |
| Core src diff 3.1.18→3.2.0 | 6 files: `fetch-documents.ts` extracted from `search.ts`; tokenizer skips `replaceDiacritics` for `LANGUAGES_WITH_SIGNIFICANT_DIACRITICS`; no scoring change | `git diff --stat v3.1.18 v3.2.0 -- packages/orama/src` |
| After 3.2.0 on main | Czech/Slovenian stemmers (#1033), plugin-match-highlight CJK fix (#1028), last commit 2026-07-03 | https://github.com/oramasearch/orama/commits/main |
| Unmerged | branch `feat/bm25f`, last commit 2025-09-02, "feat: introduces bm25f" | https://github.com/oramasearch/orama/tree/feat/bm25f |
| License | Apache-2.0 (npm); GitHub API reports `NOASSERTION` | `npm view @orama/orama@3.1.18 license`; https://github.com/oramasearch/orama |
| Adoption | 825,562 downloads 2026-09-15..21; 4,402,538 downloads 2026-08-23..09-21; 10,563 stars | https://api.npmjs.org/downloads/point/last-week/@orama/orama ; https://api.npmjs.org/downloads/point/last-month/@orama/orama ; GitHub API |

Latest real release and changelog: 3.1.18 is the latest shipped version. The 3.1.x line's last feature was document pinning in 3.1.16 (#990, https://github.com/oramasearch/orama/releases/tag/v3.1.16). 3.1.17 reformatted the code base and fixed the version name (#991, #1005). For our use there is nothing to upgrade to.

### 2. Public API shape

- Exports: `create`, `count`, `getByID`, `insert`, `insertMultiple`, pin CRUD, `remove`, `removeMultiple`, `search`, `searchVector`, `load`, `save`, `update(Multiple)`, `upsert(Multiple)`, `AnswerSession`, plus the `components` and `internals` namespaces ([V/index.ts#L1-L19](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/index.ts#L1-L19)).
- `create({ schema, sort?, language?, components?, plugins?, id? })` ([V/methods/create.ts#L26-L40](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/create.ts#L26-L40)). It returns a plain object that holds the components, `data: {index, docs, sorting, pinning}` and one array per hook ([#L163-L206](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/create.ts#L163-L206)).
- The schema is an `as const` literal. Types are `'string' | 'string[]' | 'number' | 'number[]' | 'boolean' | 'boolean[]' | 'enum' | 'enum[]' | 'geopoint' | 'vector[N]'` plus nested objects, and it maps to a document type with `SchemaTypes<>` ([V/types.ts#L67-L103](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L67-L103)). `boost` and `properties` in search params are typed against the flattened schema keys ([types.ts#L375](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L375)).
- `search(db, params)` dispatches on `params.mode`: `'fulltext'` (default), `'vector'` or `'hybrid'` ([V/methods/search.ts#L16-L36](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search.ts#L16-L36)). The return type is `Results | Promise<Results>`.
- `Results = { count, hits: {id, score, document}[], elapsed, facets?, groups? }`. Here `count` is "the number of all the matched documents" and `hits` has "limit and offset into account" ([types.ts#L750-L860](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L750-L860)).
- `insertMultiple` batches 1,000 docs by default and switches to an async path when hooks are async ([V/methods/insert.ts#L269-L302](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/insert.ts#L269-L302)).

### 3. The full-text pipeline, step by step

`fullTextSearch` ([V/methods/search-fulltext.ts#L157-L252](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search-fulltext.ts#L157-L252)):

1. `beforeSearch` hooks run, awaited, only if any are registered (L233-L235).
2. `innerFullTextSearch` resolves the searchable string properties (cached), applies the `where` filters to get an ID set, and calls `orama.index.search(...)` with `term, tokenizer, properties, exact, tolerance, boost, relevance, docsCount, whereFiltersIDs, threshold` (L23-L136). **The default `threshold` is 1** (L69).
3. Sorting: a custom `sortBy` comparator over `[id, score, doc]` (L173-L182), the sorter component for a property sort (L184-L186), or score descending (L189).
4. Pinning rules (L193).
5. **Pagination**: `fetchDocuments(orama, ids, offset, limit)` with `limit = 10` by default (L167, L197-L199).
6. Facets and groups are computed over the *full* ID list (L218-L225).
7. `afterSearch` hooks run on the paginated result (L239-L241).
8. If neither hook array is non-empty, the whole thing stays synchronous (L246-L251).

Index search ([V/components/index.ts#L457-L592](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/index.ts#L457-L592)):

- The query is tokenized with the same tokenizer as the documents (L471).
- For each property, the field boost defaults to 1 and throws if ≤ 0 (L490-L493). Each query token is looked up in the property's radix tree with `find({term, exact, tolerance})` (L504). `tolerance` is a Levenshtein edit budget; `exact: false` allows prefix matches.
- **Every matched indexed word gets full BM25 credit.** A fuzzy or prefix match scores like an exact one, with no distance penalty (L513-L529 → `calculateResultScores`).
- Scores add up across tokens and across properties, as `bm25 × boost` summed ([L449-L453](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/index.ts#L449-L453)).
- Threshold. `1` returns every doc that matches any token (L543-L545). `0` requires all tokens in at least one property (L548-L572). A value in between returns the full matches plus `ceil(threshold × remaining)` partial matches (L575-L591).
- `prioritizeTokenScores` in `algorithms.ts` (L5-L114, with the old `×1.5` multi-match bonus) is no longer called anywhere in `packages/orama/src`. It is dead code.

### 4. The BM25 function and its inputs

```ts
// V/components/algorithms.ts#L116-L126
const idf = Math.log(1 + (docsCount - matchingCount + 0.5) / (matchingCount + 0.5))
return (idf * (d + tf * (k + 1))) / (tf + k * (1 - b + (b * fieldLength) / averageFieldLength))
```

- Defaults are `k: 1.2, b: 0.75, d: 0.5` ([search-fulltext.ts#L254-L258](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search-fulltext.ts#L254-L258)). They are overridable per query with `relevance: {k, b, d}`. The docs describe `d` as "Frequency normalization lower bound … Recommended value: between 0.5 and 1" (https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/search/bm25.mdx).
- **The `d` placement is not BM25+.** BM25+ (Lv & Zhai) adds δ outside the saturating fraction, as `idf·(tf(k+1)/(tf+K) + δ)`. Orama puts `d` in the numerator, which yields `idf·d/(tf+K)`, a bonus that shrinks as fields get longer. Our own `bm25.ts` comment calls it the "BM25+ delta 0.5". That label is imprecise.
- **`tf` is pre-normalized by length.** `insertTokenScoreParameters` stores `tf = tokenFrequency / tokens.length` ([index.ts#L93-L119](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/index.ts#L93-L119)). The BM25 denominator then normalizes by length a second time.
- **Tokens are de-duplicated by default.** `allowDuplicates` defaults to false, and `tokenize` returns `Array.from(new Set(tokens))` ([V/components/tokenizer/index.ts#L90-L92, L157](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/tokenizer/index.ts#L90-L92)). So `tf = 1/uniqueTokenCount` for every matched term, and `fieldLength` counts unique tokens.
  - Measured on 3.1.18: `{t:'search search search engine'}` and `{t:'search engine'}` both store `tf = 0.5`, and both score 0.1716 for "search".
- `matchingCount` is `tokenOccurrences[prop][token]`, which is incremented once per (doc, unique token) for a `string` field, so with de-duplication it is document frequency. For a `string[]` field it is incremented once per (element, unique token), so a token repeated across elements of one doc is counted more than once.
- **`string[]` fields are scored wrong.** `insert` calls `insertScalar` once per array element ([index.ts#L288-L296](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/index.ts#L288-L296)). Each call runs `insertDocumentScoreParameters` (L236-L238). That call does three things: it *overwrites* `fieldLengths[prop][id]`, it *resets* `frequencies[prop][id] = {}`, and it re-averages `avgFieldLength` with the same `docsCount` each time (L79-L91).
  - Measured on 3.1.18: docs `a: kw=['alpha beta','gamma']` and `b: kw=['gamma','alpha beta']` end up with `freq = {a:{gamma:1}, b:{alpha:.5,beta:.5}}`.
  - Search "alpha" returns b 0.3498, a 0.2410. Search "gamma" returns a 0.6425, b 0.1424.
  - Earlier elements still match, because the radix tree has them. They score with `tf = 0`, so only the `d` term survives.
  - Our preset's case: `extractKeywords` returns single words, so every element has length 1. Measured on 3.1.18 with `a: ['alpha','gamma']`, `b: ['gamma','alpha']`, `c: ['zeta']`: frequencies end as `{a:{gamma:1}, b:{alpha:1}, c:{zeta:1}}`, `avgFieldLength` 1, and "alpha" scores b 0.5768 vs a 0.1958. Only the last keyword per tool gets tf credit.
- Tokenizer defaults: English, **no stemming** unless `stemming: true` (L104-L121), and **an empty stop-word list** unless one is provided (L123-L147). Diacritics are stripped except for languages flagged as significant.

### 5. Component model

- Object components: `['tokenizer', 'index', 'documentsStore', 'sorter', 'pinning']`. Function components: `['validateSchema', 'getDocumentIndexId', 'getDocumentProperties', 'formatElapsedTime']` ([V/components/hooks.ts#L14-L21](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/hooks.ts#L14-L21)). Any other key throws `UNSUPPORTED_COMPONENT` ([create.ts#L69-L73](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/create.ts#L69-L73)).
- `tokenizer` takes either a `DefaultTokenizerConfig` or an object with `tokenize(raw, language?, prop?, withCache?)` ([types.ts#L1088-L1103](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L1088-L1103); [create.ts#L134-L148](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/create.ts#L134-L148)).
- `IIndex` ([types.ts#L934-L1020](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L934-L1020)) exposes `create/insert/remove`, the score-parameter bookkeeping, `calculateResultScores`, `search(...) : TokenScore[]`, `searchByWhereClause` and `load/save`. **Every one of these returns synchronously.** Only `remove`, `removeDocumentScoreParameters` and `save` allow `SyncOrAsyncValue`.
- `ISorter.sortBy(sorter, docIds, by) : [DocumentID, number][]` is synchronous and property-based ([types.ts#L1044-L1068](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L1044-L1068)). The per-query `sortBy` comparator `(a, b) => number` over `[id, score, doc]` is also synchronous ([types.ts#L260-L265](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L260-L265)).
- `documentsStore` is a record of internal ID → doc. `get/getMultiple/getAll/store/remove/count/load/save` are all small and swappable ([types.ts#L1022-L1034](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L1022-L1034)).
- Serialization: `save(db)` returns `{internalDocumentIDStore, index, docs, sorting, pinning, language}`, where each part comes from its component's `save`. `load` reverses it ([V/methods/serialization.ts#L13-L31](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/serialization.ts#L13-L31)). The index snapshot includes `frequencies, tokenOccurrences, avgFieldLength, fieldLengths` ([index.ts#L781-L905](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/index.ts#L781-L905)). A custom component must therefore implement its own `load/save` to survive persistence.

### 6. Plugins and hooks

- `OramaPlugin = { name, extra?, beforeInsert?, afterInsert?, …, beforeSearch?, afterSearch?, …, afterCreate?, getComponents?(schema) }`, sync or `Promise` of it ([types.ts#L1372-L1410](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L1372-L1410)).
- There are 21 hook names in `AVAILABLE_PLUGIN_HOOKS`: before/after × insert, remove, update, upsert, the four `*Multiple` variants, search and load, plus `afterCreate` ([V/components/plugins.ts#L6-L28](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/plugins.ts#L6-L28)). The docs page lists 14 of them (https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/plugins/writing-your-own-plugins.mdx).
- Wiring: `getComponents` output is merged into `components` and throws `PLUGIN_COMPONENT_CONFLICT` if two sources set the same key ([create.ts#L100-L122](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/create.ts#L100-L122)). Hooks are gathered per name after the components are created ([L208-L210](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/create.ts#L208-L210)).
- Async detection has two levels. `fullTextSearch` switches to its async path, and returns a Promise, whenever the `beforeSearch` or `afterSearch` array is non-empty, whatever the hooks are (search-fulltext.ts L246-L251; measured). Inside that path, `runAfterSearch` awaits hooks serially if any hook `isAsyncFunction` (a check on `constructor.name === 'AsyncFunction'`, utils.ts L350-L356); otherwise it calls them synchronously ([hooks.ts#L67-L87](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/components/hooks.ts#L67-L87)). The docs warn: "When working with `async` hooks remember to always use the `async` keyword modifier". A hook that is not declared `async` but returns a Promise is not awaited.
- Hook signatures: `afterSearch(orama, params, language, results)` ([types.ts#L1388-L1393](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L1388-L1393)). `results` is the same object `search` returns, so in-place edits reach the caller.
- The docs say plugins replaced the older `components`-based hooks in v2.0.0-beta.5 (same docs page).

### 7. Official plugins

| Plugin | Mechanism | Notes | Source |
|---|---|---|---|
| `plugin-embeddings` | `async beforeInsert` embeds configured properties into `defaultProperty`; `async beforeSearch` fills `params.vector` from `params.term` for vector/hybrid modes | TensorFlow.js Universal Sentence Encoder, `vector[512]`; the docs warn "Search and insert methods are now async!"; ships a stray `console.log({vector})` in `beforeSearch` (L84-L86) | [packages/plugin-embeddings/src/index.ts](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/plugin-embeddings/src/index.ts); https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/plugins/plugin-embeddings.mdx |
| `plugin-secure-proxy` | Same two hooks, but calls `OramaProxy.generateEmbeddings` (`@oramacloud/client`); exposes `extra: {proxy, pluginParams}` | The closest precedent for a remote-model plugin | [packages/plugin-secure-proxy/src/index.ts#L40-L106](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/plugin-secure-proxy/src/index.ts#L40-L106) |
| `AnswerSession` (core) | Finds the plugin named `orama-secure-proxy`, reads `extra.proxy` and `extra.pluginParams.chat.model`, runs `search(db, params)` for sources, then streams `proxy.chatStream` | RAG is hard-wired to Orama's proxy service | [V/methods/answer-session.ts#L45, L157-L220](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/answer-session.ts#L45) |
| `plugin-pt15` | `getComponents` → replaces `index` with a 15-bucket positional store; non-string props delegate to the default index | "Positional Token 15", inspired by Flexsearch | [packages/plugin-pt15/src/index.ts#L30-L40](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/plugin-pt15/src/index.ts#L30-L40); https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/search/changing-default-search-algorithm.mdx |
| `plugin-qps` | `getComponents` → index with its own `search()` scoring token proximity in "quantums" | "developed by the Orama team in 2024" | [packages/plugin-qps/src/index.ts](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/plugin-qps/src/index.ts); same docs page |
| `plugin-analytics` | sync `afterSearch` pushes `{query, resultsCount, roundTripTime, results:[{id,score}]}` to a collector; `afterCreate` builds it | Posts to Orama's endpoint | [packages/plugin-analytics/src/index.ts#L41-L75](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/plugin-analytics/src/index.ts#L41-L75) |
| `plugin-data-persistence` | Not a hook plugin; free functions `persist(db, format)` / `restore(format, data)` over `save/load`, formats `json`, `dpack`, `binary`, `seqproto`; `persistToFile/restoreFromFile` on Node | | [packages/plugin-data-persistence/src/index.ts#L54-L175](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/plugin-data-persistence/src/index.ts#L54) |

All plugin packages are at version 3.2.0 in the tag's `package.json` files. As with core, 3.2.0 is not on npm.

### 8. Vector and hybrid search

- Vector search is **brute force**: cosine over every stored vector (or over the filtered ID set), keeping those `≥ similarity`, default `0.8`. A comment reads "@todo: Write plugins … to use parallel computation" ([V/trees/vector.ts#L9, L75-L110](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/trees/vector.ts#L75-L110)).
- Hybrid search min-max normalizes the BM25 scores (`minMaxScoreNormalization`, L24), then divides each list by its own max (BM25 again, cosine only by max), then combines them linearly. `getQueryWeights` always returns `{text: 0.5, vector: 0.5}` unless `hybridWeights` is passed with both `text` and `vector` truthy; a weight of 0 fails that check and silently falls back to 0.5/0.5 (L134). The comment says a future plugin would ship "a ML model to adjust the weights" ([V/methods/search-hybrid.ts#L19-L29, L124-L168](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search-hybrid.ts#L124-L168)).
- Hybrid and vector search run the same `beforeSearch`/`afterSearch` flow as full-text (`search-hybrid.ts#L82-L102`; `search-vector.ts#L118-L131`).

### 9. Runtimes and bundle

- `exports` has `deno`, `browser`, `import` and `require` conditions for `.`, `./internals`, `./components` and more. `"sideEffects": false`, `"engines": {"node": ">= 20.0.0"}`, and no `dependencies` field (`packages/orama/package.json` at the tag). The README shows imports from jsDelivr ESM and from Deno `npm:` specifiers (https://github.com/oramasearch/orama/blob/main/README.md).
- Measured with esbuild 0.25.10 against `@orama/orama@3.1.18`, `--bundle --minify --format=esm --platform=browser`, then gzip -9. `{create, insert, insertMultiple, search}` comes to 65,356 B minified and 22,148 B gzipped; `import *` comes to 78,164 B minified and 25,141 B gzipped. The package description says "less than 2kb". The installed package is 3.6 MB on disk because it ships four builds.
- Edge support is implied by zero deps and ESM builds. There is no edge-specific code. The "runs on edge" claim is UNVERIFIED as a tested matrix; I did not find an edge CI job.

### 10. Why "BM25 as a library" succeeded (evidence-based reading)

1. **One install, zero transitive deps, four module formats.** It drops into Next.js, Workers, Deno or a `<script type="module">`.
2. **A typed schema literal.** `boost`, `properties`, `where` and hits are typed from the schema, so autocomplete does the documentation work.
3. **An instant, local, synchronous index.** `insertMultiple` over a few hundred tool descriptions takes one call. `search` returns synchronously in microseconds. The StackOne note in `04-tool-search-landscape.md` cites "BM25 <1 ms".
4. **Deterministic, inspectable scores.** The same input gives the same order, and `hits[].score` can be logged. For tool search, that makes failures debuggable. It is also why the odd scoring in §4 can go unnoticed: the output looks plausible.
5. **One mental model for all three modes.** Full-text, vector and hybrid share the params and the result shape. A plugin can add an embedding model without changing call sites; the only change is that `search` becomes async.
6. **Serializable.** `save/load` lets a catalog index be built at deploy time and shipped as JSON.

Jev breaks 3 and 4 by nature: the call is remote, paid, async, rate-limited (48% HTTP 429 at 199 options in our run), and its probabilities are calibrated but not bit-reproducible (UNVERIFIED whether identical requests return identical probabilities). Properties 1, 2, 5 and 6 carry over.

### 11. Where a model reranker plugs into Orama

Ranked by fit:

**A. A plugin with `beforeSearch` + `afterSearch` (recommended; no fork).**

- `beforeSearch` raises `params.limit` to the candidate pool K (for example 20, the size at which we saw ~0% 429s). `performSearchLogic` reads `limit` after the hook runs ([search-fulltext.ts#L167, L233-L237](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search-fulltext.ts#L233-L237)), so the change takes effect.
- `afterSearch` sends `params.term` plus the K `results.hits` documents to Jev as one `choice` question. It rewrites `hit.score` with the probability, re-sorts, and slices to the caller's original limit.
- Tested on 3.1.18 with a stub scorer. `search` returned a Promise; the top 3 came from the 20 BM25 candidates, re-ordered by the stub; docs outside the pool were never seen.
- Caveats:
  1. `results.count` still means "BM25 matches".
  2. Facets and groups are computed on the full BM25 list.
  3. `params` is the caller's object, so the original limit must be stored (WeakMap) and restored.
  4. Hooks run serially, so a Jev call adds its full latency.
  5. The plugin must be declared `async`.
  6. The rerank covers only K, so BM25 recall at K caps accuracy. In our run, BM25 top-20 then Jev scored 70.6% vs Jev over the whole catalog at 74.6%.
- The plugin could also skip Orama's candidates and send the whole catalog when `db` count ≤ 255, reading docs from `orama.documentsStore.getAll(orama.data.docs)`. That turns Orama into a document store plus fallback.

**B. Replace the index component with `getComponents`, the QPS/PT15 pattern.** This fits a different *first-stage* scorer, such as a fixed BM25 with correct `string[]` handling and real tf. It cannot host Jev, because `IIndex.search` must return `TokenScore[]` synchronously ([types.ts#L990-L1003](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/types.ts#L990-L1003)).

**C. A custom sorter or the per-query `sortBy` comparator.** Both are synchronous ([search-fulltext.ts#L172-L187](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search-fulltext.ts#L172-L187)). They are only usable if Jev scores were precomputed and attached to docs, which defeats the per-query point.

**D. Wrapper outside Orama.** `const r = await search(db, {...params, limit: K}); rerank(r.hits)`. This is the simplest option and needs no plugin semantics. It is what FastMCP-style libraries do. For a standalone "Jev search library", a wrapper with an optional Orama adapter is probably cleaner than an Orama plugin, since the plugin gains nothing but the `db.plugins` registration.

**E. Hybrid weights.** `getQueryWeights` is a stub waiting for a model ([search-hybrid.ts#L159-L168](https://github.com/oramasearch/orama/blob/4e7cbe0de23f2ba239b85d12a03e9e57baee373e/packages/orama/src/methods/search-hybrid.ts#L159-L168)). A Jev boolean or score question ("is this query keyword-like or conceptual?") could set `params.hybridWeights` in `beforeSearch`. Both weights must be non-zero, or Orama ignores them (§8). This is speculative.

Sketch of A, tested with a stub in place of the Jev call:

```ts
const pool = new WeakMap<object, number>()
export const jevRerank = (k: number, score: (q: string, docs: unknown[]) => Promise<number[]>) => ({
  name: 'jev-rerank',
  beforeSearch: async (_db, params) => { pool.set(params, params.limit ?? 10); params.limit = Math.max(k, params.limit ?? 10) },
  afterSearch: async (_db, params, _lang, results) => {
    const p = await score(params.term ?? '', results.hits.map((h) => h.document))
    const limit = pool.get(params) ?? 10
    params.limit = limit
    results.hits = results.hits.map((h, i) => ({ ...h, score: p[i] })).sort((a, b) => b.score - a.score).slice(0, limit)
  },
})
```

## Implications for a Jev search library

- **Copy the API shape, not the engine.** `create({ schema })` → `insert/insertMultiple` → `search({ term, limit, where })` → `{ hits: [{id, score, document}] }`, with the schema typed as in Orama. Users coming from Orama would then change one import. Returning `Promise` always is honest: Jev is never sync.
- **Ship as an Orama plugin *and* as a standalone.** The plugin (pattern A) is a small package, `@x/orama-plugin-jev`, with a precedent in `plugin-secure-proxy`. The standalone adds the things Orama lacks for this job:
  - whole-catalog mode when N ≤ 255 and the token budget fits;
  - BM25-then-Jev at K ≈ 20 for bigger catalogs or when the provider returns 429;
  - a fallback to BM25 order on 429 or timeout.
- **Be explicit about what is lost.** Jev search is not sync, not offline, not free and not deterministic. Orama's success leaned on all four. The pitch has to be accuracy per dollar ($0.042/M input) and latency budget, not DX parity.
- **Fix the first stage if we keep Orama.** Our `BM25_TUNED` baseline indexes `keywords: string[]`, which Orama scores order-dependently (§4). With default de-duplication, tf plays no role. Either the benchmark notes this, or the keywords get joined into one `string` field. Joining is a small change that could move the 43-47% BM25 numbers. UNVERIFIED by how much; it needs a rerun. The "BM25+" wording in `bm25.ts` should also be corrected.
- **Keep K as a first-class parameter.** Orama's hook model makes a top-K rerank natural, and our 429 data says K ≈ 20 is where Jev is reliable. That is the design point: BM25 (or embeddings) for recall, Jev for the final choice.
- **Persist the index, not the model.** Reuse Orama's `save/load` for the first stage. A Jev layer has no local state beyond optional caches of (query, candidate set) → probabilities.

## Open questions

1. Is Orama's JS library still actively maintained? The last npm release is 3.1.18 (2025-12-19); 3.2.0 is tagged and changelogged but unpublished; main's last commit is 2026-07-03. The company's current focus (OramaCore/Cloud) is UNVERIFIED here.
2. Does `feat/bm25f` (2025-09-02) fix the per-field tf and `string[]` issues? Not read.
3. How much do the `string[]` bug and the tf de-duplication cost on MetaTool? Rerun `BM25_TUNED` with `keywords` joined into a `string`, and with `allowDuplicates: true`.
4. Are Jev's probabilities stable across identical requests? This matters for caching and for any "deterministic" claim. UNVERIFIED.
5. Does passing K hits as a `choice` question in `afterSearch` fit the 32k state + longest-question budget for rich tool docs? Measure token counts per candidate.
6. Is there an edge-runtime CI matrix for Orama (Workers, Vercel Edge)? Not found.

## Sources

- Orama repo, tag v3.2.0: https://github.com/oramasearch/orama/tree/4e7cbe0de23f2ba239b85d12a03e9e57baee373e (all `V/...` links above)
- Orama tag v3.1.18: https://github.com/oramasearch/orama/tree/v3.1.18
- CHANGELOG: https://github.com/oramasearch/orama/blob/main/CHANGELOG.md
- Releases: https://github.com/oramasearch/orama/releases (v3.1.18, v3.1.17, v3.1.16)
- Branch feat/bm25f: https://github.com/oramasearch/orama/tree/feat/bm25f
- Docs sources: https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/search/bm25.mdx ; https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/plugins/writing-your-own-plugins.mdx ; https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/search/changing-default-search-algorithm.mdx ; https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/plugins/plugin-embeddings.mdx (rendered at https://docs.orama.com/docs/orama-js/..., which is client-rendered and returned only navigation to curl)
- npm registry: `npm view @orama/orama time|dist-tags|license` (2026-09-25); https://api.npmjs.org/downloads/point/last-week/@orama/orama ; https://api.npmjs.org/downloads/point/last-month/@orama/orama
- Local measurements: scratchpad `otest/t.mjs` (string[] and tf behaviour), `otest/r.mjs` (rerank plugin), esbuild bundle sizes, all against `@orama/orama@3.1.18`
- Our code: `src/bm25.ts`, `package.json`
- Prior notes (not duplicated): `research/tool-search/03-jev-model-and-evaluate-api.md`, `research/tool-search/04-tool-search-landscape.md`

## Verification log

Adversarial re-check on 2026-09-25. Code claims were re-read in a fresh clone of https://github.com/oramasearch/orama at `v3.2.0` (`4e7cbe0`), `v3.1.18` (`2fe41e1`) and `main` (`b030e1b`). Measurements were re-run against the installed `@orama/orama@3.1.18` (scratchpad `otest/`).

| # | Claim | Verdict | Source checked |
|---|---|---|---|
| 1 | npm `latest` is 3.1.18, published 2025-12-19T22:14:30Z; 3.2.0 returns E404 on npm | CONFIRMED | `npm view @orama/orama dist-tags / time / @3.2.0` |
| 2 | Latest GitHub Release is v3.1.18 (2025-12-19T22:13:02Z), body only a compare link; no v3.2.0 release | CONFIRMED | https://api.github.com/repos/oramasearch/orama/releases |
| 3 | v3.2.0 tag on `4e7cbe0`, 2026-06-27; CHANGELOG items #1013, #1018, #1020, #1025, #1017, #961/#1026 | CONFIRMED | `git rev-parse v3.2.0`; https://github.com/oramasearch/orama/blob/main/CHANGELOG.md |
| 4 | "v3.1.18 and v3.2.0 line-for-line identical except `search-fulltext.ts`" | CORRECTED | `git diff --stat v3.1.18 v3.2.0 -- packages/orama/src`: `search-hybrid.ts`, `tokenizer/index.ts`, `search.ts`, `languages.ts` also differ; tokenizer lines after L39 shift by 2 |
| 5 | main's last commit 2026-07-03; `feat/bm25f` last commit 2025-09-02 "feat: introduces bm25f" | CONFIRMED | `gh api repos/oramasearch/orama/commits`; `git ls-remote` + fetch of `feat/bm25f` (`91c69fa`) |
| 6 | 825,562 downloads last week, 4,402,538 last month, 10,563 stars, GitHub license `NOASSERTION`, npm license Apache-2.0 | CONFIRMED | https://api.npmjs.org/downloads/point/last-week/@orama/orama ; .../last-month/... ; `gh api repos/oramasearch/orama`; `npm view @orama/orama@3.1.18 license` |
| 7 | Bundle 65,356 B min / 22,148 B gzip (4 functions); 78,164 / 25,141 (namespace); esbuild 0.25.10; 3.6 MB on disk; description says "less than 2kb" | CONFIRMED | re-ran esbuild on `otest/e1.mjs`, `e2.mjs`; `node_modules/@orama/orama/package.json` |
| 8 | BM25 formula with `d` inside the numerator; defaults k 1.2, b 0.75, d 0.5 | CONFIRMED | `algorithms.ts` L116-L126, `search-fulltext.ts` L254-L258 at v3.2.0 |
| 9 | `tf = tokenFrequency / tokens.length`; tokenizer de-duplicates by default; no stemming, empty stop-word list by default | CONFIRMED | `index.ts` L93-L119; `tokenizer/index.ts` L90-L92, L104, L123, L157 at v3.2.0 |
| 10 | "search search search engine" and "search engine" both score 0.1716 | CONFIRMED | re-ran `otest/t.mjs` (2-doc index) |
| 11 | `string[]` elements overwrite field length and reset frequencies; swapped-order docs score 0.3498 vs 0.2410 ("alpha") and 0.6425 vs 0.1424 ("gamma") | CONFIRMED, context added | `index.ts` L79-L91, L236-L238, L288-L296; re-ran `otest/t.mjs`. Numbers come from a 3-doc index (third doc `kw: ['delta']`). Added: our preset uses single-word elements, so only the last keyword keeps tf (measured 0.5768 vs 0.1958) |
| 12 | `matchingCount` is document frequency | CORRECTED (scope) | `index.ts` L110-L118: true for `string` fields; for `string[]` it counts per element |
| 13 | Default `threshold` 1, default `limit` 10, pagination before `afterSearch`, facets/groups over the full list | CONFIRMED | `search-fulltext.ts` L69, L167, L197-L225, L233-L241 |
| 14 | "Everything is synchronous unless an async hook is registered" | CORRECTED | `search-fulltext.ts` L246-L251; measured: a sync `afterSearch` plugin makes `search()` return a Promise |
| 15 | Fuzzy/prefix matches get full BM25 credit | CONFIRMED | `index.ts` L504-L529 (no distance term); measured: "calendar" and "calendat" both 1.2037 with `tolerance: 1` |
| 16 | 21 hooks in `AVAILABLE_PLUGIN_HOOKS`; docs list 14; docs say plugins arrived in v2.0.0-beta.5 and warn to use `async` | CONFIRMED | `plugins.ts` L6-L28; https://github.com/oramasearch/docs/blob/main/content/docs/orama-js/plugins/writing-your-own-plugins.mdx (L6, L68, L86, L91-L104) |
| 17 | `IIndex.search` returns `TokenScore[]` synchronously; only `remove`, `removeDocumentScoreParameters`, `save` allow `SyncOrAsyncValue` | CONFIRMED | `types.ts` L934-L1020 |
| 18 | Object/function component lists; `UNSUPPORTED_COMPONENT`, `PLUGIN_COMPONENT_CONFLICT`; hooks wired at create.ts L208-L210 | CONFIRMED | `hooks.ts` L14-L21; `create.ts` L71, L115, L208-L209 |
| 19 | Rerank plugin: Promise returned; top 3 drawn only from the 20-doc pool | CONFIRMED | re-ran `otest/r.mjs`: `isPromise true`, lengths 24/23/22 (pool is the 20 shortest names) |
| 20 | Vector search brute force, default similarity 0.8, `@todo` comment; hybrid "min-max normalizes BM25 by its max and cosine by its max", weights 0.5/0.5 unless passed | CORRECTED (hybrid part) | `trees/vector.ts` L9, L76; `search-hybrid.ts` L24, L134, L159-L168: BM25 is min-max normalized then max-divided, cosine only max-divided; weights are ignored unless both are truthy |
| 21 | plugin-embeddings: `vector[512]`, async hooks, stray `console.log` in `beforeSearch`; docs "Search and insert methods are now async!"; secure-proxy calls `generateEmbeddings`; AnswerSession looks up `orama-secure-proxy`; QPS/PT15 "developed by the Orama team in 2024", PT15 inspired by Flexsearch | CONFIRMED | `plugin-embeddings/src/index.ts` L33, L41, L62, L84; `plugin-secure-proxy/src/index.ts` L57-L92; `answer-session.ts` L45, L162, L211-L220; docs `plugin-embeddings.mdx` L43, `changing-default-search-algorithm.mdx` L57, L78 |

Counts: 17 CONFIRMED (one with added context), 4 CORRECTED, 0 UNVERIFIED among the claims checked. Claims already marked UNVERIFIED in the note (edge CI matrix, Jev determinism, company focus, the effect size of fixing `keywords`) were not re-checked and stay UNVERIFIED.
