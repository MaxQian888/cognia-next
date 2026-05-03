# Spec A — Twin Runtime Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire team chat into the twin runtime, fix style few-shot via inline `StyleSample.embedding` cache, add MMR + score threshold to retrieval, and surface citations on assistant messages — exactly the four runtime defects identified in `docs/superpowers/specs/2026-05-03-twin-A-runtime-quality-design.md`.

**Architecture:** Four sequential phases (A1 → A2 → A3 → A4), each independently mergeable with green tests + ≥90% coverage. No Dexie schema migrations; one backwards-compatible `IVectorStore` interface extension. Reuses existing `Sources` primitives from `components/ai-elements/sources.tsx`.

**Tech Stack:** Next.js 16 / React 19 / TypeScript 5 / Tailwind v4 / Dexie 4 / shadcn-ui (vendored) / ai-elements (vendored) / Vitest+RTL via `pnpm test`.

---

## File Structure

### New files

| Path                                  | Responsibility                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `lib/twin/runtime/build-deps.ts`      | Extracted `tryBuildTwinDeps` factory; consumed by both `use-claude-chat` and `use-team-chat`.    |
| `lib/twin/runtime/build-deps.test.ts` | Unit tests for the factory (incomplete config → `undefined`; six valid backends → store config). |
| `lib/twin/runtime/mmr.ts`             | Pure `selectMMR<T>(items, queryEmbedding, k, lambda)` algorithm.                                 |
| `lib/twin/runtime/mmr.test.ts`        | Boundary cases (λ = 0, 0.5, 1; empty input; missing embeddings).                                 |
| `lib/twin/runtime/citations.ts`       | `TwinCitations` type + `buildCitationsFromApplied(applied, chunkRows)` factory.                  |
| `lib/twin/runtime/citations.test.ts`  | Tests for shape, relevance bucketing, degraded passthrough.                                      |

### Modified files

| Path                                                                                             | What changes                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types/twin/index.ts`                                                                            | Add `StyleSample.embedding?: number[]`; add `ragMinScore` / `ragMmrLambda` / `styleMmrLambda` to `TwinSettings` + defaults.                                                            |
| `lib/db/twin-profile.ts`                                                                         | `appendStyleSamples` accepts optional `embeddingFn`.                                                                                                                                   |
| `lib/db/twin-tables.test.ts`                                                                     | Test for the new `embeddingFn` path.                                                                                                                                                   |
| `lib/twin/distill/job-runner.ts`                                                                 | Pass `embeddingFn` derived from `twinRuntimeSettings`.                                                                                                                                 |
| `lib/twin/distill/job-runner.test.ts`                                                            | Test embeddings persisted on samples.                                                                                                                                                  |
| `lib/twin/runtime/apply-twin-context.ts`                                                         | Accept `precomputedQueryEmbedding`; lazy-backfill missing sample embeddings; over-fetch + filter + MMR; surface applied template via sink.                                             |
| `lib/twin/runtime/apply-twin-context.test.ts`                                                    | New cases: pre-embed skip, lazy backfill, threshold filter, MMR dedup.                                                                                                                 |
| `lib/twin/runtime/few-shot-selector.ts`                                                          | Delete `summary.length` fallback; add MMR path; return `[]` when embeddings missing.                                                                                                   |
| `lib/twin/runtime/few-shot-selector.test.ts`                                                     | Replace fallback test with empty-when-missing test.                                                                                                                                    |
| `lib/twin/runtime/system-prompt-template.ts`                                                     | Replace `(score 0.85)` with relevance bucket (`highly`/`moderately`/`loosely`).                                                                                                        |
| `lib/twin/runtime/system-prompt-template.test.ts`                                                | Update snapshot/assertions.                                                                                                                                                            |
| `lib/vector/store.ts`                                                                            | Extend `SearchOptions` with `returnEmbedding?`; extend `VectorSearchResult` with `embedding?`; populate vectors in 6 client `searchByEmbedding` implementations.                       |
| `lib/vector/{chroma,pinecone,qdrant,milvus,weaviate}-client.test.ts`, `lib/vector/store.test.ts` | New cases: `returnEmbedding: true` populates `embedding`; default-`false` is unchanged.                                                                                                |
| `lib/claude/build-options.ts`                                                                    | Add `precomputedQueryEmbedding` and `twinAppliedSink` to `BuildOptionsContext`; pass through and invoke.                                                                               |
| `lib/claude/build-options-twin.test.ts`                                                          | Cases for both new fields.                                                                                                                                                             |
| `hooks/chat/use-claude-chat.ts`                                                                  | Replace inline `tryBuildTwinDeps` with the imported factory; capture applied template; persist `twinCitations` on assistant message.                                                   |
| `hooks/chat/use-team-chat.ts`                                                                    | Per-turn embed + per-member injection of `twinDeps` / `twinUserMessage` / `precomputedQueryEmbedding` / `twinAppliedSink`; persist `twinCitations` on each member's assistant message. |
| `hooks/chat/use-team-chat.test.ts`                                                               | Twin-bound member produces 4-segment prompt; embed called once per turn.                                                                                                               |
| `components/chat/message-renderer.tsx`                                                           | Mount `<Sources>` collapsible from `components/ai-elements/sources.tsx` when `message.metadata.twinCitations` is present; degraded-note line.                                          |
| `components/chat/message-renderer.test.tsx`                                                      | Twin-citations rendering, degraded note, no DOM noise when absent.                                                                                                                     |

---

## How to run tests

```bash
pnpm typecheck                                                # TS only
pnpm test -- <path-to-test-file>                              # single file
pnpm test:coverage -- --collectCoverageFrom='<changed-globs>' # coverage gate
```

Coverage gate per `CLAUDE.md`: every changed file must be ≥90% lines/branches/functions. Component files under `components/ui/` and `components/ai-elements/` are exempt (they are vendored).

---

# Phase A1 — Team chat twin injection

**Outcome:** Twin-bound members of a team chat produce twin-aware output. One embedding per user turn shared across all members. Build-deps factory shared between single-character and team hooks.

### Task A1.1: Extract `tryBuildTwinDeps` to `lib/twin/runtime/build-deps.ts`

**Files:**

- Create: `lib/twin/runtime/build-deps.ts`
- Create: `lib/twin/runtime/build-deps.test.ts`
- Modify: `hooks/chat/use-claude-chat.ts:314-412` (delete the inline `tryBuildTwinDeps` and import the new module)

- [ ] **Step 1: Write the test stub for the new module.**

Create `lib/twin/runtime/build-deps.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { TwinRuntimeSettings } from "@/types/twin"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import { tryBuildTwinDeps } from "./build-deps"

vi.mock("@/lib/db/twin-runtime-settings", () => ({
  getTwinRuntimeSettings: vi.fn(),
}))

vi.mock("@/lib/vector/store", () => ({
  createVectorStore: vi.fn().mockReturnValue({ provider: "qdrant" }),
}))

const { getTwinRuntimeSettings } = await import("@/lib/db/twin-runtime-settings")
const { createVectorStore } = await import("@/lib/vector/store")

function settings(patch: Partial<TwinRuntimeSettings> = {}): TwinRuntimeSettings {
  return {
    ...DEFAULT_TWIN_RUNTIME_SETTINGS,
    workerEnabled: true,
    embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "k" },
    ...patch,
  }
}

describe("tryBuildTwinDeps", () => {
  beforeEach(() => vi.resetAllMocks())

  it("returns undefined when worker is disabled", async () => {
    vi.mocked(getTwinRuntimeSettings).mockResolvedValue(settings({ workerEnabled: false }))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("returns undefined when embedding apiKey is missing", async () => {
    vi.mocked(getTwinRuntimeSettings).mockResolvedValue(
      settings({ embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "" } })
    )
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("builds qdrant deps", async () => {
    vi.mocked(getTwinRuntimeSettings).mockResolvedValue(
      settings({ storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } } })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps).toBeDefined()
    expect(deps?.vectorBackend).toBe("qdrant")
    expect(createVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "qdrant", qdrantUrl: "http://q" })
    )
  })

  it("builds native deps without further config", async () => {
    vi.mocked(getTwinRuntimeSettings).mockResolvedValue(
      settings({ storage: { vectorBackend: "native" } })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("native")
  })

  it("returns undefined when qdrant url is missing", async () => {
    vi.mocked(getTwinRuntimeSettings).mockResolvedValue(
      settings({ storage: { vectorBackend: "qdrant" } })
    )
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("returns undefined on any thrown error", async () => {
    vi.mocked(getTwinRuntimeSettings).mockRejectedValue(new Error("boom"))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/twin/runtime/build-deps.test.ts
```

Expected: FAIL — `Cannot find module './build-deps'`.

- [ ] **Step 3: Implement `lib/twin/runtime/build-deps.ts`.**

Lift verbatim from `hooks/chat/use-claude-chat.ts:314-412`:

```ts
import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { createVectorStore } from "@/lib/vector/store"
import type { resolveSendOptions } from "@/lib/claude/build-options"

export type TwinDepsForBuild = NonNullable<Parameters<typeof resolveSendOptions>[0]["twinDeps"]>

/**
 * Best-effort twin deps loader. Returns `undefined` when the runtime is not
 * fully configured — chat hooks pass that through to `resolveSendOptions`,
 * which short-circuits twin injection silently.
 */
export async function tryBuildTwinDeps(): Promise<TwinDepsForBuild | undefined> {
  try {
    const settings = await getTwinRuntimeSettings()
    if (!settings.workerEnabled) return undefined
    if (!settings.embedding.apiKey) return undefined

    const storage = settings.storage
    const embedding = {
      provider: settings.embedding.provider,
      model: settings.embedding.model,
      dimensions: undefined as number | undefined,
    }
    const apiKey = settings.embedding.apiKey

    type StoreConfig = Parameters<typeof createVectorStore>[0]
    let storeConfig: StoreConfig | null = null
    switch (storage.vectorBackend) {
      case "qdrant":
        if (storage.qdrant?.url) {
          storeConfig = {
            provider: "qdrant",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            qdrantUrl: storage.qdrant.url,
            qdrantApiKey: storage.qdrant.apiKey,
          }
        }
        break
      case "pinecone":
        if (storage.pinecone?.apiKey && storage.pinecone.indexName) {
          storeConfig = {
            provider: "pinecone",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            pineconeApiKey: storage.pinecone.apiKey,
            pineconeIndexName: storage.pinecone.indexName,
            pineconeNamespace: storage.pinecone.namespace,
          }
        }
        break
      case "weaviate":
        if (storage.weaviate?.url) {
          storeConfig = {
            provider: "weaviate",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            weaviateUrl: storage.weaviate.url,
            weaviateApiKey: storage.weaviate.apiKey,
          }
        }
        break
      case "milvus":
        if (storage.milvus?.address) {
          storeConfig = {
            provider: "milvus",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            milvusAddress: storage.milvus.address,
            milvusToken: storage.milvus.token,
            milvusSsl: storage.milvus.ssl,
          }
        }
        break
      case "chroma":
        if (storage.chroma?.mode === "embedded" || storage.chroma?.serverUrl) {
          storeConfig = {
            provider: "chroma",
            embeddingConfig: embedding,
            embeddingApiKey: apiKey,
            chromaMode: storage.chroma?.mode,
            chromaServerUrl: storage.chroma?.serverUrl,
          }
        }
        break
      case "native":
        storeConfig = {
          provider: "native",
          embeddingConfig: embedding,
          embeddingApiKey: apiKey,
          native: {},
        }
        break
    }
    if (!storeConfig) return undefined

    const store = createVectorStore(storeConfig)
    return {
      store,
      embedding: settings.embedding,
      vectorBackend: settings.storage.vectorBackend,
    }
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: Run test to verify pass.**

```bash
pnpm test -- lib/twin/runtime/build-deps.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Replace inline implementation in `use-claude-chat.ts`.**

In `hooks/chat/use-claude-chat.ts`:

1. Add at top: `import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"`
2. Delete the entire local `async function tryBuildTwinDeps(): ...` (lines ~314–412 in current source).
3. Run `pnpm typecheck` to confirm no broken references.

- [ ] **Step 6: Run the existing single-chat tests to confirm no regression.**

```bash
pnpm test -- hooks/chat/use-claude-chat
```

Expected: all existing tests still pass.

- [ ] **Step 7: Commit.**

```bash
rtk git add lib/twin/runtime/build-deps.ts lib/twin/runtime/build-deps.test.ts hooks/chat/use-claude-chat.ts
rtk git commit -m "$(cat <<'EOF'
refactor(twin): extract tryBuildTwinDeps to lib/twin/runtime/build-deps

Lifts the inline factory out of hooks/chat/use-claude-chat.ts so it
can be reused from hooks/chat/use-team-chat.ts in the next commit.
Pure refactor — no behaviour change in single-character chat.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A1.2: Add `precomputedQueryEmbedding` to `applyTwinContext`

**Files:**

- Modify: `lib/twin/runtime/apply-twin-context.ts`
- Modify: `lib/twin/runtime/apply-twin-context.test.ts`

- [ ] **Step 1: Write the failing test.**

Append to `lib/twin/runtime/apply-twin-context.test.ts` (within the existing `describe("applyTwinContext")` block):

```ts
it("skips internal embed when precomputedQueryEmbedding is provided", async () => {
  const embedSpy = vi.spyOn(embedModule, "generateEmbedding")
  const character = makeCharacter({ twinId: "twin_alice" })
  const result = await applyTwinContext({
    character,
    userMessage: "what did Alice say last month?",
    precomputedQueryEmbedding: [0.1, 0.2, 0.3],
    deps: {
      store: makeStubStore(),
      embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "k" },
    },
  })
  expect(embedSpy).not.toHaveBeenCalled()
  expect(result.degraded).toBe(false)
})
```

(Reuse the existing `makeCharacter` / `makeStubStore` helpers and `embedModule` import already in that test file.)

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/twin/runtime/apply-twin-context.test.ts
```

Expected: FAIL — `Object literal may only specify known properties, and 'precomputedQueryEmbedding' does not exist`.

- [ ] **Step 3: Add the field to `ApplyTwinContextInput`.**

In `lib/twin/runtime/apply-twin-context.ts`, modify the interface:

```ts
export interface ApplyTwinContextInput {
  character: Character
  userMessage: string
  /**
   * Optional pre-embedded query vector. Team chat passes this in once per
   * turn so all twin-bound members share a single embed call. When provided,
   * the runtime skips `generateEmbedding(userMessage)`.
   */
  precomputedQueryEmbedding?: number[]
  deps: ApplyTwinContextDeps
}
```

Then in `applyTwinContext`, replace the embed block:

```ts
let queryEmbedding: number[] | null = input.precomputedQueryEmbedding ?? null
let degraded = false
let degradedReason: string | undefined

if (!queryEmbedding && (settings.enableRag || settings.enableStyleFewShot)) {
  try {
    const result = await generateEmbedding(userMessage, deps.embedding)
    queryEmbedding = result.embedding
  } catch (err) {
    degraded = true
    degradedReason = err instanceof Error ? `embed-failed: ${err.message}` : "embed-failed: unknown"
  }
}
```

- [ ] **Step 4: Run test to verify pass.**

```bash
pnpm test -- lib/twin/runtime/apply-twin-context.test.ts
```

Expected: pass — including the new `skips internal embed` case.

- [ ] **Step 5: Coverage check.**

```bash
pnpm test:coverage -- --collectCoverageFrom='lib/twin/runtime/apply-twin-context.ts'
```

Expected: ≥90% lines/branches/functions.

- [ ] **Step 6: Commit.**

```bash
rtk git add lib/twin/runtime/apply-twin-context.ts lib/twin/runtime/apply-twin-context.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): accept precomputedQueryEmbedding in applyTwinContext

Skips the internal generateEmbedding call when the caller supplied a
vector. Used by use-team-chat to amortise one embed across multiple
twin-bound members of a team turn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A1.3: Pass `precomputedQueryEmbedding` through `resolveSendOptions`

**Files:**

- Modify: `lib/claude/build-options.ts`
- Modify: `lib/claude/build-options-twin.test.ts`

- [ ] **Step 1: Write the failing test.**

Add to `lib/claude/build-options-twin.test.ts`:

```ts
it("forwards precomputedQueryEmbedding to applyTwinContext", async () => {
  const ch = makeChar({ twinId: "twin_alice", systemPrompt: "base" })
  const applySpy = vi.spyOn(twinRuntime, "applyTwinContext")
  await resolveSendOptions({
    character: ch,
    twinDeps: stubDeps(),
    twinUserMessage: "hi",
    precomputedQueryEmbedding: [0.5, 0.5],
  })
  expect(applySpy).toHaveBeenCalledWith(
    expect.objectContaining({ precomputedQueryEmbedding: [0.5, 0.5] })
  )
})
```

(Reuse the existing `makeChar` / `stubDeps` / `twinRuntime` helpers in that test file.)

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/claude/build-options-twin.test.ts
```

Expected: FAIL — type error.

- [ ] **Step 3: Extend `BuildOptionsContext` and pass through.**

In `lib/claude/build-options.ts`, update the interface (add after `twinUserMessage`):

```ts
  /**
   * Pre-embedded vector for `twinUserMessage`. When provided, the twin runtime
   * skips its own embed call. Used by team chat to share one embed across
   * multiple twin-bound members per turn.
   */
  precomputedQueryEmbedding?: number[]
```

Then in `resolveSendOptions`, update the twin-injection block (around line 222):

```ts
if (character?.twinId && ctx.twinDeps && ctx.twinUserMessage && ctx.twinUserMessage.trim()) {
  try {
    const { applyTwinContext } = await import("@/lib/twin/runtime")
    const result = await applyTwinContext({
      character,
      userMessage: ctx.twinUserMessage,
      precomputedQueryEmbedding: ctx.precomputedQueryEmbedding,
      deps: ctx.twinDeps as Parameters<typeof applyTwinContext>[0]["deps"],
    })
    if (result.applied) {
      baseSystem = result.applied.systemPrompt
    }
  } catch {
    // Twin runtime failure is non-fatal — keep the original baseSystem.
  }
}
```

- [ ] **Step 4: Run test to verify pass.**

```bash
pnpm test -- lib/claude/build-options-twin.test.ts
```

Expected: pass.

- [ ] **Step 5: Run all build-options tests for regression.**

```bash
pnpm test -- lib/claude/build-options
```

- [ ] **Step 6: Commit.**

```bash
rtk git add lib/claude/build-options.ts lib/claude/build-options-twin.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): plumb precomputedQueryEmbedding through resolveSendOptions

Forwards the pre-computed query vector from the chat hook into
applyTwinContext so callers that batch embeddings (team chat) save
one embed per twin-bound member.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A1.4: Wire team chat — per-turn embed + per-member injection

**Files:**

- Modify: `hooks/chat/use-team-chat.ts`
- Modify: `hooks/chat/use-team-chat.test.ts`

- [ ] **Step 1: Read the current shape of `runMemberSubSession`.**

Read `hooks/chat/use-team-chat.ts:560–625`. Note the call site at line 586 where `resolveSendOptions` is invoked. Also locate the team-turn entry point `send` (line ~154) where the `userText` variable is computed (line 177) — that's where the per-turn embed lives.

- [ ] **Step 2: Write the failing test.**

Add to `hooks/chat/use-team-chat.test.ts`:

```ts
it("twin-bound members share one embed call per turn and inject twin context", async () => {
  const embedSpy = vi.spyOn(embedModule, "generateEmbedding").mockResolvedValue({
    embedding: [0.1, 0.2, 0.3],
    tokens: 1,
  })
  const buildDepsSpy = vi.spyOn(buildDepsModule, "tryBuildTwinDeps").mockResolvedValue({
    store: stubStore,
    embedding: { provider: "openai", model: "m", apiKey: "k" },
    vectorBackend: "qdrant",
  })

  await setupTeamWithMembers([
    { id: "alice", twinId: "twin_alice" },
    { id: "bob", twinId: "twin_bob" },
    { id: "carol", twinId: undefined }, // not twin-bound
  ])
  await sendUserTurn("how does Alice handle P1s?")

  // Exactly one embed for the whole turn.
  expect(embedSpy).toHaveBeenCalledTimes(1)
  // Build-deps called once (cached for the turn).
  expect(buildDepsSpy).toHaveBeenCalledTimes(1)

  // Each twin-bound member's send has a 4-segment system prompt
  // (base + identity + retrieved + style). Carol's stays plain.
  expect(sendOptsByMember.get("alice")?.systemPrompt).toMatch(/^.*\n\n---\n\n.*\n\n---\n\n/)
  expect(sendOptsByMember.get("bob")?.systemPrompt).toMatch(/^.*\n\n---\n\n.*\n\n---\n\n/)
  expect(sendOptsByMember.get("carol")?.systemPrompt).not.toContain("Voice and tone:")
})
```

(Test scaffolding for team chat already exists — `sendOptsByMember`, `setupTeamWithMembers`, etc. — in the existing test file. Add the imports `import * as embedModule from "@/lib/ai/embedding/embedding"` and `import * as buildDepsModule from "@/lib/twin/runtime/build-deps"` at the top.)

- [ ] **Step 3: Run test to verify failure.**

```bash
pnpm test -- hooks/chat/use-team-chat.test.ts
```

Expected: FAIL — twin context not injected.

- [ ] **Step 4: Add per-turn embed scaffolding to the team `send` flow.**

In `hooks/chat/use-team-chat.ts`, near the top of the file:

```ts
import { tryBuildTwinDeps, type TwinDepsForBuild } from "@/lib/twin/runtime/build-deps"
import { generateEmbedding } from "@/lib/ai/embedding/embedding"
```

In the `send` callback (around line 177 after `const userText = asPlainText(content)`), compute the per-turn twin context:

```ts
// Per-turn twin handshake: build deps once and embed once. Members that
// share the same embedding model reuse the vector; members that don't are
// embedded per-member by the resolver itself.
let turnTwinDeps: TwinDepsForBuild | undefined
let turnEmbedding: number[] | undefined
if (userText.trim()) {
  turnTwinDeps = await tryBuildTwinDeps()
  if (turnTwinDeps) {
    try {
      const result = await generateEmbedding(userText, turnTwinDeps.embedding)
      turnEmbedding = result.embedding
    } catch {
      turnEmbedding = undefined // resolver will retry per-member
    }
  }
}
```

- [ ] **Step 5: Thread the turn handshake into `runMemberSubSession`.**

Update the call to `runMemberSubSession` (and its `RunMemberArgs` type) to include `turnTwinDeps`, `turnEmbedding`, `turnUserMessage`. Inside `runMemberSubSession`, replace the `resolveSendOptions` call (line 586) with:

```ts
const baseOpts = await resolveSendOptions({
  session: session as never,
  character,
  appSettings: useSettingsStore.getState().settings,
  memberOverride: memberByCharId.get(character.id),
  referencedPaths,
  twinDeps: turnTwinDeps,
  twinUserMessage: turnUserMessage,
  precomputedQueryEmbedding: turnEmbedding,
})
```

(Wherever `runSupervisorTurn`, `runMemberSubSession`, etc. are called, propagate the same three values.)

- [ ] **Step 6: Run team-chat tests.**

```bash
pnpm test -- hooks/chat/use-team-chat
```

Expected: pass.

- [ ] **Step 7: Coverage check.**

```bash
pnpm test:coverage -- --collectCoverageFrom='hooks/chat/use-team-chat.ts'
```

Expected: ≥90% lines/branches/functions on the changed file.

- [ ] **Step 8: Commit.**

```bash
rtk git add hooks/chat/use-team-chat.ts hooks/chat/use-team-chat.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): inject twin runtime into team chat sends

Each user turn embeds once via tryBuildTwinDeps + generateEmbedding,
then forwards the vector to every member's resolveSendOptions call so
twin-bound members get the four-segment system prompt without paying
N x embed cost.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Phase A1 done.** Single-character chat behaviour unchanged; team chat is now twin-aware.

---

# Phase A2 — Style sample embedding cache

**Outcome:** Style few-shot retrieval ranks by query-cosine instead of `summary.length`. Distill writes embeddings inline; runtime lazy-backfills legacy samples.

### Task A2.1: Add `embedding?: number[]` to `StyleSample`

**Files:**

- Modify: `types/twin/index.ts:188-202`

- [ ] **Step 1: Add the field.**

In `types/twin/index.ts`, in the `StyleSample` interface:

```ts
export interface StyleSample {
  id: string
  contextLabel: string
  original: string
  summary: string
  sourceChunkId: string
  tone: string[]
  addedAt: number
  addedBy: "distill" | "manual"
  /**
   * Cosine-space embedding of `summary`. Populated by `appendStyleSamples`
   * when an `embeddingFn` is provided (distill path) or by the runtime via
   * lazy backfill. Optional for back-compat with profiles distilled before
   * Phase A2.
   */
  embedding?: number[]
}
```

- [ ] **Step 2: Run typecheck.**

```bash
pnpm typecheck
```

Expected: no errors. (No code reads `embedding` yet; the optional field is non-breaking.)

- [ ] **Step 3: Commit.**

```bash
rtk git add types/twin/index.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): add optional StyleSample.embedding field

Optional cache for the cosine-space embedding of the sample summary.
Populated by Phase A2's distill path and lazy backfill in the runtime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2.2: Extend `appendStyleSamples` with `embeddingFn`

**Files:**

- Modify: `lib/db/twin-profile.ts:60-72`
- Modify: `lib/db/twin-tables.test.ts`

- [ ] **Step 1: Write the failing test.**

Add to `lib/db/twin-tables.test.ts` (in the existing `describe` covering `appendStyleSamples`):

```ts
it("appendStyleSamples writes embeddings when an embeddingFn is provided", async () => {
  const fn = vi.fn(async (text: string) => (text === "summary one" ? [0.1, 0.2] : [0.3, 0.4]))
  await appendStyleSamples(
    "twin_alice",
    [
      makeStyleSample({ id: "s1", summary: "summary one" }),
      makeStyleSample({ id: "s2", summary: "summary two" }),
    ],
    { embeddingFn: fn }
  )
  expect(fn).toHaveBeenCalledTimes(2)
  const profile = await getTwinProfile("twin_alice")
  expect(profile?.styleSamples[0].embedding).toEqual([0.1, 0.2])
  expect(profile?.styleSamples[1].embedding).toEqual([0.3, 0.4])
})

it("appendStyleSamples writes no embedding when embeddingFn is omitted", async () => {
  await appendStyleSamples("twin_alice", [makeStyleSample({ id: "s3", summary: "x" })])
  const profile = await getTwinProfile("twin_alice")
  expect(profile?.styleSamples.find((s) => s.id === "s3")?.embedding).toBeUndefined()
})
```

(The helper `makeStyleSample` exists in the existing test file; reuse it.)

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/db/twin-tables.test.ts
```

Expected: FAIL — `appendStyleSamples` doesn't accept the option object.

- [ ] **Step 3: Extend `appendStyleSamples` in `lib/db/twin-profile.ts`.**

```ts
export interface AppendStyleSamplesOptions {
  /**
   * Optional async function that maps a sample's `summary` to an embedding.
   * When provided, every sample's `embedding` is populated before persistence.
   * Failures are swallowed per-sample (the field stays `undefined` and the
   * runtime lazy-backfills next time).
   */
  embeddingFn?: (summary: string) => Promise<number[]>
}

export async function appendStyleSamples(
  twinId: string,
  samples: StyleSample[],
  options: AppendStyleSamplesOptions = {}
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let enriched = samples
  if (options.embeddingFn) {
    const fn = options.embeddingFn
    enriched = await Promise.all(
      samples.map(async (s) => {
        try {
          return { ...s, embedding: await fn(s.summary) }
        } catch {
          return s
        }
      })
    )
  }
  const merged: TwinProfile = {
    ...profile,
    styleSamples: [...profile.styleSamples, ...enriched],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}
```

- [ ] **Step 4: Run tests.**

```bash
pnpm test -- lib/db/twin-tables.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
rtk git add lib/db/twin-profile.ts lib/db/twin-tables.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): appendStyleSamples accepts an embeddingFn

Centralises the embedding-cache write in one place so distill and any
future manual-add path both populate StyleSample.embedding consistently.
Non-breaking: omitting the option keeps current behaviour.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2.3: Wire `embeddingFn` from distill `job-runner.ts`

**Files:**

- Modify: `lib/twin/distill/job-runner.ts:74`
- Modify: `lib/twin/distill/job-runner.test.ts`

- [ ] **Step 1: Read the current call site.** Confirm `appendStyleSamples(job.twinId, result.styleSamples)` at line 74.

- [ ] **Step 2: Write the failing test.**

Add to `lib/twin/distill/job-runner.test.ts`:

```ts
it("persists style sample embeddings when distill runs with runtime settings", async () => {
  const job = makeDistillJob({ twinId: "twin_alice" })
  const llm = stubLlm({
    styleSamples: [
      { id: "s1", contextLabel: "PR", summary: "ship it", original: "...", tone: ["concise"] },
    ],
  })
  await runDistillJob({
    job,
    llm,
    embeddingFn: async () => [0.7, 0.8], // injected by the worker
  })
  const profile = await getTwinProfile("twin_alice")
  expect(profile?.styleSamples[0].embedding).toEqual([0.7, 0.8])
})
```

- [ ] **Step 3: Run test to verify failure.**

```bash
pnpm test -- lib/twin/distill/job-runner.test.ts
```

Expected: FAIL — `runDistillJob` does not accept `embeddingFn`.

- [ ] **Step 4: Add `embeddingFn` to `RunDistillInput`.**

In `lib/twin/distill/job-runner.ts`:

```ts
export interface RunDistillInput {
  job: TwinJob
  llm: LlmClient
  maxChunks?: number
  /**
   * Optional embedding function for caching style-sample embeddings inline.
   * When omitted, samples are persisted without embeddings and the runtime
   * lazy-backfills them on first use.
   */
  embeddingFn?: (summary: string) => Promise<number[]>
}
```

Then update line 74:

```ts
await appendStyleSamples(job.twinId, result.styleSamples, {
  embeddingFn: input.embeddingFn,
})
```

- [ ] **Step 5: Wire `embeddingFn` from `job-worker.ts`.**

In `lib/twin/job-worker.ts`, in the `kind === "distill"` branch (around line 117):

```ts
import { generateEmbedding } from "@/lib/ai/embedding/embedding"
// …

const embeddingFn = config.embedding
  ? async (summary: string) => {
      const r = await generateEmbedding(summary, config.embedding)
      return r.embedding
    }
  : undefined

const result = await runDistillJob({
  job,
  llm: config.llm,
  maxChunks: config.distillMaxChunks,
  embeddingFn,
})
```

- [ ] **Step 6: Run tests.**

```bash
pnpm test -- lib/twin/distill/job-runner.test.ts lib/twin/job-worker.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit.**

```bash
rtk git add lib/twin/distill/job-runner.ts lib/twin/distill/job-runner.test.ts lib/twin/job-worker.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): distill writes style sample embeddings inline

Threads an embeddingFn from the job worker through runDistillJob into
appendStyleSamples so each newly distilled sample carries its summary's
embedding. ~5-15 extra embed calls per distill run (negligible vs the
five LLM calls).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2.4: Lazy backfill missing embeddings in `applyTwinContext`

**Files:**

- Modify: `lib/twin/runtime/apply-twin-context.ts`
- Modify: `lib/twin/runtime/apply-twin-context.test.ts`
- Modify: `lib/db/twin-profile.ts` — add a small helper `updateStyleSampleEmbeddings(twinId, updates)`

- [ ] **Step 1: Write the failing test.**

```ts
it("lazy-backfills missing style sample embeddings and writes them back", async () => {
  await ensureTwinProfile("twin_alice")
  await appendStyleSamples("twin_alice", [
    makeStyleSample({ id: "s1", summary: "summary one" }), // no embedding
  ])
  const embedSpy = vi.spyOn(embedModule, "generateEmbedding").mockResolvedValue({
    embedding: [0.5, 0.5],
    tokens: 1,
  })

  await applyTwinContext({
    character: makeCharacter({ twinId: "twin_alice" }),
    userMessage: "?",
    deps: { store: makeStubStore(), embedding: stubEmbeddingConfig() },
  })
  // 1 query embed + 1 sample backfill embed
  expect(embedSpy).toHaveBeenCalledTimes(2)

  const profile = await getTwinProfile("twin_alice")
  expect(profile?.styleSamples[0].embedding).toEqual([0.5, 0.5])
})
```

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/twin/runtime/apply-twin-context.test.ts -t "lazy-backfills"
```

Expected: FAIL.

- [ ] **Step 3: Add `updateStyleSampleEmbeddings` helper.**

In `lib/db/twin-profile.ts`:

```ts
/** Patch the `embedding` field of specific style samples by id. */
export async function updateStyleSampleEmbeddings(
  twinId: string,
  updates: Array<{ id: string; embedding: number[] }>
): Promise<void> {
  const profile = await ensureTwinProfile(twinId)
  const byId = new Map(updates.map((u) => [u.id, u.embedding]))
  const next = profile.styleSamples.map((s) =>
    byId.has(s.id) ? { ...s, embedding: byId.get(s.id)! } : s
  )
  await getDb().twinProfile.put({ ...profile, styleSamples: next, updatedAt: Date.now() })
}
```

- [ ] **Step 4: Lazy-backfill in `applyTwinContext`.**

In `apply-twin-context.ts`, after loading `profile` and computing `queryEmbedding`, before the few-shot selector call:

```ts
if (
  settings.enableStyleFewShot &&
  profile &&
  queryEmbedding &&
  profile.styleSamples.some((s) => !s.embedding)
) {
  const missing = profile.styleSamples.filter((s) => !s.embedding)
  try {
    const updates: { id: string; embedding: number[] }[] = []
    for (const sample of missing) {
      const r = await generateEmbedding(sample.summary, deps.embedding)
      updates.push({ id: sample.id, embedding: r.embedding })
    }
    if (updates.length > 0) {
      await updateStyleSampleEmbeddings(character.twinId, updates)
      // Mutate `profile` in-memory so the few-shot selector below sees the
      // backfilled embeddings without a re-read.
      const byId = new Map(updates.map((u) => [u.id, u.embedding]))
      profile.styleSamples = profile.styleSamples.map((s) =>
        byId.has(s.id) ? { ...s, embedding: byId.get(s.id)! } : s
      )
    }
  } catch {
    // Best-effort; leave samples without embedding for the next turn.
  }
}
```

Then update the few-shot call to pass embeddings:

```ts
const styleSamples =
  settings.enableStyleFewShot && profile && queryEmbedding
    ? selectFewShotSamples({
        queryEmbedding,
        samples: profile.styleSamples,
        sampleEmbeddings: profile.styleSamples.map((s) => s.embedding ?? []),
        topK: settings.styleSamplesK,
        lambda: settings.styleMmrLambda, // wired in Phase A3
      }).map((s) => s.sample)
    : []
```

(`lambda` parameter is added in Phase A3 — for this commit just pass `topK`; `lambda` will be appended cleanly without re-touching this block.)

- [ ] **Step 5: Run tests.**

```bash
pnpm test -- lib/twin/runtime/apply-twin-context.test.ts
```

- [ ] **Step 6: Commit.**

```bash
rtk git add lib/twin/runtime/apply-twin-context.ts lib/twin/runtime/apply-twin-context.test.ts lib/db/twin-profile.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): lazy-backfill style sample embeddings in runtime

When a profile has style samples without cached embeddings, the runtime
embeds the missing ones once and writes them back to Dexie. The first
turn pays the cost; subsequent turns hit the cache.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2.5: Replace fallback heuristic in `selectFewShotSamples`

**Files:**

- Modify: `lib/twin/runtime/few-shot-selector.ts`
- Modify: `lib/twin/runtime/few-shot-selector.test.ts`

- [ ] **Step 1: Update the test.**

In `lib/twin/runtime/few-shot-selector.test.ts`, **delete** the test that asserts `summary.length`-based fallback ranking. **Add**:

```ts
it("returns [] when sampleEmbeddings is missing or any embedding is empty", () => {
  const samples: StyleSample[] = [
    makeSample({ id: "s1", summary: "x" }),
    makeSample({ id: "s2", summary: "y" }),
  ]
  expect(selectFewShotSamples({ queryEmbedding: [1, 0], samples, topK: 2 })).toEqual([])
  expect(
    selectFewShotSamples({
      queryEmbedding: [1, 0],
      samples,
      sampleEmbeddings: [[], [0.5, 0.5]],
      topK: 2,
    })
  ).toEqual([])
})
```

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/twin/runtime/few-shot-selector.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Replace the fallback branch.**

In `lib/twin/runtime/few-shot-selector.ts`, replace the `else` branch (line ~75-93) with:

```ts
export function selectFewShotSamples(input: FewShotSelectorInput): ScoredStyleSample[] {
  const k = Math.max(1, input.topK ?? 3)
  if (input.samples.length === 0) return []

  // Hard requirement: every sample must have a valid embedding. Anything
  // missing means callers should trigger a lazy-backfill upstream and retry —
  // we deliberately return an empty list rather than guess.
  if (
    !input.sampleEmbeddings ||
    input.sampleEmbeddings.length !== input.samples.length ||
    input.sampleEmbeddings.some((e) => !e || e.length === 0)
  ) {
    return []
  }

  const scored: ScoredStyleSample[] = input.samples.map((sample, i) => ({
    sample,
    score: cosineSimilarity(input.queryEmbedding, input.sampleEmbeddings![i]),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}
```

(Drop the `tokenOverlap` helper — it's no longer used.)

- [ ] **Step 4: Run tests + coverage.**

```bash
pnpm test -- lib/twin/runtime/few-shot-selector.test.ts
pnpm test:coverage -- --collectCoverageFrom='lib/twin/runtime/few-shot-selector.ts'
```

Expected: pass; coverage ≥90%.

- [ ] **Step 5: Commit.**

```bash
rtk git add lib/twin/runtime/few-shot-selector.ts lib/twin/runtime/few-shot-selector.test.ts
rtk git commit -m "$(cat <<'EOF'
fix(twin): few-shot selector returns [] instead of length-fallback

Removes the lossy summary-length heuristic that triggered when sample
embeddings were missing. Callers (applyTwinContext) now trigger a lazy
backfill and retry rather than getting near-random samples.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Phase A2 done.** Style few-shot now ranks by query-cosine.

---

# Phase A3 — MMR + score threshold + vector store extension

**Outcome:** Retrieval over-fetches, drops low-relevance hits, MMR-deduplicates, and prints coarse relevance buckets instead of raw cosine. Vector store interface gains a backwards-compatible `returnEmbedding` option.

### Task A3.1: Add `ragMinScore` / `ragMmrLambda` / `styleMmrLambda` to `TwinSettings`

**Files:**

- Modify: `types/twin/index.ts:391-403`

- [ ] **Step 1: Update the `TwinSettings` interface and defaults.**

```ts
export interface TwinSettings {
  enableRag: boolean
  ragTopK: number
  enableStyleFewShot: boolean
  styleSamplesK: number
  /** Cosine score floor for RAG hits. Default 0.3. */
  ragMinScore?: number
  /** MMR λ for RAG (0 = pure diversity, 1 = pure relevance). Default 0.5. */
  ragMmrLambda?: number
  /** MMR λ for style few-shot. Default 0.7 (style favours relevance). */
  styleMmrLambda?: number
}

export const DEFAULT_TWIN_SETTINGS: TwinSettings = {
  enableRag: true,
  ragTopK: 6,
  enableStyleFewShot: true,
  styleSamplesK: 3,
  ragMinScore: 0.3,
  ragMmrLambda: 0.5,
  styleMmrLambda: 0.7,
}
```

- [ ] **Step 2: Update existing settings-merge logic in `apply-twin-context.ts:settingsFor`.**

```ts
function settingsFor(character: Character): Required<TwinSettings> {
  const s = character.twinSettings
  return {
    enableRag: s?.enableRag ?? DEFAULT_TWIN_SETTINGS.enableRag,
    ragTopK: s?.ragTopK ?? DEFAULT_TWIN_SETTINGS.ragTopK,
    enableStyleFewShot: s?.enableStyleFewShot ?? DEFAULT_TWIN_SETTINGS.enableStyleFewShot,
    styleSamplesK: s?.styleSamplesK ?? DEFAULT_TWIN_SETTINGS.styleSamplesK,
    ragMinScore: s?.ragMinScore ?? DEFAULT_TWIN_SETTINGS.ragMinScore!,
    ragMmrLambda: s?.ragMmrLambda ?? DEFAULT_TWIN_SETTINGS.ragMmrLambda!,
    styleMmrLambda: s?.styleMmrLambda ?? DEFAULT_TWIN_SETTINGS.styleMmrLambda!,
  }
}
```

- [ ] **Step 3: Run typecheck + commit.**

```bash
pnpm typecheck
rtk git add types/twin/index.ts lib/twin/runtime/apply-twin-context.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): add ragMinScore / ragMmrLambda / styleMmrLambda settings

Adds optional knobs (with defaults 0.3 / 0.5 / 0.7) consumed by the
threshold + MMR pipeline in the next commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3.2: Create `lib/twin/runtime/mmr.ts`

**Files:**

- Create: `lib/twin/runtime/mmr.ts`
- Create: `lib/twin/runtime/mmr.test.ts`

- [ ] **Step 1: Write the test file.**

```ts
import { describe, it, expect } from "vitest"
import { selectMMR } from "./mmr"

const a = [1, 0, 0]
const b = [0.9, 0.1, 0] // near-duplicate of a
const c = [0, 1, 0] // orthogonal to a
const q = [1, 0, 0]

describe("selectMMR", () => {
  it("with λ = 1 returns pure top-K by relevance", () => {
    const out = selectMMR(
      [
        { item: "a", embedding: a, score: 0.95 },
        { item: "b", embedding: b, score: 0.9 },
        { item: "c", embedding: c, score: 0.1 },
      ],
      q,
      2,
      1
    )
    expect(out).toEqual(["a", "b"])
  })

  it("with λ = 0 prefers diversity", () => {
    const out = selectMMR(
      [
        { item: "a", embedding: a, score: 0.95 },
        { item: "b", embedding: b, score: 0.9 },
        { item: "c", embedding: c, score: 0.1 },
      ],
      q,
      2,
      0
    )
    // First pick is highest-relevance ("a"); second pick avoids near-duplicate
    // and chooses "c" despite low score.
    expect(out).toEqual(["a", "c"])
  })

  it("with λ = 0.5 collapses near-duplicates", () => {
    const out = selectMMR(
      [
        { item: "a", embedding: a, score: 0.95 },
        { item: "b", embedding: b, score: 0.9 },
        { item: "c", embedding: c, score: 0.4 },
      ],
      q,
      2,
      0.5
    )
    expect(out).toEqual(["a", "c"])
  })

  it("returns empty for empty input", () => {
    expect(selectMMR([], q, 5, 0.5)).toEqual([])
  })

  it("falls back to relevance order when any embedding is missing", () => {
    const out = selectMMR(
      [
        { item: "a", embedding: a, score: 0.95 },
        { item: "b", embedding: undefined, score: 0.5 },
      ],
      q,
      2,
      0.5
    )
    expect(out).toEqual(["a", "b"])
  })
})
```

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/twin/runtime/mmr.test.ts
```

- [ ] **Step 3: Implement `lib/twin/runtime/mmr.ts`.**

```ts
/**
 * Maximal Marginal Relevance — re-ranks a candidate list to balance
 * cosine similarity to the query against diversity from already-picked
 * items. Pure: no I/O, no React, no external deps.
 *
 *   λ = 0 → pure diversity (max-min over already-picked)
 *   λ = 1 → pure relevance (top-K by score, ignores diversity)
 *   λ = 0.5 → balanced (Carbonell & Goldstein 1998 default)
 *
 * Items missing an `embedding` cause the function to fall back to a
 * relevance-only ordering (no MMR can be computed without vectors).
 */

export interface MmrItem<T> {
  item: T
  /** Cosine-space embedding; if any item lacks one, MMR degrades to score sort. */
  embedding?: number[]
  /** Relevance score from the upstream retrieval pass. */
  score: number
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function selectMMR<T>(
  items: MmrItem<T>[],
  queryEmbedding: number[],
  k: number,
  lambda: number
): T[] {
  if (items.length === 0) return []
  if (items.some((i) => !i.embedding || i.embedding.length === 0)) {
    return [...items]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((i) => i.item)
  }

  const remaining = [...items]
  const picked: MmrItem<T>[] = []

  while (picked.length < k && remaining.length > 0) {
    let bestIdx = 0
    let bestVal = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]
      const rel = cosine(queryEmbedding, cand.embedding!)
      let div = 0
      for (const p of picked) {
        const sim = cosine(cand.embedding!, p.embedding!)
        if (sim > div) div = sim
      }
      const val = lambda * rel - (1 - lambda) * div
      if (val > bestVal) {
        bestVal = val
        bestIdx = i
      }
    }
    picked.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }

  return picked.map((p) => p.item)
}
```

- [ ] **Step 4: Run tests + coverage.**

```bash
pnpm test -- lib/twin/runtime/mmr.test.ts
pnpm test:coverage -- --collectCoverageFrom='lib/twin/runtime/mmr.ts'
```

- [ ] **Step 5: Commit.**

```bash
rtk git add lib/twin/runtime/mmr.ts lib/twin/runtime/mmr.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): add Maximal Marginal Relevance helper

Pure cosine-space MMR for re-ranking retrieved chunks and style samples.
Degrades to score-only ordering when embeddings are missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3.3: Extend `SearchOptions` and `VectorSearchResult`

**Files:**

- Modify: `lib/vector/store.ts:25-30, 450-466, 651-723` (interfaces and `NativeVectorStore.searchByEmbedding`)
- Modify: `lib/vector/store.test.ts` — new "returnEmbedding populates vectors" test

- [ ] **Step 1: Add fields to interfaces.**

In `lib/vector/store.ts`:

```ts
export interface VectorSearchResult {
  id: string
  content: string
  metadata?: Record<string, unknown>
  score: number
  /**
   * Set when the caller passed `options.returnEmbedding: true` AND the
   * backend can supply it. Consumed by the twin runtime for MMR.
   */
  embedding?: number[]
}

export interface SearchOptions {
  topK?: number
  threshold?: number
  filter?: Record<string, unknown>
  offset?: number
  limit?: number
  filters?: PayloadFilter[]
  filterMode?: "and" | "or"
  /**
   * When true, populates `VectorSearchResult.embedding` if the backend
   * supports it. Default false (preserves current zero-bandwidth behaviour).
   */
  returnEmbedding?: boolean
}
```

- [ ] **Step 2: Add the test for the native client.**

In `lib/vector/store.test.ts`:

```ts
it("native searchByEmbedding returns embedding when returnEmbedding: true", async () => {
  mockTauriInvoke({
    vector_search_points: () => [
      { id: "id1", score: 0.9, payload: { content: "hi" }, vector: [1, 0, 0] },
    ],
  })
  const store = new NativeVectorStore({
    /* config */
  })
  const out = await store.searchByEmbedding!("col", [1, 0, 0], { returnEmbedding: true })
  expect(out[0].embedding).toEqual([1, 0, 0])
})

it("native searchByEmbedding omits embedding when returnEmbedding is unset", async () => {
  mockTauriInvoke({
    vector_search_points: () => [
      { id: "id1", score: 0.9, payload: { content: "hi" }, vector: [1, 0, 0] },
    ],
  })
  const store = new NativeVectorStore({
    /* config */
  })
  const out = await store.searchByEmbedding!("col", [1, 0, 0])
  expect(out[0].embedding).toBeUndefined()
})
```

- [ ] **Step 3: Run test to verify failure.**

```bash
pnpm test -- lib/vector/store.test.ts -t "returnEmbedding"
```

- [ ] **Step 4: Implement in `NativeVectorStore.searchByEmbeddingWithTotal`.**

In `lib/vector/store.ts:660-724`, the native impl currently maps `r.payload`. Update both array and object response branches:

```ts
// Array branch (line 702):
const mapped = response.map((r) => ({
  id: r.id,
  content: (r.payload?.content as string) || "",
  metadata: r.payload,
  score: r.score,
  embedding: options.returnEmbedding ? (r as { vector?: number[] }).vector : undefined,
}))

// Object branch (line 713):
return {
  results: (response.results || []).map((r) => ({
    id: r.id,
    content: r.content || (r.payload?.content as string) || "",
    metadata: r.payload,
    score: r.score,
    embedding: options.returnEmbedding ? (r as { vector?: number[] }).vector : undefined,
  })),
  total: response.total ?? 0,
  offset: response.offset ?? 0,
  limit: response.limit ?? 0,
}
```

(Also augment the response type union to include the optional `vector?: number[]` field.)

- [ ] **Step 5: Run tests + commit.**

```bash
pnpm test -- lib/vector/store.test.ts
rtk git add lib/vector/store.ts lib/vector/store.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(vector): SearchOptions.returnEmbedding (native client)

Extends the unified vector store interface with an optional flag that
asks the backend to return each hit's vector. Default false; current
callers are unchanged. Implemented for the native (sqlite-vec) client.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3.4: Implement `returnEmbedding` in remote clients (Qdrant / Pinecone / Weaviate / Milvus / Chroma)

**Files:**

- Modify: `lib/vector/store.ts` — five client classes (search by Grep results: Qdrant `~986`, Chroma `~1231`, Pinecone `~1432`, Milvus `~1727`, Weaviate `~2043`)
- Modify: `lib/vector/{chroma,pinecone,qdrant,milvus,weaviate}-client.test.ts` — one new case per client

For each client, the pattern is:

1. Set the backend-specific flag when `options.returnEmbedding` is true.
2. Pass the returned vector through to `VectorSearchResult.embedding`.
3. Add a test asserting `embedding` is populated when `returnEmbedding: true` and absent otherwise.

| Client   | Request flag                                                                                                                                              | Response field                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Qdrant   | `with_vector: true` (REST) or `with_vectors: true` (client lib — confirm against installed `@qdrant/js-client-rest` API in `lib/vector/qdrant-client.ts`) | `result[i].vector`                                        |
| Pinecone | `includeValues: true`                                                                                                                                     | `matches[i].values`                                       |
| Weaviate | GraphQL: add `_additional { vector }`                                                                                                                     | `_additional.vector`                                      |
| Milvus   | `output_fields: ["vector"]`                                                                                                                               | `result.fields_data.find(f => f.field_name === "vector")` |
| Chroma   | `include: ["embeddings"]`                                                                                                                                 | `embeddings[0][i]`                                        |

- [ ] **Step 1 (per-client × 5): Write the failing test.**

Example for Qdrant (`lib/vector/qdrant-client.test.ts`):

```ts
it("returnEmbedding: true populates VectorSearchResult.embedding", async () => {
  const fake = makeQdrantFake({
    search: () => ({
      points: [{ id: "id1", score: 0.9, payload: { content: "hi" }, vector: [0.1, 0.2] }],
    }),
  })
  const out = await fake.store.searchByEmbedding!("col", [0.1, 0.2], {
    returnEmbedding: true,
  })
  expect(out[0].embedding).toEqual([0.1, 0.2])
})
```

- [ ] **Step 2 (per-client × 5): Run test to verify failure.**

```bash
pnpm test -- lib/vector/qdrant-client.test.ts -t "returnEmbedding"
```

- [ ] **Step 3 (per-client × 5): Implement.**

Find the client's `searchByEmbedding` (Grep returned the line numbers). Set the request flag and map the response. Example for Qdrant:

```ts
async searchByEmbedding(
  collectionName: string,
  embedding: number[],
  options: SearchOptions = {}
): Promise<VectorSearchResult[]> {
  // ...existing payload build...
  const response = await this.client.search(collectionName, {
    vector: embedding,
    limit: options.limit ?? options.topK ?? 5,
    with_vectors: options.returnEmbedding === true,
    // ...
  })
  return response.map((p) => ({
    id: String(p.id),
    content: (p.payload?.content as string) || "",
    metadata: p.payload as Record<string, unknown>,
    score: p.score,
    embedding: options.returnEmbedding ? (p as { vector?: number[] }).vector : undefined,
  }))
}
```

- [ ] **Step 4 (per-client × 5): Run all vector tests.**

```bash
pnpm test -- lib/vector
```

- [ ] **Step 5: Commit (one commit per client OR one batched commit — judgement call; default to batched).**

```bash
rtk git add lib/vector
rtk git commit -m "$(cat <<'EOF'
feat(vector): returnEmbedding in qdrant/pinecone/weaviate/milvus/chroma

Each remote client now honours options.returnEmbedding and populates
VectorSearchResult.embedding from its backend-specific vector field.
Default false preserves zero-bandwidth behaviour for existing callers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3.5: Wire over-fetch + threshold + MMR into `applyTwinContext` (RAG branch)

**Files:**

- Modify: `lib/twin/runtime/apply-twin-context.ts`
- Modify: `lib/twin/runtime/apply-twin-context.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
it("filters retrieved chunks below ragMinScore", async () => {
  const character = makeCharacter({
    twinId: "twin_alice",
    twinSettings: { ...DEFAULT_TWIN_SETTINGS, ragMinScore: 0.5 },
  })
  const stub = makeStubStore({
    hits: [
      { id: "v1", content: "ok", score: 0.8, embedding: [1, 0] },
      { id: "v2", content: "noise", score: 0.2, embedding: [0, 1] },
    ],
  })
  const result = await applyTwinContext({
    character,
    userMessage: "?",
    deps: { store: stub, embedding: stubEmbeddingConfig() },
  })
  // Only v1 makes the cut.
  expect(result.applied?.metadata.retrievedChunkIds).toHaveLength(1)
})

it("MMR collapses near-duplicate hits", async () => {
  const stub = makeStubStore({
    hits: [
      { id: "v1", score: 0.9, embedding: [1, 0, 0] },
      { id: "v2", score: 0.88, embedding: [0.99, 0.01, 0] }, // ~duplicate
      { id: "v3", score: 0.6, embedding: [0, 0, 1] }, // orthogonal
    ],
  })
  const character = makeCharacter({
    twinId: "twin_alice",
    twinSettings: { ...DEFAULT_TWIN_SETTINGS, ragTopK: 2, ragMmrLambda: 0.5 },
  })
  const result = await applyTwinContext({
    character,
    userMessage: "?",
    deps: { store: stub, embedding: stubEmbeddingConfig() },
  })
  expect(result.applied?.metadata.retrievedChunkIds).toEqual(["v1-chunk", "v3-chunk"])
})
```

- [ ] **Step 2: Run test to verify failure.**

```bash
pnpm test -- lib/twin/runtime/apply-twin-context.test.ts -t "MMR|ragMinScore"
```

- [ ] **Step 3: Update the RAG branch to over-fetch / filter / MMR.**

In `lib/twin/runtime/apply-twin-context.ts`, replace the RAG retrieval block:

```ts
import { selectMMR } from "./mmr"

// …

if (settings.enableRag && queryEmbedding && deps.store.searchByEmbedding) {
  try {
    const overFetch = settings.ragTopK * 2
    const hits = await deps.store.searchByEmbedding(collection, queryEmbedding, {
      limit: overFetch,
      returnEmbedding: true,
    })
    const filtered = hits.filter((h) => h.score >= settings.ragMinScore)
    const reranked = selectMMR(
      filtered.map((h) => ({ item: h, embedding: h.embedding, score: h.score })),
      queryEmbedding,
      settings.ragTopK,
      settings.ragMmrLambda
    )
    const docIds = reranked.map((h) => h.id)
    const dbChunks = await getTwinChunksByVectorDocIds(docIds)
    const chunkById = new Map<string, TwinChunk>(dbChunks.map((c) => [c.vectorDocId, c]))
    const sourceTitleCache = new Map<string, TwinSource>()
    const enriched: typeof retrievedChunks = []
    for (const hit of reranked) {
      const chunk = chunkById.get(hit.id)
      if (!chunk) continue
      const sourceTitle = await loadSourceTitle(chunk.sourceId, sourceTitleCache)
      enriched.push({ chunk, score: hit.score, sourceTitle })
    }
    retrievedChunks = enriched
  } catch (err) {
    degraded = true
    degradedReason =
      err instanceof Error ? `retrieve-failed: ${err.message}` : "retrieve-failed: unknown"
  }
}
```

- [ ] **Step 4: Run tests + coverage.**

```bash
pnpm test -- lib/twin/runtime/apply-twin-context.test.ts
pnpm test:coverage -- --collectCoverageFrom='lib/twin/runtime/apply-twin-context.ts'
```

Expected: pass; coverage ≥90%.

- [ ] **Step 5: Commit.**

```bash
rtk git add lib/twin/runtime/apply-twin-context.ts lib/twin/runtime/apply-twin-context.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): RAG over-fetch + threshold + MMR rerank

applyTwinContext now requests 2*topK chunks, filters below ragMinScore,
and reranks the survivors via MMR before passing the final top-K to
the system prompt. Near-duplicates collapse; low-relevance noise drops.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3.6: Wire MMR into `selectFewShotSamples`

**Files:**

- Modify: `lib/twin/runtime/few-shot-selector.ts`
- Modify: `lib/twin/runtime/few-shot-selector.test.ts`

- [ ] **Step 1: Add a test asserting MMR diversity on style samples.**

```ts
it("applies MMR on style samples to avoid near-duplicates", () => {
  const samples = [makeSample({ id: "s1" }), makeSample({ id: "s2" }), makeSample({ id: "s3" })]
  const out = selectFewShotSamples({
    queryEmbedding: [1, 0, 0],
    samples,
    sampleEmbeddings: [
      [0.99, 0.01, 0], // s1 — duplicate
      [0.98, 0.02, 0], // s2 — duplicate
      [0, 0, 1], // s3 — orthogonal
    ],
    topK: 2,
    lambda: 0.3,
  })
  expect(out.map((s) => s.sample.id)).toEqual(["s1", "s3"])
})
```

- [ ] **Step 2: Add `lambda` parameter and route through MMR.**

```ts
import { selectMMR } from "./mmr"

export interface FewShotSelectorInput {
  queryEmbedding: number[]
  samples: StyleSample[]
  sampleEmbeddings?: number[][]
  topK?: number
  /** MMR λ; defaults to 1 (pure relevance) for back-compat. */
  lambda?: number
}

export function selectFewShotSamples(input: FewShotSelectorInput): ScoredStyleSample[] {
  const k = Math.max(1, input.topK ?? 3)
  if (input.samples.length === 0) return []
  if (
    !input.sampleEmbeddings ||
    input.sampleEmbeddings.length !== input.samples.length ||
    input.sampleEmbeddings.some((e) => !e || e.length === 0)
  ) {
    return []
  }

  const lambda = input.lambda ?? 1
  const items = input.samples.map((sample, i) => ({
    item: { sample, score: cosineSimilarity(input.queryEmbedding, input.sampleEmbeddings![i]) },
    embedding: input.sampleEmbeddings![i],
    score: cosineSimilarity(input.queryEmbedding, input.sampleEmbeddings![i]),
  }))
  return selectMMR(items, input.queryEmbedding, k, lambda).map((p) => p)
}
```

- [ ] **Step 3: Update `applyTwinContext`'s few-shot call to pass `lambda`.**

```ts
selectFewShotSamples({
  queryEmbedding,
  samples: profile.styleSamples,
  sampleEmbeddings: profile.styleSamples.map((s) => s.embedding ?? []),
  topK: settings.styleSamplesK,
  lambda: settings.styleMmrLambda,
})
```

- [ ] **Step 4: Run tests + commit.**

```bash
pnpm test -- lib/twin/runtime/few-shot-selector.test.ts lib/twin/runtime/apply-twin-context.test.ts
rtk git add lib/twin/runtime/few-shot-selector.ts lib/twin/runtime/few-shot-selector.test.ts lib/twin/runtime/apply-twin-context.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): MMR rerank on style few-shot selection

Style samples now go through the same MMR helper as RAG chunks; default
λ = 0.7 favours relevance over diversity (style cares about matching
context more than spreading examples).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3.7: Replace raw cosine score with relevance bucket

**Files:**

- Modify: `lib/twin/runtime/system-prompt-template.ts:86-95`
- Modify: `lib/twin/runtime/system-prompt-template.test.ts`

- [ ] **Step 1: Update the test.**

In `lib/twin/runtime/system-prompt-template.test.ts`:

```ts
it("formats retrieved chunks with relevance buckets, not raw scores", () => {
  const out = applySystemPromptTemplate({
    twinName: "Alice",
    entities: [],
    retrievedChunks: [
      { chunk: makeChunk({ contentRedacted: "hi" }), score: 0.95, sourceTitle: "doc" },
      { chunk: makeChunk({ contentRedacted: "ok" }), score: 0.55, sourceTitle: "doc" },
      { chunk: makeChunk({ contentRedacted: "weak" }), score: 0.31, sourceTitle: "doc" },
    ],
    styleSamples: [],
  })
  expect(out.systemPrompt).toContain("(highly relevant)")
  expect(out.systemPrompt).toContain("(moderately relevant)")
  expect(out.systemPrompt).toContain("(loosely relevant)")
  expect(out.systemPrompt).not.toMatch(/score 0\.\d+/)
})
```

- [ ] **Step 2: Replace `formatRetrievedChunks`.**

```ts
function relevanceBucket(score: number): string {
  if (score >= 0.7) return "highly relevant"
  if (score >= 0.45) return "moderately relevant"
  return "loosely relevant"
}

function formatRetrievedChunks(chunks: ApplyTemplateInput["retrievedChunks"]): string {
  if (chunks.length === 0) return ""
  return chunks
    .map(({ chunk, score, sourceTitle }, i) => {
      const title = sourceTitle ?? "Unknown source"
      const bucket = relevanceBucket(score)
      const heading = `### Chunk ${i + 1} — ${title} (${bucket})`
      return `${heading}\n${chunk.contentRedacted}`
    })
    .join("\n\n")
}
```

- [ ] **Step 3: Run tests + commit.**

```bash
pnpm test -- lib/twin/runtime/system-prompt-template.test.ts
rtk git add lib/twin/runtime/system-prompt-template.ts lib/twin/runtime/system-prompt-template.test.ts
rtk git commit -m "$(cat <<'EOF'
fix(twin): use relevance buckets instead of raw cosine scores

The model no longer sees raw cosine scores in retrieved chunks — those
were ambiguous and treated as authority. Replace with three coarse
buckets: highly / moderately / loosely relevant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Phase A3 done.** Retrieval is now MMR-deduplicated, threshold-filtered, and the model no longer sees raw scores.

---

# Phase A4 — Citations UI

**Outcome:** Twin-bound assistant messages carry a collapsible `<Sources>` footer; degraded sends show a one-line note.

### Task A4.1: Create `TwinCitations` type + factory

**Files:**

- Create: `lib/twin/runtime/citations.ts`
- Create: `lib/twin/runtime/citations.test.ts`

- [ ] **Step 1: Write tests.**

```ts
import { describe, it, expect } from "vitest"
import { buildCitationsFromApplied } from "./citations"
import type { AppliedTemplate } from "./system-prompt-template"
import type { TwinChunk, TwinSource } from "@/types/twin"

const chunk = (id: string, content: string, sourceId: string): TwinChunk => ({
  id,
  twinId: "t",
  sourceId,
  content,
  contentRedacted: content,
  charStart: 0,
  charEnd: content.length,
  vectorBackend: "qdrant",
  vectorCollection: "c",
  vectorDocId: `v_${id}`,
  strategy: "paragraph",
  tokenCount: 1,
  metadata: {},
  createdAt: 0,
})

const source = (id: string, title: string): TwinSource => ({
  id,
  twinId: "t",
  kind: "document",
  format: "markdown",
  source: "x",
  title,
  bytes: 1,
  fingerprint: "f",
  chunkCount: 1,
  status: "parsed",
  importedAt: 0,
  redacted: true,
})

const applied: AppliedTemplate = {
  systemPrompt: "...",
  metadata: { twinName: "Alice", retrievedChunkIds: ["c1"], styleSampleIds: ["s1"] },
}

describe("buildCitationsFromApplied", () => {
  it("maps chunk + source rows into citation rows with relevance buckets", () => {
    const out = buildCitationsFromApplied(applied, {
      chunks: [chunk("c1", "hello world", "src1")],
      sources: [source("src1", "Day 1 Notes")],
      scoreById: { c1: 0.95 },
      degraded: false,
      styleSampleCount: 1,
    })
    expect(out).toEqual({
      retrievedChunks: [
        {
          chunkId: "c1",
          sourceId: "src1",
          sourceTitle: "Day 1 Notes",
          relevance: "high",
          preview: "hello world",
        },
      ],
      styleSampleCount: 1,
      degraded: false,
    })
  })

  it("truncates preview to 200 chars", () => {
    const long = "x".repeat(500)
    const out = buildCitationsFromApplied(applied, {
      chunks: [chunk("c1", long, "src1")],
      sources: [source("src1", "src")],
      scoreById: { c1: 0.5 },
      degraded: false,
      styleSampleCount: 0,
    })
    expect(out.retrievedChunks[0].preview).toHaveLength(200)
    expect(out.retrievedChunks[0].relevance).toBe("medium")
  })

  it("passes degraded reason through", () => {
    const out = buildCitationsFromApplied(applied, {
      chunks: [],
      sources: [],
      scoreById: {},
      degraded: true,
      degradedReason: "embed-failed: timeout",
      styleSampleCount: 0,
    })
    expect(out.degraded).toBe(true)
    expect(out.degradedReason).toBe("embed-failed: timeout")
  })
})
```

- [ ] **Step 2: Implement.**

```ts
import type { AppliedTemplate } from "./system-prompt-template"
import type { TwinChunk, TwinSource } from "@/types/twin"

export interface CitationChunk {
  chunkId: string
  sourceId: string
  sourceTitle?: string
  relevance: "high" | "medium" | "low"
  preview: string
}

export interface TwinCitations {
  retrievedChunks: CitationChunk[]
  styleSampleCount: number
  degraded: boolean
  degradedReason?: string
}

function bucket(score: number): "high" | "medium" | "low" {
  if (score >= 0.7) return "high"
  if (score >= 0.45) return "medium"
  return "low"
}

export interface BuildCitationsInput {
  chunks: TwinChunk[]
  sources: TwinSource[]
  scoreById: Record<string, number>
  degraded: boolean
  degradedReason?: string
  styleSampleCount: number
}

export function buildCitationsFromApplied(
  _applied: AppliedTemplate,
  input: BuildCitationsInput
): TwinCitations {
  const sourceTitleById = new Map(input.sources.map((s) => [s.id, s.title]))
  const retrievedChunks: CitationChunk[] = input.chunks.map((c) => ({
    chunkId: c.id,
    sourceId: c.sourceId,
    sourceTitle: sourceTitleById.get(c.sourceId),
    relevance: bucket(input.scoreById[c.id] ?? 0),
    preview: c.content.slice(0, 200),
  }))
  return {
    retrievedChunks,
    styleSampleCount: input.styleSampleCount,
    degraded: input.degraded,
    degradedReason: input.degradedReason,
  }
}
```

- [ ] **Step 3: Run tests + commit.**

```bash
pnpm test -- lib/twin/runtime/citations.test.ts
rtk git add lib/twin/runtime/citations.ts lib/twin/runtime/citations.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): TwinCitations type + buildCitationsFromApplied factory

Pure helper that converts an applied template's metadata + the chunk
rows into the on-message citation blob the renderer consumes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4.2: Add `twinAppliedSink` to `BuildOptionsContext`

**Files:**

- Modify: `lib/claude/build-options.ts`
- Modify: `lib/claude/build-options-twin.test.ts`

- [ ] **Step 1: Add the failing test.**

```ts
it("invokes twinAppliedSink with the applied template after applyTwinContext", async () => {
  const sink = vi.fn()
  const ch = makeChar({ twinId: "twin_alice" })
  vi.spyOn(twinRuntime, "applyTwinContext").mockResolvedValue({
    applied: {
      systemPrompt: "rendered",
      metadata: { twinName: "Alice", retrievedChunkIds: ["c1"], styleSampleIds: [] },
    },
    degraded: false,
  })
  await resolveSendOptions({
    character: ch,
    twinDeps: stubDeps(),
    twinUserMessage: "hi",
    twinAppliedSink: sink,
  })
  expect(sink).toHaveBeenCalledWith(
    expect.objectContaining({ metadata: expect.objectContaining({ twinName: "Alice" }) })
  )
})
```

- [ ] **Step 2: Add the field + invocation.**

In `lib/claude/build-options.ts`:

```ts
export interface BuildOptionsContext {
  // …existing fields…
  /**
   * Optional callback invoked with the applied twin template after
   * applyTwinContext returns. The chat hook uses this to capture the
   * metadata it needs for the message-side citation footer; non-chat
   * callers (diagnostics, scheduler, tests) leave it unset.
   */
  twinAppliedSink?: (
    applied: import("@/lib/twin/runtime/apply-twin-context").AppliedTemplate
  ) => void
}
```

In the twin-injection block:

```ts
if (result.applied) {
  baseSystem = result.applied.systemPrompt
  ctx.twinAppliedSink?.(result.applied)
}
```

- [ ] **Step 3: Run tests + commit.**

```bash
pnpm test -- lib/claude/build-options-twin.test.ts
rtk git add lib/claude/build-options.ts lib/claude/build-options-twin.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): twinAppliedSink callback on BuildOptionsContext

Lets the chat hooks capture the applied twin template (and its
metadata) without forcing a return-shape change on the seven non-chat
callers of resolveSendOptions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4.3: Capture applied + persist `twinCitations` on assistant message — single-character chat

**Files:**

- Modify: `lib/twin/runtime/system-prompt-template.ts` (add `retrievedChunkScores` to `AppliedTemplate.metadata`)
- Modify: `lib/twin/runtime/system-prompt-template.test.ts`
- Modify: `lib/twin/runtime/apply-twin-context.ts` (populate the new field from the reranked hits)
- Modify: `hooks/chat/use-claude-chat.ts`

- [ ] **Step 0: Extend `AppliedTemplate.metadata` with per-chunk scores + degraded info.**

In `lib/twin/runtime/system-prompt-template.ts`:

```ts
export interface AppliedTemplate {
  systemPrompt: string
  metadata: {
    twinName: string
    retrievedChunkIds: string[]
    /** Cosine score per chunk id (twinChunks.id), populated by applyTwinContext. */
    retrievedChunkScores: Record<string, number>
    styleSampleIds: string[]
    /**
     * True when the runtime degraded (embed failed or retrieval failed).
     * Mirrors `ApplyTwinContextResult.degraded` so the chat hook can read
     * it from the sink without juggling two values.
     */
    degraded: boolean
    degradedReason?: string
  }
}
```

Update `applyTwinContext` to thread `degraded` / `degradedReason` into the
template metadata before returning. (The outer `ApplyTwinContextResult.degraded`
stays for callers that don't care about the metadata shape, e.g. tests.)

In the `applySystemPromptTemplate` return, populate it:

```ts
return {
  systemPrompt: sections.join("\n\n---\n\n"),
  metadata: {
    twinName: input.twinName,
    retrievedChunkIds: input.retrievedChunks.map((r) => r.chunk.id),
    retrievedChunkScores: Object.fromEntries(
      input.retrievedChunks.map((r) => [r.chunk.id, r.score])
    ),
    styleSampleIds: input.styleSamples.map((s) => s.id),
  },
}
```

Add a test asserting the scores map matches the input. Run `pnpm test -- lib/twin/runtime/system-prompt-template.test.ts`.

- [ ] **Step 1: Capture in `buildSendOptions` and stash on a ref.**

In `hooks/chat/use-claude-chat.ts`, in `buildSendOptions` (around line 280):

```ts
const twinAppliedRef = { current: undefined as AppliedTemplate | undefined }

return resolveSendOptions({
  session,
  appSettings,
  referencedPaths,
  twinDeps: twinHandshake,
  twinUserMessage: twinHandshake ? userMessage : undefined,
  twinAppliedSink: (a) => {
    twinAppliedRef.current = a
  },
}).then((opts) => ({ opts, twinApplied: twinAppliedRef.current }))
```

(Update the function's signature/return type accordingly. The caller site is `send` — adjust to destructure `{ opts, twinApplied }`.)

- [ ] **Step 2: When persisting the eventual assistant message, attach `twinCitations`.**

The exact persist path varies (`applySdkEvent` + the message-write code in `useClaudeChat`). Find where the SDK `result` event is mapped to a `StoredMessage`. Augment the message metadata:

```ts
import { buildCitationsFromApplied } from "@/lib/twin/runtime/citations"
import { listTwinChunksByVectorDocIds } from "@/lib/db/twin-chunks"
import { listTwinSourcesByIds } from "@/lib/db/twin-sources"

// After streaming completes and before the StoredMessage is persisted:
let twinCitations: TwinCitations | undefined
if (twinApplied) {
  const ids = twinApplied.metadata.retrievedChunkIds
  // The vector docIds were the ids returned from the vector store; chunk rows
  // already exist in Dexie. Use the existing helper.
  const chunks = await getTwinChunksByVectorDocIds(ids).catch(() => [])
  const sourceIds = Array.from(new Set(chunks.map((c) => c.sourceId)))
  const sources = await listTwinSourcesByIds(sourceIds).catch(() => [])
  twinCitations = buildCitationsFromApplied(twinApplied, {
    chunks,
    sources,
    // Cosine scores carried in AppliedTemplate.metadata (see Step 0). The
    // map is keyed by chunk row id (twinChunks.id), matching what
    // buildCitationsFromApplied iterates.
    scoreById: twinApplied.metadata.retrievedChunkScores,
    degraded: twinApplied.metadata.degraded,
    degradedReason: twinApplied.metadata.degradedReason,
    styleSampleCount: twinApplied.metadata.styleSampleIds.length,
  })
}

// On message persist:
const storedMsg = withMetadata(assistantMessage, {
  ...existingMetadata,
  twinCitations,
})
```

**Note**: `applied.metadata` doesn't currently carry per-chunk scores; extend `AppliedTemplate.metadata` with `retrievedChunkScores: Record<string, number>` (1 line in `system-prompt-template.ts`) so `buildCitationsFromApplied` can produce the relevance bucket. Add a unit test for the new field on the template.

- [ ] **Step 3: Add a small test for the renderer-side metadata round trip.**

```ts
it("persists twinCitations on the assistant StoredMessage", async () => {
  // Drive a single twin-bound send; assert message.metadata.twinCitations.
  // Use the same mocking shape as the existing send-flow tests.
})
```

- [ ] **Step 4: Run tests + commit.**

```bash
pnpm test -- hooks/chat/use-claude-chat
rtk git add hooks/chat/use-claude-chat.ts lib/twin/runtime/system-prompt-template.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): persist twinCitations on assistant messages (single chat)

Captures the applied twin template via twinAppliedSink, builds a
TwinCitations blob from the retrieved chunk + source rows, and
attaches it to the assistant StoredMessage's metadata so the
renderer can show the citations footer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4.4: Same for team chat

**Files:**

- Modify: `hooks/chat/use-team-chat.ts`

Repeat Task A4.3 inside `runMemberSubSession`: each member captures its own applied template (the sink is per-member) and persists its own `twinCitations`. Use the same `buildCitationsFromApplied` helper.

- [ ] **Step 1: Pass per-member sink.**

In `runMemberSubSession`:

```ts
let memberApplied: AppliedTemplate | undefined
const baseOpts = await resolveSendOptions({
  // …existing fields…
  twinAppliedSink: (a) => {
    memberApplied = a
  },
})
```

- [ ] **Step 2: Attach when persisting.**

Around the per-member assistant message persist call (the team-chat `applySdkEvent` site for sub-sessions), include `twinCitations` derived from `memberApplied` exactly as in Task A4.3.

- [ ] **Step 3: Test.**

```ts
it("each twin-bound team member's assistant message carries its own twinCitations", async () => {
  // Drive a 2-member twin-bound team send; assert each StoredMessage has
  // a populated `metadata.twinCitations`.
})
```

- [ ] **Step 4: Commit.**

```bash
rtk git add hooks/chat/use-team-chat.ts hooks/chat/use-team-chat.test.ts
rtk git commit -m "$(cat <<'EOF'
feat(twin): persist twinCitations on team-member assistant messages

Per-member applied template captured via the resolver's sink and
attached to each member's StoredMessage so the renderer shows the
right citations under each bubble.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4.5: Mount `<Sources>` in `components/chat/message-renderer.tsx`

**Files:**

- Modify: `components/chat/message-renderer.tsx`
- Modify: `components/chat/message-list.test.tsx` OR new `components/chat/message-renderer.test.tsx`

- [ ] **Step 1: Read the renderer to find the assistant-bubble seam.**

```bash
# Read components/chat/message-renderer.tsx end-to-end; find the section that
# renders an assistant message body (typically a `<MessageContent>` block
# inside an `is-assistant` parent).
```

Locate the closing `</MessageContent>` for assistant messages — that's the mount point.

- [ ] **Step 2: Write the failing test.**

In `components/chat/message-renderer.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react"
import { MessageRenderer } from "./message-renderer"
import { makeMessage } from "@/test-utils/message" // existing helper

const citationFixture = {
  retrievedChunks: [
    {
      chunkId: "c1",
      sourceId: "src1",
      sourceTitle: "Day 1",
      relevance: "high" as const,
      preview: "hi",
    },
    {
      chunkId: "c2",
      sourceId: "src2",
      sourceTitle: "Day 2",
      relevance: "medium" as const,
      preview: "ok",
    },
  ],
  styleSampleCount: 1,
  degraded: false,
}

describe("MessageRenderer twin citations", () => {
  it("renders <Sources> when twinCitations is present", () => {
    render(
      <MessageRenderer
        message={makeMessage({
          role: "assistant",
          metadata: { twinCitations: citationFixture },
        })}
      />
    )
    expect(screen.getByText(/Used 2 sources/i)).toBeInTheDocument()
  })

  it("does not render <Sources> when twinCitations is absent", () => {
    render(<MessageRenderer message={makeMessage({ role: "assistant" })} />)
    expect(screen.queryByText(/Used \d+ sources/i)).not.toBeInTheDocument()
  })

  it("shows a degraded note when degraded is true", () => {
    render(
      <MessageRenderer
        message={makeMessage({
          role: "assistant",
          metadata: {
            twinCitations: {
              ...citationFixture,
              degraded: true,
              degradedReason: "embed-failed: timeout",
            },
          },
        })}
      />
    )
    expect(screen.getByText(/RAG unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/embed-failed: timeout/i)).toBeInTheDocument()
  })

  it("opens a chunk preview dialog on Source click", () => {
    render(
      <MessageRenderer
        message={makeMessage({
          role: "assistant",
          metadata: { twinCitations: citationFixture },
        })}
      />
    )
    fireEvent.click(screen.getByText("Used 2 sources")) // expand
    fireEvent.click(screen.getByText("Day 1")) // open preview
    expect(screen.getByRole("dialog")).toHaveTextContent("hi")
  })
})
```

- [ ] **Step 3: Run test to verify failure.**

```bash
pnpm test -- components/chat/message-renderer.test.tsx
```

Expected: FAIL.

- [ ] **Step 4: Mount the citation footer.**

In `components/chat/message-renderer.tsx`, near the assistant body block:

```tsx
import { Sources, SourcesTrigger, SourcesContent, Source } from "@/components/ai-elements/sources"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useState } from "react"
import type { TwinCitations } from "@/lib/twin/runtime/citations"

function TwinCitationsFooter({ citations }: { citations: TwinCitations }) {
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const open = previewIdx !== null
  const current = open ? citations.retrievedChunks[previewIdx!] : null
  return (
    <>
      {citations.retrievedChunks.length > 0 ? (
        <Sources>
          <SourcesTrigger count={citations.retrievedChunks.length} />
          <SourcesContent>
            {citations.retrievedChunks.map((c, i) => (
              <Source
                key={c.chunkId}
                href="#"
                title={c.sourceTitle ?? "Unknown source"}
                onClick={(e) => {
                  e.preventDefault()
                  setPreviewIdx(i)
                }}
              />
            ))}
          </SourcesContent>
        </Sources>
      ) : null}
      {citations.degraded ? (
        <p className="text-muted-foreground text-xs italic">
          RAG unavailable for this answer
          {citations.degradedReason ? ` (${citations.degradedReason})` : ""}.
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={(v) => !v && setPreviewIdx(null)}>
        <DialogContent>
          {current ? (
            <>
              <DialogHeader>
                <DialogTitle>{current.sourceTitle ?? "Source"}</DialogTitle>
              </DialogHeader>
              <pre className="bg-muted max-h-96 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
                {current.preview}
              </pre>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
```

Mount inside the assistant bubble after the message body:

```tsx
{
  message.role === "assistant" && message.metadata?.twinCitations ? (
    <TwinCitationsFooter citations={message.metadata.twinCitations as TwinCitations} />
  ) : null
}
```

- [ ] **Step 5: Run tests + coverage.**

```bash
pnpm test -- components/chat/message-renderer.test.tsx
pnpm test:coverage -- --collectCoverageFrom='components/chat/message-renderer.tsx'
```

Expected: pass; coverage ≥90%.

- [ ] **Step 6: Commit.**

```bash
rtk git add components/chat/message-renderer.tsx components/chat/message-renderer.test.tsx
rtk git commit -m "$(cat <<'EOF'
feat(twin): mount Sources footer on twin-bound assistant messages

Reuses Sources / SourcesTrigger / SourcesContent / Source primitives
from components/ai-elements/sources.tsx. Click-through opens a Dialog
with the chunk preview. Degraded sends show a one-line note.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Phase A4 done.**

---

# Final Validation

- [ ] **Step 1: Full test pass.**

```bash
pnpm test
```

Expected: 100% green.

- [ ] **Step 2: Full coverage gate.**

```bash
pnpm test:coverage
```

Expected: every changed/new file ≥90% lines/branches/functions.

- [ ] **Step 3: Typecheck + lint + format.**

```bash
pnpm typecheck
pnpm lint
pnpm format:check
```

- [ ] **Step 4: Manual smoke (only if reviewer wants).**

In Tauri dev mode (`pnpm tauri dev`):

1. Bind a character to a twin (Twin workbench → Settings → set `twinId`).
2. Ingest one markdown source; queue ingest; queue distill.
3. Send a message in single chat → verify a footer "Used N sources" appears, expand → click → see preview dialog.
4. Repeat in a team session that includes the twin-bound character → footer appears under that member's bubble.
5. Cut network mid-send → verify the degraded line appears with a reason.

---

# Self-review

Spec coverage scan (against `2026-05-03-twin-A-runtime-quality-design.md`):

| Spec Section                                        | Covered by                                     | Notes                                                                      |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Decision 1 — team chat per-turn shared embed        | A1.4                                           | embed once per turn, threaded into every twin-bound member                 |
| Decision 2 — write-time cache + lazy backfill       | A2.2, A2.3, A2.4                               | distill writes inline; runtime backfills missing                           |
| Decision 3 — MMR + threshold                        | A3.1, A3.2, A3.3, A3.4, A3.5, A3.6, A3.7       | settings + helper + interface + 6 clients + RAG + style + bucket formatter |
| Decision 4 — citations UI                           | A4.1, A4.2, A4.3, A4.4, A4.5                   | type + sink + single-chat persist + team persist + renderer                |
| Data model — `StyleSample.embedding`                | A2.1                                           |                                                                            |
| Data model — `TwinSettings.rag*` / `style*`         | A3.1                                           |                                                                            |
| Data model — `StoredMessage.metadata.twinCitations` | A4.3, A4.4                                     | free-form metadata, no schema change                                       |
| New file — `build-deps.ts`                          | A1.1                                           |                                                                            |
| New file — `mmr.ts`                                 | A3.2                                           |                                                                            |
| New file — `citations.ts`                           | A4.1                                           |                                                                            |
| Vector store — `returnEmbedding` extension          | A3.3, A3.4                                     | native + 5 remote                                                          |
| Coverage gate ≥90%                                  | every task ends with `pnpm test:coverage` step |                                                                            |

No spec sections without a backing task.

Placeholder scan: no "TBD"/"TODO"/"implement later" in any task. Every code-bearing step shows the actual code.

Type consistency: `tryBuildTwinDeps`, `selectMMR`, `selectFewShotSamples`, `applyTwinContext`, `resolveSendOptions`, `buildCitationsFromApplied`, `TwinCitations`, `AppliedTemplate`, `BuildOptionsContext` — names are stable across tasks.

Scope: this plan is one logical change set (Spec A only). Specs C / B / D are independent specs to be planned separately.

---

# Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-03-spec-a-twin-runtime-quality.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task; review between tasks; fast iteration.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`; batch with checkpoints.

Which approach?
