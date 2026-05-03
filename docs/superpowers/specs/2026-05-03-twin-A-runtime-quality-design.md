---
title: Spec A — Twin Runtime Quality
description: Wire team chat into the twin runtime, fix style few-shot via embedding cache, add MMR + score threshold, and surface citations in chat.
---

# Spec A — Twin Runtime Quality

| Status       | Drafted                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| Date         | 2026-05-03                                                                    |
| Author       | brainstorm session w/ Max Qian                                                |
| Builds on    | ADR-0003 (Employee Digital Twin)                                              |
| Sequence     | First of four sequential specs (A → C → B → D)                                |
| Out of scope | Spec C (data integrity), Spec B (distill robustness), Spec D (lifecycle + UX) |

## Context

The digital-twin subsystem (ADR-0003, Phases 0–8) shipped end-to-end —
ingest → distill → runtime — and the workbench UI wires the queue. The
opt-in chat-send seam in `lib/claude/build-options.ts:222–236` is in
place, and `hooks/chat/use-claude-chat.ts:297–305` populates `twinDeps`
from runtime settings. Single-character chat is twin-aware today.

A code-level audit surfaced four runtime defects that together prevent
a bound twin from feeling "twin-shaped" in production:

1. **Team chat does not invoke the twin runtime.**
   `hooks/chat/use-team-chat.ts:586–592` calls `resolveSendOptions`
   without `twinDeps` / `twinUserMessage`. Any twin-bound member in a
   team session currently produces output indistinguishable from a
   plain character.

2. **Style few-shot retrieval falls back to a near-random heuristic.**
   `lib/twin/runtime/few-shot-selector.ts:75–93` accepts pre-computed
   `sampleEmbeddings` but no caller computes or persists them. The
   fallback ranks samples by `summary.length`, effectively defeating the
   second pillar of the twin (style fidelity).

3. **No score threshold and no diversity filter on retrieved chunks.**
   `apply-twin-context.ts` returns the raw top-K from the vector store
   and prints the cosine score verbatim into the system prompt. Near-
   duplicate chunks crowd the context window; low-relevance chunks are
   treated as authoritative; the model sees a leaky number it should
   not see.

4. **Citations are computed but never displayed.**
   `applied.metadata.retrievedChunkIds` and `styleSampleIds` are
   produced on every twin-bound send and immediately discarded. Users
   cannot see, audit, or click "where did this answer come from".

Spec A fixes all four. It is intentionally scoped to runtime quality —
data integrity (Spec C), distill robustness (Spec B), and lifecycle/UX
(Spec D) follow as separate specs.

## Goals

- Twin-bound members in a team chat produce twin-aware output, with
  shared per-turn embedding to avoid N×embed cost when every member
  uses the same embedding model.
- Style few-shot retrieval ranks samples by query-cosine, not by
  summary length. Cache misses self-heal at runtime.
- Retrieved RAG chunks pass a relevance floor and are diversified via
  MMR; the system prompt no longer leaks raw cosine scores.
- Twin-bound assistant messages carry a provenance footer the user can
  expand to inspect retrieved chunks; degraded sends are clearly
  labelled.
- Zero Dexie schema migrations; one (backwards-compatible) vector
  store interface extension.

## Non-goals

- Persisting _style sample_ embeddings in the remote vector store.
  They live inline on `StyleSample.embedding` (in Dexie) only.
- Per-character override of `ragMinScore` / `ragMmrLambda` /
  `styleMmrLambda` UI. Defaults ship in this spec; per-twin overrides
  in `TwinSettings` are wired but the workbench surface is deferred
  to Spec D.
- Re-distill or re-embed on embedding-model change. Spec A handles
  silent dimension mismatch only at the _style sample_ boundary
  (drop-and-relazy-embed); chunk-level dimension migration is in
  Spec C.

## Decisions

### 1. Team chat — per-turn shared embed (option b from brainstorm)

Per turn (one user message), embed once and reuse across every twin-
bound member of the team — provided every member uses the same
embedding `provider`+`model`. Today the runtime config is global
(`twinRuntimeSettings`), so a single twin pool is the only consumer;
the dispatch supports per-member fallback for forward compatibility.

### 2. Style sample embedding — write-time cache, lazy backfill

Embed each style sample's `summary` field at the moment it lands on
the profile (`appendStyleSamples`). Persist inline as
`StyleSample.embedding?: number[]` (JSON-nested in
`twinProfile.styleSamples` — no schema migration). Runtime detects
missing embeddings and lazy-backfills, writing them back to Dexie so
the next turn is fast.

### 3. MMR + score threshold for retrieval

Retrieval over-fetches `2 × ragTopK` from the vector store, drops
hits below `ragMinScore` (default 0.3), then reranks via Maximal
Marginal Relevance (`λ = ragMmrLambda`, default 0.5 for RAG, 0.7 for
style) before selecting the final top-K. The cosine score is no
longer printed in the system prompt; chunks are tagged "highly /
moderately / loosely relevant" instead.

MMR requires the chunk's stored embedding. The `IVectorStore`
interface extends `searchByEmbedding`'s options object with a new
optional `returnEmbedding?: boolean` (default `false` — preserves the
current "vectors not fetched" behaviour for every existing caller).
When `returnEmbedding: true`, each hit carries `embedding?: number[]`
populated from the backend response. When the backend cannot supply
it (or a particular client doesn't implement it yet), MMR no-ops and
we degrade to the score-only path. No existing caller pays the
bandwidth cost; only the twin runtime opts in.

### 4. Citations in chat — reuse `ai-elements/sources`

`resolveSendOptions` keeps its `Promise<SendOptions>` signature; a
new optional `twinAppliedSink?: (applied: AppliedTemplate) => void`
on `BuildOptionsContext` lets the chat hook capture the applied
template metadata without forcing a return-shape change on the 7
non-chat call sites (diagnostics, scheduler executors, test suites).
The chat hooks attach a `twinCitations` blob to the assistant
`StoredMessage.metadata` (no schema change — that field is
free-form). The message renderer mounts `<Sources>` from
`components/ai-elements/sources.tsx` (currently unused in the chat
surface). Style sample provenance is _counted_ but not shown verbatim
(privacy: the user's own writing is sensitive).

## Data model changes

| Field                                  | Where                                               | Type                             | Migration?                                       |
| -------------------------------------- | --------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| `StyleSample.embedding`                | `types/twin/index.ts:188`                           | `number[]` (optional)            | None — JSON-nested in `twinProfile.styleSamples` |
| `TwinSettings.ragMinScore`             | `types/twin/index.ts:391`                           | `number` (optional, default 0.3) | None — extends an existing optional record       |
| `TwinSettings.ragMmrLambda`            | same                                                | `number` (optional, default 0.5) | None                                             |
| `TwinSettings.styleMmrLambda`          | same                                                | `number` (optional, default 0.7) | None                                             |
| `StoredMessage.metadata.twinCitations` | runtime-only field on existing free-form `metadata` | `TwinCitations` (see below)      | None                                             |

```ts
// New runtime type — lib/twin/runtime/citations.ts
export interface TwinCitations {
  retrievedChunks: Array<{
    chunkId: string
    sourceId: string
    sourceTitle?: string
    /** Coarse bucket: "highly" | "moderately" | "loosely". */
    relevance: "high" | "medium" | "low"
    /** First 200 chars of the un-redacted chunk for hover preview. */
    preview: string
  }>
  styleSampleCount: number
  degraded: boolean
  degradedReason?: string
}
```

## Reuse map

| Existing asset                                             | Path                                                                                           | Used by                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `tryBuildTwinDeps`                                         | `hooks/chat/use-claude-chat.ts:314` (today) → `lib/twin/runtime/build-deps.ts` (after extract) | A1 single-char hook + team-chat hook               |
| `applyTwinContext`                                         | `lib/twin/runtime/apply-twin-context.ts`                                                       | Extended with optional `precomputedQueryEmbedding` |
| `appendStyleSamples`                                       | `lib/db/twin-profile.ts:60`                                                                    | Extended with optional `embeddingFn` parameter     |
| `selectFewShotSamples`                                     | `lib/twin/runtime/few-shot-selector.ts`                                                        | Fallback branch removed; MMR added                 |
| `Sources` / `SourcesTrigger` / `SourcesContent` / `Source` | `components/ai-elements/sources.tsx`                                                           | A4 mounts these (currently zero consumers in chat) |
| `Collapsible` / `Dialog` / `Tooltip`                       | `components/ui/*` (vendored shadcn)                                                            | A4 chunk-preview affordance                        |
| `IVectorStore.searchByEmbedding`                           | `lib/vector/store.ts` and 6 client implementations                                             | Extended with optional `embedding` in result rows  |
| `generateEmbedding` / `generateEmbeddings`                 | `lib/ai/embedding/embedding.ts`                                                                | A1 per-turn embed; A2 cache-write path             |

## New files

| Path                             | Reason for creation (vs. extending existing)                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/twin/runtime/build-deps.ts` | Two consumers (single-char + team chat); the helper is too long to duplicate; lifting it to a runtime sibling keeps it next to `apply-twin-context.ts` and out of UI hook code. |
| `lib/twin/runtime/mmr.ts`        | Pure algorithm with no obvious home — reused by both RAG and few-shot selectors; placing it on either selector causes a circular import.                                        |
| `lib/twin/runtime/citations.ts`  | Type definition + `buildCitationsFromApplied` factory. Pulled out so the renderer doesn't import all of `apply-twin-context.ts`.                                                |

No other new files. No new components. No new Dexie tables.

## Pipeline / runtime flow

### A1 — team chat send (per turn)

```
user sends in team chat
  └─ runTeam (hooks/chat/use-team-chat.ts)
       └─ for each round:
            ├─ tryBuildTwinDeps()                     ── once per turn
            ├─ generateEmbedding(userMessage, deps)   ── once per turn
            └─ for each twin-bound member:
                 └─ runMemberSubSession
                      └─ resolveSendOptions({
                           character,
                           twinDeps: deps,
                           twinUserMessage: msg,
                           precomputedQueryEmbedding: vec,  ← NEW (passed
                                                              through to
                                                              applyTwinContext)
                           twinAppliedSink,                 ← NEW (see A4)
                         })
                           └─ applyTwinContext  ── reuses pre-embed,
                                                   skips own embed
```

If a future member's `character.embeddingOverride` differs from the
team's runtime config, `resolveSendOptions` detects the mismatch and
falls back to per-member embed (this branch is dormant today; the
flag is wired so we don't need a refactor when per-character embed
configs land).

### A2 — style sample embedding cache

```
distill job-runner
  └─ orchestrator returns styleSamples (no embedding yet)
       └─ appendStyleSamples(twinId, samples, embeddingFn)
            ├─ embeddingFn batches summaries → embeddings
            └─ Dexie put with embeddings inline
```

Runtime path:

```
applyTwinContext
  └─ load profile
  └─ filter samples → those without `embedding`
       └─ batch-embed missing summaries
       └─ updateTwinProfile (write-back)
  └─ selectFewShotSamples({ samples, queryEmbedding })
       └─ MMR over (sample.embedding, queryEmbedding)
```

The lazy backfill is best-effort — failure leaves `embedding`
unset; the next turn retries. The selector returns `[]` (not random
fallback) when embeddings are still missing.

### A3 — MMR + threshold

```
applyTwinContext (RAG branch)
  └─ store.searchByEmbedding(collection, queryEmbedding, {
       limit: 2 × ragTopK,
       returnEmbedding: true,        ← optional, ignored by clients that can't
     })
  └─ filter hit.score < ragMinScore
  └─ selectMMR(remaining, queryEmbedding, ragTopK, ragMmrLambda)
       └─ if any hit lacks embedding → no-op; return score-sorted top-K
  └─ formatRetrievedChunks   (uses "highly/moderately/loosely", no raw score)
```

### A4 — citations

`resolveSendOptions` keeps returning `Promise<SendOptions>` (no
breakage for the 7 non-chat call sites — diagnostics, scheduler, the
in-tree test suites). Instead, it accepts an optional
`twinAppliedSink?: (applied: AppliedTemplate) => void` field on
`BuildOptionsContext`. When the chat hook sets it, the resolver
invokes it with the applied template right after `applyTwinContext`
returns. Non-chat callers omit the field; nothing changes for them.

```
chat hook:
  let captured: AppliedTemplate | undefined
  const opts = await resolveSendOptions({
    ...,
    twinAppliedSink: (a) => { captured = a },
  })
  // captured now holds the four-segment template's metadata
  // → buildCitations(captured) → attach to next assistant message

chat-event handler persists assistant StoredMessage with
  metadata.twinCitations: TwinCitations
message renderer:
  if (message.metadata?.twinCitations) {
    <Sources>
      <SourcesTrigger count={citations.retrievedChunks.length} />
      <SourcesContent>
        {chunks.map(c => <Source onClick={preview(c)}>{c.sourceTitle}</Source>)}
      </SourcesContent>
    </Sources>
    {citations.degraded && <DegradedNote reason={...} />}
  }
```

`Sources` is a `<Collapsible>` under the hood; default-collapsed.
Click on a `<Source>` opens a vendored `<Dialog>` showing
`citations.retrievedChunks[i].preview` in `<pre>` form. No new
component shells.

## Vector store interface extension

`IVectorStore.searchByEmbedding` returns `Array<SearchHit>` today.
Extend `SearchHit` with optional `embedding?: number[]`. Clients:

Each client honours `options.returnEmbedding === true` by setting
the corresponding backend flag below; default-`false` paths are
unchanged.

| Client              | Behaviour when `returnEmbedding: true`                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| Qdrant              | Set `with_vectors: true` on the search request; populate `embedding` from response. |
| Pinecone            | Set `includeValues: true`; populate from `values`.                                  |
| Milvus              | Set `output_fields: ["vector"]`; populate from response.                            |
| Weaviate            | Add `_additional { vector }` to the GraphQL query; populate.                        |
| Chroma              | Set `include: ["embeddings"]`; populate from response.                              |
| Native (sqlite-vec) | Read directly from the row.                                                         |

All six are backwards-compatible: callers that don't request the
field continue to work unchanged. Cost: the over-fetch is `2×topK`
hits with embedding bytes; for default `topK = 6` and 1536-dim
OpenAI vectors that's `12 × 1536 × 4 bytes ≈ 73 KB / turn`. Negligible.

## Behaviour-change summary

| Surface                                            | Before                                                | After                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Team chat with twin-bound member                   | systemPrompt = base character only                    | systemPrompt = full 4-segment twin prompt                                                                                     |
| First chat turn after distill (long-lived twin)    | ~150 ms (1× embed)                                    | ~150 ms unchanged + ~10 ms in-memory MMR                                                                                      |
| First chat turn after a fresh distill (cold cache) | ~150 ms (1× embed)                                    | ~150 ms + one batch embed of 5–15 style samples (~150 ms additional, **only** on the first turn — subsequent turns hit cache) |
| Distill cost per run                               | ~5 LLM calls + ⌈N/100⌉ knowledge calls                | unchanged + 5–15 embed calls (~$0.0001)                                                                                       |
| RAG context size                                   | top-K may include near-duplicates and low-score noise | MMR-deduplicated, score-filtered, no raw-score leak                                                                           |
| Assistant message UI                               | no provenance                                         | `<Sources>` collapsible + degraded note when applicable                                                                       |

## Testing

Each item ships with its own tests; coverage stays ≥90% per
`CLAUDE.md`. New tests added:

- `lib/twin/runtime/build-deps.test.ts` — settings → deps factory
  cases (incomplete config returns undefined; valid qdrant /
  pinecone / weaviate / milvus / chroma / native each builds the
  right `StoreConfig`).
- `lib/twin/runtime/mmr.test.ts` — λ = 0 (pure diversity), λ = 1
  (pure relevance), λ = 0.5 boundary; ties; empty input; missing
  embeddings degrade to score-only.
- `lib/twin/runtime/apply-twin-context.test.ts` extensions:
  - `precomputedQueryEmbedding` skips internal embed.
  - Hits with `score < ragMinScore` are filtered.
  - Near-duplicate hits collapse via MMR.
  - Style samples without embeddings → lazy backfill → write-back to
    Dexie.
- `lib/db/twin-profile.test.ts` extensions:
  - `appendStyleSamples` with `embeddingFn` writes embeddings inline.
  - `appendStyleSamples` without `embeddingFn` is unchanged
    (back-compat).
- `lib/twin/runtime/few-shot-selector.test.ts`:
  - Delete the `summary.length`-fallback test (the fallback is gone).
  - Add: missing embeddings return `[]` (caller responsible for
    triggering lazy backfill).
- `hooks/chat/use-team-chat.test.ts`:
  - Twin-bound member's send opts contain a 4-segment system prompt.
  - Two twin-bound members in one turn → embed called exactly once.
- `lib/vector/<client>.test.ts` (×6): `searchByEmbedding` returns
  `embedding` field when requested; unchanged when not.
- `components/ai-elements/sources.test.tsx`: existed shell tests plus
  new "renders count, expands, click opens preview".
- `components/chat/<message-renderer>.test.tsx`: twin metadata →
  Sources visible; degraded → note visible; absent metadata → no
  Sources.

Quality gate: `pnpm test:coverage` must report ≥90% lines/branches/
functions on every new and edited file.

## Rollout

Spec A is one logical change. Recommended commit sequence:

1. **A1 + extracted `build-deps.ts`** — narrow to "team chat is now
   twin-aware". Mergeable on its own; tests confirm behaviour.
2. **A2 — style embedding cache**. Mergeable; runtime improves
   silently (no UI surface).
3. **A3 — MMR + threshold + vector store interface bump**. The
   interface extension is the riskiest commit; isolating it makes
   bisection easier.
4. **A4 — citations UI**. Pure additive; no behavioural change to
   the model context.

Each commit ships green tests + green coverage gate.

## Open questions

None at design time. The only decision held back to implementation
is the exact mount point for `<Sources>` in the message renderer
(awaiting a quick prospect pass over `components/chat/*` and
`components/ai-elements/message.tsx`); this is a code-locator
question, not a design question.

## See also

- `docs/content/docs/adr/0003-employee-digital-twin.md` — origin ADR.
- `lib/twin/runtime/apply-twin-context.ts` — primary edit target.
- `hooks/chat/use-team-chat.ts:586` — A1 injection site.
- `components/ai-elements/sources.tsx` — A4 reuse target.
- (Future) `docs/superpowers/specs/2026-05-XX-twin-C-data-integrity-design.md`
- (Future) `docs/superpowers/specs/2026-05-XX-twin-B-distill-robustness-design.md`
- (Future) `docs/superpowers/specs/2026-05-XX-twin-D-lifecycle-and-ux-design.md`
