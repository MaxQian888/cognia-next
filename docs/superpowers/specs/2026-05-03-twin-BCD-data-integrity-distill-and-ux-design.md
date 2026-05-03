---
title: Spec BCD — Twin Data Integrity, Distill Robustness, and Lifecycle UX
description: Fix the silent ADR-promised behaviours that don't fire (redactionMap, fingerprint, paste-text, NAME hints), make distill provenance real, add segmented prompt + cache_control + token budget, and ship the binding/diagnostics UX that closes the twin loop end to end.
---

# Spec BCD — Twin Data Integrity, Distill Robustness, and Lifecycle UX

| Status       | Drafted                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| Date         | 2026-05-03                                                                          |
| Author       | brainstorm session w/ Max Qian                                                      |
| Builds on    | ADR-0003 + Spec A (Twin Runtime Quality, drafted same day)                          |
| Sequence     | Lands after Spec A; collapses the originally-planned Specs B + C + D into one       |
| Out of scope | Importer breadth; perf opt; per-twin runtime settings beyond `rehydratePiiInPrompt` |

## Context

Spec A (`2026-05-03-twin-A-runtime-quality-design.md`) addresses four
runtime-quality defects: team-chat injection, style few-shot via
embedding cache, MMR + score threshold, and citations via the existing
`<Sources>` component. Its implementation plan is already drafted and
in execution.

A code-level audit ahead of Spec A surfaced a second cluster of
problems that Spec A explicitly carves out as "data integrity (Spec C),
distill robustness (Spec B), lifecycle/UX (Spec D)":

1. **Silent data-integrity bugs.** Five ADR-promised behaviours are
   declared in the schema or comments but never actually fire in
   production:
   - `twinSources.redactionMapEnc` is in the schema but never written;
     `unredactText` round-trip is impossible.
   - `TwinSource.fingerprint` is set to `auto_${raw.id}` (a fresh
     random id per upload), defeating dedupe.
   - `twin-source-uploader.tsx` paste-text path writes the **title**
     into the `source` field instead of the body — the worker then
     ingests metadata as if it were content.
   - PII NAME redaction depends on `nameHints` but no caller populates
     them from the obvious sources (mbox `From`, `.eml` headers,
     Slack `users.json`).
   - `redact.ts` is correct but its output map is dropped on the
     floor in `lib/twin/ingest/job-runner.ts:107`.

2. **Distill provenance is fabricated.** `lib/twin/distill/job-runner.ts:104`
   stamps `chunks.slice(-10).map(c => c.id)` onto every draft's
   `provenance.chunkIds`, regardless of which chunks the synthesizer
   actually drew from. Drafts can't be audited; "see source" is a lie.

3. **Lifecycle UX is missing.** There is no UI affordance to **create**
   a twin (the workbench shows an empty state with no CTA), no way to
   **bind** an existing character to a twin (the field is set only via
   Drafts → Accept), no way to **retry** a failed source/job, and no
   way to **delete** a source. A user who wants to use the system today
   has to handcraft Dexie rows.

4. **No diagnostic surface for runtime correctness.** Spec A surfaces
   citations on the assistant message; that's the user-facing layer.
   There is no developer-facing layer ("what was the assembled prompt,
   what was the token breakdown, what made this turn degrade?") and
   without one, every regression in the twin runtime stays silent.

5. **No prompt-cache leverage and no token-budget enforcement.** The
   four-segment prompt is built as one big string and passed to the
   sidecar as `system: string`. Anthropic's prompt-cache won't catch the
   stable identity prefix without `cache_control` markers. The
   retrieved-chunks section has no per-prompt token budget — six 2 KB
   chunks blow the context window.

6. **No privacy-toggle for style fidelity.** Style few-shot samples
   carry `<EMAIL_001>` / `<NAME_002>` placeholders into the chat LLM,
   weakening tone match. Some users (self-twin) would accept rehydrating
   PII at chat time; some (predecessor's twin for a new hire) wouldn't.
   The toggle doesn't exist.

This spec fixes all of (1)–(6) under a single rollout, building on
Spec A's adopted decisions: **inline `StyleSample.embedding`**, **MMR**,
**reuse `<Sources>`**, **`twinAppliedSink` capture pattern**, and the
**`returnEmbedding` extension on `IVectorStore.searchByEmbedding`**.

## Goals

- Every silent ADR-promised behaviour fires in production, verifiable
  by the new diagnostics ring buffer.
- Drafts produced by distill carry **real** chunk provenance from the
  synthesizer's output; "see source" works.
- The workbench has a complete twin lifecycle: create → bind to a
  character → upload → ingest → distill → review → chat. No manual
  Dexie editing.
- The chat send path emits a **segmented** system prompt that the
  sidecar translates to Anthropic SDK with `cache_control: ephemeral`
  on the stable prefix; retrieved chunks honour a token budget.
- A privacy switch (`TwinSettings.rehydratePiiInPrompt`, default
  `false`) controls whether style-sample PII is restored at chat time.
- A diagnostic UI surfaces the assembled prompt, token breakdown,
  cache breakpoints, degraded reasons, and timing for the latest
  N=10 turns per twin.
- Zero behaviour change for non-twin chat sends. Every change is
  additive at the type + schema level.

## Non-goals

- ❌ Importer breadth (Slack one-source-per-channel, git-repo wired into
  the workbench, .pst, .json other shapes). Unchanged from current.
- ❌ Per-twin override UI for `ragMinScore` / `ragMmrLambda` /
  `styleMmrLambda`. Spec A wires the fields; only `rehydratePiiInPrompt`
  gets a UI surface here.
- ❌ Performance optimisation (parallel knowledge agent, incremental
  distill, batched lazy embed beyond what one Spec A turn already does).
- ❌ Standalone "Twins" management page. The workbench top-bar `select`
  is enough. C from the original four-spec roadmap had this; we deferred
  it as "not load-bearing for self-twin use".
- ❌ Scheduler / cron-driven retry. Manual "Retry" buttons only.
- ❌ Stronghold key-bootstrapping flow. Re-uses whatever
  `lib/security/stronghold` already exposes.

## Decisions

### 1. Data integrity (former Spec C)

#### 1.1 Paste-text writes content into `source`

`components/twin/twin-source-uploader.tsx:325` currently does:

```ts
source: title.trim() || "manual paste",
```

Change to:

```ts
source: content,
```

The `title` field already has its own slot. The field-name overload
("source = origin" vs "source = body text") is a long-standing footgun;
this fix aligns paste-text with the file path (which already does the
right thing on line 233).

#### 1.2 `fingerprint` is real sha256 of canonical content

`RawSource` gains an optional `fingerprint?: string`. The uploader and
each importer compute sha256 of the embeddable content **before**
calling `createTwinSource`. The ingest job-runner in
`lib/twin/ingest/job-runner.ts:76` stops generating `auto_${raw.id}`
fingerprints; if `raw.fingerprint` is set it's used verbatim, otherwise
the runner computes one from `raw.text || raw.binary`.

The uploader checks `findTwinSourceByFingerprint(twinId, fp)` before
the create call; on hit it shows a Sonner toast offering "Skip /
Replace / Add as duplicate" with **Skip** as the default. Fingerprint
collisions across different twins are not deduped (different twins are
different namespaces by design).

#### 1.3 `redactionMapEnc` actually persisted

Two new helpers in `lib/db/twin-sources.ts`:

```ts
saveRedactionMap(sourceId: string, map: Record<string, RedactionRecord>): Promise<void>
loadRedactionMap(sourceId: string): Promise<Record<string, RedactionRecord> | null>
```

The save path encrypts the map via `lib/security/stronghold` (existing
key, no bootstrap change), serialises as base64 JSON-of-ciphertext+
nonce+tag, and writes to `twinSources.redactionMapEnc`. The load path
decrypts on demand. Failure to encrypt (e.g. stronghold not initialised)
is **non-fatal**: the source still finishes parsing, but
`redactionMapEnc` stays empty and the runtime's γ rehydrate path will
later log `degraded: rehydrate-failed: no-map`.

The job-runner calls `saveRedactionMap` immediately after
`redactText` and before `prepareChunks`.

#### 1.4 NAME redaction transit

`RawSource` gains `nameHints?: string[]`. Importers populate them:

| Importer                                  | Source of hints                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `lib/twin/importers/email/mbox.ts`        | All distinct names found in `From:` / `To:` / `Cc:` headers across the message run                               |
| `lib/twin/importers/email/eml.ts`         | `From:` / `To:` / `Cc:` of the single message                                                                    |
| `lib/twin/importers/chat-export/slack.ts` | `users[].real_name` if `users.json` is present in the export, else `messages[].user_profile.real_name` if inline |
| (others — git-repo, file, paste)          | not in scope; emit empty hints                                                                                   |

`prepareChunks` already strips the heading-aware metadata; the new
hints flow alongside `RawSource` through `parseSource` →
`redactText(parsed.embeddableText, raw.nameHints ?? [])`. Hints are
de-duplicated by exact match (case-sensitive — `redactText` already
normalises during the regex scan).

#### 1.5 `lib/twin/ingest/job-runner.ts` cleanup

Delete the `void failJob` dead-code line and the `// TODO Phase 5
runIngestJobStrict` comment. This spec explicitly does not introduce
strict-fail semantics — per-source failure stays non-fatal and just
marks the row `failed`.

### 2. Distill robustness (former Spec B)

#### 2.1 Real `provenanceChunkIds` on every draft

The `Synthesizer` prompt in `lib/twin/distill/prompts.ts` gains a
**required** field per draft:

```jsonc
{
  "character": { ..., "sourceChunkIds": ["chunkId1", "chunkId2", ...] },
  "skills": [
    {
      ...,
      "sourcePlaybookId": "...",
      "sourceChunkIds": ["chunkId1", ...],
      "rationale": "..."
    }
  ]
}
```

`SynthDraft` (the orchestrator's output type) adds
`provenanceChunkIds: string[]`. The orchestrator passes the draft's
recent-chunks slice **with their ids visible** in the prompt body
(`[chunkId] body…` like `KNOWLEDGE_AGENT_PROMPT` already does).

`lib/twin/distill/job-runner.ts:104` stops using
`chunks.slice(-10).map(c => c.id)`. It writes
`provenance.chunkIds = draft.provenanceChunkIds`. If the synthesizer
returns an empty array (schema violation), the persisted provenance
is empty — drafts UI will then show "no source links" rather than
fake them. We don't fall back to "last 10". This is a hard correctness
break: old behaviour was a lie; absent provenance is honest.

#### 2.2 Style-sample embeddings (adopt Spec A's signature exactly)

Spec A introduced
`appendStyleSamples(twinId, samples, embeddingFn?)` that batch-embeds
`sample.summary` and writes the embeddings inline as
`StyleSample.embedding?: number[]` before the Dexie put. We **adopt**
this signature unchanged.

This spec adds: `runDistillJob` passes the worker's `embedding` config
through to `appendStyleSamples` as the `embeddingFn`. (Spec A's plan
already does this for runtime lazy backfill; we wire it up at distill
time so the cold-cache turn — which would otherwise embed 5–15 samples
on first chat — never has a cold cache for samples produced by the
distill itself.)

The Spec A inline-embedding decision **supersedes** the
parallel-`styleSampleEmbeddings: number[][]` array initially proposed
in this brainstorm. Result: zero schema migration, smaller diff.

#### 2.3 Distill knowledge-agent chunk ids in prompt

The chunk-id transit needs a small change to the `KnowledgeAgent` and
`Synthesizer` chunk serialisers — they must prefix each chunk with
`[chunkId]` in the prompt body so the LLM can echo the id back. This
already exists in the prompt template; verify the agent code calls
`applyTemplate` with the right id-bearing form (`prompts.test.ts`
extension).

### 3. Lifecycle UX (former Spec D)

#### 3.1 `TwinCreateDialog`

A new dialog with two fields:

- Display name (required, free text)
- Checkbox **"Also create a blank character bound to this twin"**
  (default checked — this is the path most users will take)

Submit:

1. Generate `twinId = nanoid()`.
2. If checkbox checked: `await createCharacter({ name, twinId,
systemPrompt: "" })`. The generated character takes the display
   name as its `name`.
3. Set `activeTwinId = twinId` on `TwinPanel` so the workbench
   immediately switches to the new twin.

The dialog is reachable from two places:

- `TwinPanel` empty state (replaces "No digital twins yet" plain
  text with a CTA).
- `TwinBindingPicker`'s "Create new..." option (see 3.3).

#### 3.2 `TwinBindingPicker`

A reusable `<select>`-shaped component:

```tsx
<TwinBindingPicker
  value={character.twinId ?? null}
  characterName={character.name}
  onChange={(nextTwinId: string | null) => void}
/>
```

Internal options:

- `(none)` — unbound; selecting it sets `twinId = undefined` on the
  character.
- One option per existing twin (display name + count of bound
  characters as a hint).
- `Create new twin...` — opens `TwinCreateDialog` with the auto-create
  checkbox **off** (we already have a character; don't make a second
  one), feeds the resulting `twinId` back via `onChange`.

The picker `useLiveQuery`s the same `useKnownTwins` set as the panel.

#### 3.3 Character editor exposes twin binding + γ switch

`components/settings/characters-section.tsx` (or wherever the
character editor lives) gains a "Twin (optional)" section:

```
Twin (optional)
[ TwinBindingPicker        ]

When bound:
  [ ] Enable RAG       topK [6]
  [ ] Enable few-shot   K  [3]
  [ ] Rehydrate PII in prompt
      ⚠ Sends original PII (emails, phone numbers, names) found in
        cited style samples to the chat LLM. Strict-default OFF.
```

The four checkboxes / numbers map 1:1 to `Character.twinSettings`.
Spec A's `ragMinScore` / `ragMmrLambda` / `styleMmrLambda` fields are
exposed only via per-twin defaults later (per Spec A's non-goals);
this character editor surface keeps the four headline knobs only.

#### 3.4 Source uploader: dedupe toast

In `handlePasteSubmit` and inside `ingestFile`, before
`createTwinSource`:

```ts
const existing = await findTwinSourceByFingerprint(twinId, fp)
if (existing) {
  // show Sonner toast with three actions: Skip / Replace / Add anyway
  // Skip is default
}
```

Replace = delete the old source row + cascade-delete its chunks +
remove vector docs (best-effort) + re-create with new content.
Add anyway = create with a `_dup_${counter}` suffix on the title.

#### 3.5 Sources tab: Retry + Delete

`components/twin/twin-sources-tab.tsx` (or wherever the sources list
renders) gets two row-level actions:

- **Retry** (visible when `status === "failed"`): clears
  `errorMessage` + sets `status = "pending"` + calls
  `enqueueIngestJob({ twinId, sourceIds: [source.id] })`.
- **Delete** (always visible, with `<AlertDialog>` confirm):
  - Query Dexie for `twinChunks` where `sourceId === source.id` →
    collect `vectorDocId`s.
  - Best-effort `store.deleteDocuments(vectorCollection, vectorDocIds)`
    (the existing `IVectorStore` method); failure is logged and
    ignored — local Dexie deletion proceeds either way.
  - Delete the `twinChunks` rows.
  - Delete the source row (which clears `redactionMapEnc` along with
    everything else).

#### 3.6 Jobs tab: Retry on failed jobs

A "Retry" button on `failed` jobs only. It re-enqueues a fresh job
with the same `kind` + `sourceIds` and leaves the failed job row in
place for audit (with a derived `retriedAsJobId` field — purely for
later forensics; not surfaced in the UI).

#### 3.7 `TwinPanel`: empty state + Diagnostics tab

- Empty state replaces the existing "No digital twins yet" card with
  the same message + a primary `Create twin` button (opens
  `TwinCreateDialog`).
- The Tabs row gains a fifth tab: `<TabsTrigger
value="diagnostics">Diagnostics</TabsTrigger>` rendering
  `<TwinDiagnosticsTab />`.

#### 3.8 `TwinDiagnosticsTab`

Renders the latest entries from the diagnostic ring buffer (see §4.4)
for the active twin.

Layout:

- Top: a `<Select>` listing the entries (newest first, label
  = `${characterName} · ${time}` + degraded badge if any).
- Body: four collapsible cards:
  - **Settings snapshot** — the `TwinSettings` value used for the
    turn, plus the workbench's `TwinRuntimeSettings` snapshot (vector
    backend, embedding model — but **not** API keys).
  - **Segments** — one panel per segment in the entry's `segments[]`
    array (canonically character / identity / retrieved / style; may
    also include appended segments for active mode and skills if the
    turn used them). Each panel shows `label`, `tokenCount`,
    `cacheBreakAfter`, and a `<pre>` of the segment text. Long
    segments are auto-collapsed past 30 lines with a "Show all".
  - **Retrieval** — table of retrieved chunks: `sourceTitle`,
    `relevance` (high/medium/low — same buckets Spec A introduces),
    `score` (numeric, hidden by default behind a toggle to keep the
    surface uncluttered), 200-char preview.
  - **Diagnostics** — `degradedReason` (full string), timings
    breakdown (embed / retrieve / select / assemble / total), token
    breakdown (per-segment + grand total).
- Top-right: `Clear history` button (clears for this twin only).

### 4. Cross-cutting capability adds

#### 4.1 Segmented system prompt + cache_control

`AppliedTemplate` (the return shape of `applySystemPromptTemplate`)
gains a `segments: SystemSegment[]` field. The existing `systemPrompt:
string` stays, equal to `segments.map(s => s.text).join("\n\n---\n\n")`,
so any caller that doesn't know about segments keeps working.

```ts
export type SegmentLabel =
  | "character"
  | "identity"
  | "retrieved"
  | "style"
  // Appended by build-options after the four twin segments. Shipped on
  // the same SystemSegment[] array so diagnostics can attribute every
  // byte of the prompt; sidecar treats them like any other segment.
  | "mode"
  | "skills"

export interface SystemSegment {
  label: SegmentLabel
  text: string
  tokenCount: number
  cacheBreakAfter: boolean
}
```

Cache-break placement:

- After **character** — segment = the user's authored persona; stable
  per character. Cache.
- After **identity** — segment = twin name + voiceSummary + entity
  dictionary; stable per profile mutation. Cache.
- After **retrieved** — segment = per-turn chunks; **not** stable, but
  we cache anyway because Anthropic's ephemeral cache is opportunistic
  and the breakpoint is a hint, not a guarantee. (For repeat questions
  in the same session this _can_ hit.) Cache.
- After **style** — never cache; per-turn churn.
- After **mode** / **skills** (if appended by build-options) — never
  cache; both can change at any turn.

If a segment's text is empty, it's elided from the array entirely
(zero-length segments don't get a cache marker).

#### 4.2 Sidecar protocol upgrade

`SendOptions.systemPrompt` extends from `string` to `string |
SystemSegment[]`:

```ts
export interface SendOptions {
  systemPrompt?: string | SystemSegment[]
  // ... unchanged
}
```

`SystemSegment` lives in `lib/claude/types.ts` as a duplicate of the
runtime type (the runtime cannot import from the claude module due to
build-options.ts's type-cycle avoidance, see Spec A `build-deps.ts`
extraction).

Rust sidecar (`src-tauri/`):

- `SendOptions::system_prompt` becomes an enum:
  ```rust
  enum SystemPromptInput {
    Plain(String),
    Segmented(Vec<SystemSegment>),
  }
  ```
- Translation:
  - `Plain(s)` → Anthropic SDK `system: "<s>"` (string form).
  - `Segmented(segs)` → Anthropic SDK `system: [
  { type: "text", text: seg.text,
    cache_control: { type: "ephemeral" } if seg.cache_break_after else null
  }, ...
]`.
- Empty `text` segments are skipped (don't emit `type: "text", text: ""`).
- Empty `Vec` (zero segments) is treated as no system prompt.

No capability negotiation needed. The frontend and sidecar ship in
lockstep as one Tauri build artifact — there is no rolling-upgrade
window where an old sidecar receives new-shape payloads from a new
frontend. The Rust enum uses `#[serde(untagged)]` on
`SystemPromptInput`, so both `String` and `Vec<SystemSegment>` JSON
shapes deserialise correctly. Test fixtures cover both shapes; the
backwards-compatible widening exists for in-tree consumers (tests,
diagnostics, scheduler executors) that may keep emitting the
string-only shape during incremental migration.

#### 4.3 Token budget on retrieved section

`applySystemPromptTemplate` accepts a new option:

```ts
maxRetrievedTokens?: number  // default 8000
```

The retrieved-section assembly:

1. Sort retrieved chunks by score descending (Spec A's MMR has
   already reranked, so the order is final).
2. Iterate, accumulating `tokenCount`. While
   `accumulated + chunk.tokenCount <= maxRetrievedTokens × 0.9`
   (10% safety margin against tokenizer drift), include the chunk.
3. Skipped chunks land in `metadata.skippedChunkIds` — diagnostics
   exposes this.

The voiceSummary cap (200 chars) and entity-list cap (20 entries)
already in `system-prompt-template.ts` are unchanged.

#### 4.4 `TwinRuntimeMetadata` enriched + Diagnostics ring buffer

`AppliedTemplate.metadata` extends to:

```ts
{
  twinName: string
  retrievedChunkIds: string[]
  styleSampleIds: string[]
  // NEW (this spec):
  segments: SystemSegment[]
  /** Per-segment token totals. Keys mirror SegmentLabel; absent labels
   *  mean the segment was elided this turn. `total` is always present. */
  tokenBreakdown: Partial<Record<SegmentLabel, number>> & { total: number }
  timings: { embedMs: number; retrieveMs: number; selectMs: number; assembleMs: number; totalMs: number }
  skippedChunkIds: string[]
}
```

Spec A's `twinAppliedSink: (applied: AppliedTemplate) => void` already
captures the full `applied` object — this spec extends what's inside
the object, not the sink signature. Spec A's `TwinCitations` shape
(persisted on the assistant message) is **unchanged** by this spec.

A new module `lib/db/twin-diagnostics.ts` and a new Dexie table
`twinDiagnostics` (schema v14 → v15, additive — no migration of
existing rows):

```ts
twinDiagnostics: "&id, twinId, characterId, createdAt, [twinId+createdAt]"
```

Helpers:

```ts
pushTwinDiagnosticEntry(entry: TwinDiagnosticEntry): Promise<void>
listRecentTwinDiagnostics(twinId: string, limit?: number): Promise<TwinDiagnosticEntry[]>
clearTwinDiagnostics(twinId: string): Promise<void>
```

`pushTwinDiagnosticEntry` keeps the newest **N=10 per twin**;
older entries are deleted on each push. This is best-effort and
non-blocking — failure logs `loggers.scheduler.warn` and doesn't
affect the chat send.

The chat hook (Spec A introduces `twinAppliedSink`; this spec extends
its body):

```ts
twinAppliedSink: (applied) => {
  capturedApplied = applied // for citations (Spec A)
  void pushTwinDiagnosticEntry(buildEntryFrom(applied, ctx)) // for diagnostics (this spec)
}
```

`twinDiagnostics` is **excluded from `BackupPackageV3`** — it's
developer surface, not user data. Confirmed by adding the table id to
the exclusion list in `lib/data/backup.ts`.

#### 4.5 γ rehydrate switch

`TwinSettings` extends:

```ts
export interface TwinSettings {
  enableRag: boolean
  ragTopK: number
  enableStyleFewShot: boolean
  styleSamplesK: number
  // Spec A wires these (but keeps them DEFERRED in non-goals):
  ragMinScore?: number
  ragMmrLambda?: number
  styleMmrLambda?: number
  // This spec adds:
  rehydratePiiInPrompt: boolean
}

export const DEFAULT_TWIN_SETTINGS: TwinSettings = {
  enableRag: true,
  ragTopK: 6,
  enableStyleFewShot: true,
  styleSamplesK: 3,
  rehydratePiiInPrompt: false,
}
```

Runtime path in `applyTwinContext`:

1. After `selectFewShotSamples` returns the chosen samples, check
   `settings.rehydratePiiInPrompt`.
2. If `true`: for each chosen sample, look up
   `loadRedactionMap(sample.sourceId)` (cache by `sourceId` per turn —
   the same source's map can be reused across multiple selected
   samples). Run `unredactText(sample.original, map)` to produce the
   plaintext version used in the prompt. Tag
   `metadata.styleSamples[i].rehydrated = true`.
3. Failure path (map missing, decrypt fails, or stronghold not
   initialised): leave the sample as-is (redacted), set
   `result.degraded = true, degradedReason = "rehydrate-failed:
<cause>"`. ✦ Critical invariant: **never** send original PII when
   rehydrate was requested but couldn't be safely completed.

The character editor's checkbox carries a 🔶 warning text (see §3.3).
The setting is a **per-character** opt-in, not a per-twin one — this
matches the existing `TwinSettings` location on `Character`.

#### 4.6 `degraded` no longer silent on `searchByEmbedding` shape

Today `apply-twin-context.ts:123` checks
`if (settings.enableRag && queryEmbedding && deps.store.searchByEmbedding)`.
When `searchByEmbedding` is undefined, RAG silently does nothing.
Change to:

```ts
if (settings.enableRag && queryEmbedding) {
  if (!deps.store.searchByEmbedding) {
    degraded = true
    degradedReason = "store-no-search-by-embedding"
  } else {
    try { ... } catch (err) { degraded = true; degradedReason = `retrieve-failed: ${err.message}` }
  }
}
```

## Data model changes

| Field                                                                           | Where                                        | Type                                                   | Migration?                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- | ------------------------------------ |
| `TwinSource.fingerprint`                                                        | `types/twin/index.ts:81`                     | unchanged shape; values switch from `auto_*` to sha256 | None — shape unchanged; behaviour change only |
| `TwinSource.redactionMapEnc`                                                    | `types/twin/index.ts:103`                    | unchanged; starts being **written**                    | None                                          |
| `RawSource.fingerprint`                                                         | `lib/twin/ingest/parse.ts`                   | `string?` (new)                                        | None — ingest-internal                        |
| `RawSource.nameHints`                                                           | same                                         | `string[]?` (new)                                      | None                                          |
| `TwinSettings.rehydratePiiInPrompt`                                             | `types/twin/index.ts:391`                    | `boolean` (default false)                              | None — additive on per-character JSON record  |
| `Character.twinSettings.*`                                                      | `types/twin/index.ts` (via `Character`)      | unchanged                                              | None                                          |
| `AppliedTemplate.metadata.{segments, tokenBreakdown, timings, skippedChunkIds}` | `lib/twin/runtime/system-prompt-template.ts` | new fields                                             | Runtime-only; no Dexie surface                |
| `AppliedTemplate.metadata.styleSamples[i].rehydrated`                           | same                                         | `boolean`                                              | Runtime-only                                  |
| `SendOptions.systemPrompt`                                                      | `lib/claude/types.ts`                        | widened from `string` to `string                       | SystemSegment[]`                              | None — backwards-compatible widening |
| `SystemSegment`                                                                 | `lib/claude/types.ts`                        | new                                                    | None                                          |
| `TwinDraft.provenance.chunkIds`                                                 | `types/twin/index.ts:296`                    | unchanged shape; populated from synthesizer output     | None                                          |
| `SynthDraft.provenanceChunkIds`                                                 | `lib/twin/distill/agents/synthesizer.ts`     | new on internal type                                   | None                                          |
| `TwinDiagnosticEntry`                                                           | `types/twin/index.ts`                        | new                                                    | New Dexie table — additive                    |
| Dexie schema                                                                    | v14 → v15                                    | adds `twinDiagnostics` table                           | Additive — Dexie auto-migrates                |

## Reuse map

| Existing asset                                                                   | Path                                 | Used by                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `redactText` / `unredactText` / `hasNoLeakingPii`                                | `lib/twin/ingest/redact.ts`          | §1.3 + §1.4 + §4.5 (already correct, just newly called)         |
| `lib/security/stronghold`                                                        | (existing)                           | §1.3 saveRedactionMap encryption                                |
| `appendStyleSamples(twinId, samples, embeddingFn)`                               | Spec A introduces                    | §2.2 wires `embeddingFn` at distill time                        |
| `twinAppliedSink` callback in `BuildOptionsContext`                              | Spec A introduces                    | §4.4 piggy-backs to push diagnostics ring buffer                |
| `TwinCitations` runtime type                                                     | Spec A introduces                    | unchanged; this spec leaves §4.4 as a parallel diagnostic store |
| `<Sources>` / `<SourcesTrigger>` / `<SourcesContent>` / `<Source>`               | `components/ai-elements/sources.tsx` | citations layer (Spec A); this spec unchanged                   |
| `Tabs` / `Card` / `Dialog` / `AlertDialog` / `Select` / `Switch` / `Collapsible` | `components/ui/*`                    | UI sections (3.1, 3.2, 3.5, 3.7, 3.8)                           |
| `useLiveQuery`                                                                   | `dexie-react-hooks`                  | TwinDiagnosticsTab + TwinBindingPicker                          |
| `Sonner` `toast`                                                                 | already wired                        | dedupe toast (§3.4)                                             |
| `selectMMR` / `mmr.ts`                                                           | Spec A introduces                    | n/a — this spec doesn't touch MMR                               |
| `enqueueIngestJob` / `enqueueDistillJob`                                         | `lib/twin/{ingest,distill}`          | retry buttons (§3.5, §3.6)                                      |

## New files

| Path                                       | Why a new file (vs. extending existing)                                                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/db/twin-diagnostics.ts`               | Co-locates the new ring-buffer CRUD with sister twin DB modules; follows the one-table-per-file pattern of `twin-sources.ts` / `twin-profile.ts`.                                                                           |
| `lib/twin/runtime/token-counter.ts`        | Single thin wrapper around `@anthropic-ai/tokenizer` with a length-based fallback; used in §4.3 budget enforcement and §4.4 token breakdown. Sits in `runtime/` so non-runtime code never imports tokenizer (it's ~200 KB). |
| `components/twin/twin-create-dialog.tsx`   | New UI shell (§3.1). Co-located with the rest of the twin workbench.                                                                                                                                                        |
| `components/twin/twin-binding-picker.tsx`  | Reusable across the workbench, character editor, and any future surface (§3.2).                                                                                                                                             |
| `components/twin/twin-diagnostics-tab.tsx` | Single-responsibility tab implementation (§3.8).                                                                                                                                                                            |

No other new files. Spec A's `lib/twin/runtime/build-deps.ts`,
`lib/twin/runtime/mmr.ts`, `lib/twin/runtime/citations.ts` are
already provisioned by Spec A and unchanged here.

## Pipeline / runtime flow

### B1 — ingest with redactionMap + nameHints + fingerprint

```
uploader (or importer):
  fingerprint = sha256(content)
  if findTwinSourceByFingerprint(twinId, fp) → toast Skip/Replace/Add
  RawSource = { ..., fingerprint, nameHints }

ingest job-runner:
  → parseSource(raw)
  → redaction = redactText(parsed.embeddableText, raw.nameHints ?? [])
  → saveRedactionMap(sourceId, redaction.map)   ← NEW
  → prepareChunks
  → embed
  → persistChunks
  → updateTwinSource({ status: "parsed", chunkCount, parsedAt })
```

### B2 — distill with real provenance + sample embeddings

```
distill job-runner:
  → orchestrator runs 5 agents
  → orchestrator returns {
      styleSamples,                 // (no embeddings on these objects)
      synthesizedDrafts: [
        { ..., provenanceChunkIds }  // NEW: real ids from synthesizer
      ]
    }
  → appendStyleSamples(twinId, styleSamples, embeddingFn)   ← Spec A
  → appendPlaybooks(twinId, playbooks)
  → upsertEntities(twinId, entities)
  → bulkCreateTwinDrafts(synthesizedDrafts.map(d => ({
       ...,
       provenance: { chunkIds: d.provenanceChunkIds, ... }   ← NEW: real
    })))
```

### B3 — chat send with γ rehydrate + segments + diagnostics

```
chat hook:
  let captured: AppliedTemplate | undefined
  const { options } = await resolveSendOptions({
    ...,
    twinAppliedSink: (a) => {
      captured = a                                    // Spec A: citations
      void pushTwinDiagnosticEntry(                   // this spec: diagnostics
        buildDiagnosticEntry(a, ctx))
    },
  })
  // options.systemPrompt is now SystemSegment[] (or string fallback)
  sidecar.send(options)

resolveSendOptions:
  ↳ applyTwinContext:
       embed query   (timings.embedMs ↑)
       store.searchByEmbedding({ ..., returnEmbedding: true })  ← Spec A
       MMR rerank   ← Spec A
       selectFewShotSamples  ← Spec A (uses StyleSample.embedding)
       if settings.rehydratePiiInPrompt:
         per-source loadRedactionMap → unredactText(sample.original)
       applySystemPromptTemplate({ maxRetrievedTokens, countTokens, ... })
         → returns AppliedTemplate {
              segments: [character?, identity, retrieved?, style?],
              systemPrompt: segments.join,
              metadata: { ..., tokenBreakdown, timings, skippedChunkIds }
            }
       ↳ baseSystem = applied.segments  (passed as SystemSegment[])

  ↳ build SendOptions.systemPrompt:
       if active mode or skills: appended after `style` as plain segments
         (cacheBreakAfter: false on each)
       Mix is { systemPrompt: SystemSegment[] }

sidecar:
  Plain(s) → SDK system: "<s>"
  Segmented(segs) → SDK system: [{type, text, cache_control? }]
```

### B4 — diagnostics view

```
TwinDiagnosticsTab:
  useLiveQuery(() => listRecentTwinDiagnostics(twinId))
  user picks an entry from the dropdown
  → renders 4 cards: Settings / Segments / Retrieval / Diagnostics
```

## Behaviour-change summary

| Surface                                         | Before                                                                       | After                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paste-text upload                               | Body field gets ingested as the title; chunks come from metadata not content | Body field gets ingested correctly                                                                                                                                  |
| Re-uploading the same file                      | Two source rows; double embed cost; double vector store usage                | First upload creates row; second upload triggers Skip/Replace/Add toast                                                                                             |
| `unredactText` for any source                   | Returns text unchanged — map was never written                               | Returns plaintext for sources whose redactionMap survived encryption                                                                                                |
| Slack / mbox / eml ingest                       | NAME redaction never fires (no hints transit)                                | NAME redaction fires for explicit From/To/speaker matches                                                                                                           |
| Distill drafts                                  | `provenance.chunkIds = chunks.slice(-10)` (lie)                              | Real ids from synthesizer; empty when synthesizer omits them (no fake fallback)                                                                                     |
| Distill cost per run                            | ~5 LLM calls + ⌈N/100⌉ knowledge calls                                       | + the embed batch from Spec A's `appendStyleSamples` (already counted in Spec A)                                                                                    |
| First chat turn after distill                   | Cold style cache → ~150 ms extra (Spec A)                                    | Warm style cache → no extra cost (this spec wires `embeddingFn` at distill)                                                                                         |
| Twin-bound chat send (single-char + team)       | systemPrompt = full string passed to sidecar; no cache markers               | systemPrompt = `SystemSegment[]`; sidecar marks cache breakpoints after character / identity / retrieved (3 breakpoints; style + appended skills/mode never cached) |
| Retrieved-section overflow                      | Six 2 KB chunks blow the context                                             | Token budget caps at 0.9 × 8000 = 7200 tokens; overflow chunks listed in `skippedChunkIds`                                                                          |
| Style few-shot PII                              | Always sent as `<EMAIL_001>` etc.                                            | Per-character toggle; default unchanged (placeholders); opt-in rehydrate to plaintext                                                                               |
| `searchByEmbedding` not implemented by store    | Silent — RAG produces no chunks, no `degraded` flag                          | `degraded: true, reason: store-no-search-by-embedding`                                                                                                              |
| Workbench empty state                           | "No digital twins yet" plain card                                            | Card + "Create twin" button → create dialog                                                                                                                         |
| Existing character → bind to twin               | Edit Dexie row by hand                                                       | Character editor's `TwinBindingPicker`                                                                                                                              |
| Failed source / job                             | Row stays failed forever                                                     | Retry button re-enqueues                                                                                                                                            |
| Workbench → "what just happened" inspectability | None                                                                         | Diagnostics tab shows last 10 turns, fully expanded                                                                                                                 |
| BackupPackageV3                                 | unchanged                                                                    | unchanged (twinDiagnostics excluded by id)                                                                                                                          |

## Testing

Coverage gate ≥ 90% lines/branches/functions per CLAUDE.md, on every
new and edited file.

### New test files (1:1 with new sources)

| Test file                                       | Key assertions                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `lib/db/twin-diagnostics.test.ts`               | push N+1 → oldest deleted; per-twin LRU; clearTwinDiagnostics                                 |
| `lib/twin/runtime/token-counter.test.ts`        | tokenizer path + length-fallback path; non-ASCII; safety margin                               |
| `components/twin/twin-create-dialog.test.tsx`   | submit creates character iff checkbox; twinId is nanoid; switches active twin                 |
| `components/twin/twin-binding-picker.test.tsx`  | (none) / known twin / "Create new" three branches; onChange contract                          |
| `components/twin/twin-diagnostics-tab.test.tsx` | empty state; renders 4 cards; selecting a different entry switches body; clear-history button |

### Existing test files extended

| Test file                                                                              | Extension                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/twin/ingest/job-runner.test.ts`                                                   | `saveRedactionMap` invoked with map; fingerprint reuses raw.fingerprint when set; nameHints transit through `redactText`                                                                |
| `lib/twin/importers/email/mbox.test.ts`                                                | output has nameHints from From/To/Cc, deduped                                                                                                                                           |
| `lib/twin/importers/email/eml.test.ts`                                                 | same                                                                                                                                                                                    |
| `lib/twin/importers/chat-export/slack.test.ts`                                         | nameHints from users.json or inline real_name                                                                                                                                           |
| `lib/twin/distill/orchestrator.test.ts`                                                | synthesizer mock returns provenanceChunkIds; orchestrator passes them out unchanged                                                                                                     |
| `lib/twin/distill/job-runner.test.ts`                                                  | drafts persisted with `provenance.chunkIds = synthesizer's ids` (NOT `chunks.slice(-10)`); `appendStyleSamples` called with embeddingFn                                                 |
| `lib/twin/distill/prompts.test.ts`                                                     | synthesizer prompt contains `[chunkId]` prefix in chunks block; sourceChunkIds field is required in schema                                                                              |
| `lib/twin/runtime/apply-twin-context.test.ts`                                          | γ on/off paths (rehydrate success + map-missing + decrypt-fail); `degraded` set on store-no-search; tokenBreakdown + timings present in metadata; skippedChunkIds populated on overflow |
| `lib/twin/runtime/system-prompt-template.test.ts`                                      | returns segments + systemPrompt; retrieved truncates at 0.9 × maxRetrievedTokens; cache markers present on character/identity/retrieved only                                            |
| `lib/db/twin-profile.test.ts`                                                          | n/a — Spec A already covers; verify no regression after this spec's `appendStyleSamples` callsite changes                                                                               |
| `lib/db/twin-sources.test.ts`                                                          | `saveRedactionMap` + `loadRedactionMap` roundtrip with stronghold mock; `findTwinSourceByFingerprint` hit/miss                                                                          |
| `lib/claude/build-options.test.ts`                                                     | `SystemSegment[]` passes through unchanged; non-twin path emits plain string; sink callback fires once with extended metadata                                                           |
| `components/twin/twin-source-uploader.test.tsx`                                        | paste-text writes `source: content`; fingerprint match → toast offered                                                                                                                  |
| `components/twin/twin-sources-tab.test.tsx`                                            | Retry on failed; Delete cascades to chunks + best-effort vector + map; AlertDialog confirms                                                                                             |
| `components/twin/twin-jobs-tab.test.tsx`                                               | Retry button enqueues fresh job; old row marked retried                                                                                                                                 |
| `components/twin/twin-panel.test.tsx`                                                  | empty state CTA opens create dialog; Diagnostics tab visible                                                                                                                            |
| `components/twin/twin-settings-tab.test.tsx`                                           | rehydratePiiInPrompt switch + warning text                                                                                                                                              |
| `components/settings/characters-section.test.tsx` (or wherever character editor lives) | TwinBindingPicker wired; rehydrate switch maps to twinSettings                                                                                                                          |

### Rust sidecar tests (`#[cfg(test)] mod tests` inline)

| Case                                                                 | Assertion                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Plain(string)`                                                      | system → string in SDK call                                      |
| `Segmented([{cache_break_after: true}, {cache_break_after: false}])` | first segment carries `cache_control: ephemeral`, second doesn't |
| Empty `Vec`                                                          | no system field on SDK call                                      |
| Segment with empty text                                              | skipped, not emitted as `text: ""`                               |
| All segments `cache_break_after: false`                              | system → array of plain text segments, no cache markers          |

### End-to-end smoke test

`lib/twin/twin-bcd-e2e.test.ts` (new) — uses all mocks and exercises:

1. createCharacter + bind twinId via picker mock
2. createTwinSource ×5 (one paste-markdown with PII placeholders, one
   mbox with nameHints, one duplicate-fingerprint of paste-markdown)
3. enqueueIngestJob → run worker → assert: 4 sources finished
   (5th was a fingerprint dupe and was Skip'd by uploader pre-check),
   redactionMapEnc populated, NAME-redacted text visible in chunks
4. enqueueDistillJob → run worker → assert: profile.styleSamples
   carry inline embeddings, drafts have `provenance.chunkIds.length > 0`
   matching the synthesizer mock's return
5. accept first draft → character row created with twinId already
   bound (matches Spec A's flow)
6. resolveSendOptions for that character → assert:
   - options.systemPrompt is `SystemSegment[]`
   - cache markers on character / identity / retrieved
   - twinAppliedSink fired once
   - pushTwinDiagnosticEntry persisted exactly one row
7. flip rehydratePiiInPrompt = true → re-send → assert:
   - prompt body contains plaintext (the redactionMap mock returns
     a plaintext for the placeholder)
   - styleSamples[i].rehydrated = true on metadata
8. simulate `searchByEmbedding` returning undefined →
   resolveSendOptions →
   assert: `degraded: true, reason: store-no-search-by-embedding`
   stamped on the diagnostic entry
9. listRecentTwinDiagnostics(twinId) returns the 3 entries from
   steps 6/7/8 in newest-first order

### Manual smoke (PR description, not CI)

A 3-minute hand-drive:

1. `pnpm dev` + open the workbench
2. From empty state click "Create twin" → enter "Self" → submit
3. Paste a snippet of personal markdown with a deliberate email
   address; check Sources tab shows it as `<EMAIL_001>` redacted
4. Run ingest, then distill (with valid LLM API key)
5. Open Drafts tab, pick the character draft, click Accept
6. Open the chat with the new character; ask "what's my email
   signature voice?"
7. Verify: `<Sources>` collapsible appears under the assistant's
   reply (Spec A); Diagnostics tab shows the assembled prompt with
   four segments and the cache-break markers; switching `rehydrate`
   on in the character editor + re-asking shows real plaintext in
   the styleSamples segment of the next entry.

## Rollout

Six phases, each independently mergeable; each ships green tests +
green coverage. Spec A's plan is already in flight (4 commits A1–A4);
this spec's phases land **after** Spec A's last commit (A4) — Spec A
introduces `<Sources>`, `appendStyleSamples(embeddingFn)`,
`twinAppliedSink`, and `IVectorStore.searchByEmbedding({ returnEmbedding })`,
all of which we depend on.

| #      | Phase                    | Content                                                                                                                                                                                                                                                                                                                                                            | Depends on                                            |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **C1** | Foundation               | Types: `TwinSettings.rehydratePiiInPrompt`, `SystemSegment`, `TwinDiagnosticEntry`, segment fields on `AppliedTemplate.metadata`. Dexie v15 with new `twinDiagnostics` table. CRUD modules: `twin-diagnostics.ts`; extend `twin-sources.ts` with `saveRedactionMap` / `loadRedactionMap` / `findTwinSourceByFingerprint`. New `lib/twin/runtime/token-counter.ts`. | Spec A merged                                         |
| **C2** | Data integrity           | §1 changes: paste-text fix, fingerprint sha256 + dedupe, `saveRedactionMap` on ingest, importer nameHints, dead-code cleanup.                                                                                                                                                                                                                                      | C1                                                    |
| **C3** | Distill robustness       | §2 changes: real `provenanceChunkIds` from synthesizer; `appendStyleSamples` callsite passes `embeddingFn`; prompt + agent tests updated.                                                                                                                                                                                                                          | C1 (no dependency on C2 — they touch different files) |
| **C4** | Cross-cutting capability | §4 changes: segmented `applySystemPromptTemplate`, token budget, sidecar protocol upgrade (untagged-enum widening), γ rehydrate handler in `apply-twin-context`. Diagnostics ring-buffer push wired into `twinAppliedSink`.                                                                                                                                        | C1                                                    |
| **C5** | Workbench UI             | §3.1 / 3.2 / 3.4 / 3.5 / 3.6 / 3.7 / 3.8 — `TwinCreateDialog`, `TwinBindingPicker`, source uploader dedupe toast, sources/jobs Retry/Delete buttons, Diagnostics tab in panel.                                                                                                                                                                                     | C1, C4                                                |
| **C6** | Chat integration + docs  | §3.3 — character editor wiring + γ switch surface; `BackupPackageV3` exclusion for `twinDiagnostics`; ADR-0003 rewrite (drop "Phase 8 opt-in"; add §4.4 + §4.5 sections); `docs/content/docs/{en,zh}/employee-twin.mdx` sync.                                                                                                                                      | C5                                                    |

Total: ~3 200 LOC including tests (smaller than the original
brainstorm estimate because Spec A absorbed the runtime-quality work).

### Milestones

- **M-Spec-A** (already in flight): Spec A's A1–A4 commits land. Twin
  becomes runtime-quality-correct in single-character + team chat.
- **M1 = C1 + C2 + C3** merged: every silent ADR-promised behaviour
  fires; data integrity + distill provenance restored. No UI surface
  yet, but the runtime is honest.
- **M2 = C4** merged: sidecar talks segmented system prompt, cache
  markers active, token budget enforced, γ rehydrate handler in place
  — but no UI to flip γ yet. Diagnostics ring buffer accumulates
  entries; tab not yet rendered.
- **M3 = C5 + C6** merged: workbench complete, character editor
  surface complete, docs updated. Public-facing release-notes
  milestone.

## Open questions

- **None blocking implementation.** Two soft decisions to revisit
  during execution:
  1. Whether to also expose `ragMinScore` / `ragMmrLambda` /
     `styleMmrLambda` in the character editor in C6 alongside the γ
     switch. Spec A's non-goals defer this; we keep deferring unless
     reviewer feedback says otherwise.
  2. Whether `<Sources>` and the Diagnostics tab should be enabled
     on a per-character basis (e.g. only twin-bound characters get
     either UI affordance) or always-on for any chat. Lean toward
     "always-on for twin-bound only" since both surfaces are noise on
     non-twin sends; revisit during C5 review if reviewers prefer
     unconditional rendering with empty-state guards.

## See also

- `docs/content/docs/adr/0003-employee-digital-twin.md` — origin ADR (this spec triggers a rewrite — see C6).
- `docs/superpowers/specs/2026-05-03-twin-A-runtime-quality-design.md` — Spec A.
- `docs/superpowers/plans/2026-05-03-spec-a-twin-runtime-quality.md` — Spec A's implementation plan (in flight).
- `lib/twin/ingest/job-runner.ts` — primary §1 edit target.
- `lib/twin/distill/job-runner.ts:104` — primary §2 edit target.
- `lib/twin/runtime/apply-twin-context.ts` — primary §4.5 / §4.6 edit target.
- `lib/twin/runtime/system-prompt-template.ts` — primary §4.1 / §4.3 edit target.
- `lib/claude/build-options.ts` — §4.2 sidecar protocol upgrade callsite.
- `components/twin/twin-panel.tsx` — primary §3.7 / §3.8 edit target.
- `src-tauri/src/lib.rs` — Rust-side sidecar protocol changes.
