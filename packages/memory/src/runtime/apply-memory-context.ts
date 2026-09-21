/**
 * Memory read runtime — mirrors `lib/twin/runtime/apply-twin-context.ts`:
 * best-effort, dependency-injected, and **never throws** (a failure degrades to
 * an empty section, exactly like the Twin runtime). Assembles a system-prompt
 * section that COEXISTS with the Twin section (Twin = persona, Memory = durable
 * user facts) and is appended to `baseSystem` by `resolveSendOptions` — it never
 * replaces it.
 *
 * Retrieval reuses `retrieveMemories` (which itself reuses the RAG BM25 +
 * fusion). Procedural assembly reuses `assembleProceduralBlock`. Twin-overlap
 * dedupe drops memories whose text is already covered by the current turn's Twin
 * chunks, so the two sections don't repeat each other against the token budget.
 */

import type {
  Memory,
  MemoryEvidenceState,
  MemoryReaderContext,
  MemoryReviewStatus,
  MemoryType,
} from "../types/memory"
import {
  retrieveMemoriesWithOutcome,
  isMemoryEligibleForRetrieval,
  type MemoryRetrieverDeps,
} from "../retrieve/retriever"
import { memoryRuntimeDegraded } from "../control-plane/retrieval-telemetry"
import { assembleProceduralContext } from "../procedural"
import { buildMemoryContextSnapshot, type MemoryContextSnapshot } from "../types/context-snapshot"
import { createContextManager } from "@cognia/rag/context-manager"
import { hasNoLeakingPii } from "@cognia/redact"

export interface ApplyMemoryContextDeps extends MemoryRetrieverDeps {
  /** All active procedural memories for the reader (global + character). */
  loadProcedural: (reader?: MemoryReaderContext | string) => Promise<Memory[]>
}

export interface ApplyMemoryContextInput {
  userMessage: string
  characterId?: string
  reader?: MemoryReaderContext
  topK: number
  signal?: AbortSignal
  vectorTimeoutMs?: number
  relevanceFloor: number
  /** Shared budget for semantic, episodic, and procedural learned memory. */
  maxTokens?: number
  /** Current turn's Twin chunk texts, for overlap dedupe. */
  twinChunkTexts?: string[]
  proceduralMaxTokens?: number
  /**
   * Query embedding already computed for this turn (e.g. for twin RAG). Passed
   * through to the retriever's vector leg so the same query isn't re-embedded.
   */
  precomputedQueryEmbedding?: number[]
  /** Heuristic synonym expansion of the memory BM25 keyword leg. Off by default. */
  enableQueryExpansion?: boolean
  /** Base recency half-life (days), from `MemoryConfig.decayHalfLifeDays`. */
  recencyHalfLifeDays?: number
  /** Clock override for the snapshot's createdAt/expiresAt (tests). */
  now?: number
  deps: ApplyMemoryContextDeps
}

export interface AppliedMemory {
  id: string
  type: MemoryType
  text: string
  score: number
  relevance: number
  /** Row version at read time — the snapshot binds deliveries to it. */
  version?: number
  evidenceState: MemoryEvidenceState
  reviewStatus: MemoryReviewStatus
}

export interface ApplyMemoryContextResult {
  /** Section to append to the system prompt, or null when nothing to inject. */
  systemPromptSection: string | null
  retrievedMemories: AppliedMemory[]
  proceduralCount: number
  withheldCount: number
  budget: { limit: number; used: number; truncated: boolean }
  degraded: boolean
  /**
   * Delivery receipt for this pass (`"prepared"`). The host upgrades it to
   * `"delivered"` when the section actually lands on the wire.
   */
  snapshot: MemoryContextSnapshot
}

const RECALL_HEADING = "## What you remember about the user"
const RECALLED_TYPES: MemoryType[] = ["semantic", "episodic"]

function normalizeForOverlap(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Drop a recalled memory whose text is subsumed by any Twin chunk (either direction). */
function overlapsTwin(memoryText: string, twinChunkTexts: string[]): boolean {
  const m = normalizeForOverlap(memoryText)
  if (!m) return false
  for (const chunk of twinChunkTexts) {
    const c = normalizeForOverlap(chunk)
    if (c && (c.includes(m) || m.includes(c))) return true
  }
  return false
}

export async function applyMemoryContext(
  input: ApplyMemoryContextInput
): Promise<ApplyMemoryContextResult> {
  const query = input.userMessage.trim()
  const maxTokens = Number.isFinite(input.maxTokens)
    ? Math.max(0, Math.floor(input.maxTokens!))
    : 900
  const tokenCounter = createContextManager({ maxTokens })
  const reader = input.reader ?? (input.characterId ? { characterId: input.characterId } : {})
  const now = input.now ?? Date.now()
  // Every outcome — empty, degraded, or delivered — carries the receipt, so a
  // turn that injected nothing still leaves a falsifiable record.
  const snapshotFor = (
    sectionText: string,
    refs: Array<{ id: string; version?: number }>,
    budget: { limit: number; used: number; truncated: boolean },
    degraded: boolean
  ) =>
    buildMemoryContextSnapshot({
      reader,
      memoryRefs: refs.map((m) => ({ id: m.id, version: m.version })),
      sectionText,
      budget,
      degraded,
      now,
    })
  try {
    const [recallResult, proceduralResult] = await Promise.allSettled([
      Promise.resolve().then(() =>
        query
          ? retrieveMemoriesWithOutcome(
              {
                queryText: query,
                signal: input.signal,
                vectorTimeoutMs: input.vectorTimeoutMs,
                reader,
                topK: input.topK,
                relevanceFloor: input.relevanceFloor,
                types: RECALLED_TYPES,
                // THE guard for this section. Without it, the day project mining
                // stamps its first claim, every claim also renders under
                // "What you remember about the user" — silently, with no error and
                // no failing test, in a first-person voice that reads as though the
                // user personally told the agent a fact about their own repo.
                claimFilter: "personal-only",
                precomputedQueryEmbedding: input.precomputedQueryEmbedding,
                enableQueryExpansion: input.enableQueryExpansion,
                recencyHalfLifeDays: input.recencyHalfLifeDays,
                now,
              },
              input.deps
            )
          : null
      ),
      Promise.resolve().then(() => input.deps.loadProcedural(reader)),
    ])

    const retrieved = recallResult.status === "fulfilled" ? (recallResult.value?.hits ?? []) : []
    const proceduralAll = proceduralResult.status === "fulfilled" ? proceduralResult.value : []
    const degraded =
      recallResult.status === "rejected" ||
      proceduralResult.status === "rejected" ||
      (recallResult.status === "fulfilled" &&
        memoryRuntimeDegraded(recallResult.value?.reasons ?? []))
    const twinTexts = input.twinChunkTexts ?? []
    const unsafeRecalledCount = retrieved.filter((r) => !hasNoLeakingPii(r.memory.text)).length
    const recalledCandidates = retrieved
      .filter((r) => hasNoLeakingPii(r.memory.text))
      .filter((r) => !overlapsTwin(r.memory.text, twinTexts))
      .map<AppliedMemory>((r) => ({
        id: r.memory.id,
        type: r.memory.type,
        text: r.memory.text,
        score: r.score,
        relevance: r.relevance,
        version: r.memory.version,
        evidenceState: r.memory.evidenceState ?? "legacy",
        reviewStatus: r.memory.reviewStatus ?? "unreviewed",
      }))

    const proceduralLimit = Number.isFinite(input.proceduralMaxTokens)
      ? Math.max(0, input.proceduralMaxTokens!)
      : 600
    const proceduralBudget = Math.min(proceduralLimit, Math.floor(maxTokens * 0.4))
    const safeProcedural = proceduralAll.filter(
      (memory) => isMemoryEligibleForRetrieval(memory, now) && hasNoLeakingPii(memory.text)
    )
    const withheldProceduralCount = proceduralAll.length - safeProcedural.length
    const procedural = assembleProceduralContext(safeProcedural, { maxTokens: proceduralBudget })
    const proceduralBlock = procedural.text
    const proceduralCount = procedural.memories.length
    const activeProceduralCount = safeProcedural.filter(
      (memory) => memory.type === "procedural"
    ).length
    const render = (memories: AppliedMemory[]) =>
      [
        memories.length
          ? `${RECALL_HEADING}\n${memories.map((m) => `- ${m.text}`).join("\n")}`
          : null,
        proceduralBlock,
      ]
        .filter(Boolean)
        .join("\n\n")
    const recalled: AppliedMemory[] = []
    for (const memory of recalledCandidates) {
      if (tokenCounter.estimateTokens(render([...recalled, memory])) > maxTokens) continue
      recalled.push(memory)
    }

    const systemPromptSection = render(recalled) || null
    const used = tokenCounter.estimateTokens(systemPromptSection ?? "")
    const withheldCount =
      unsafeRecalledCount +
      withheldProceduralCount +
      recalledCandidates.length -
      recalled.length +
      activeProceduralCount -
      proceduralCount
    const budget = { limit: maxTokens, used, truncated: withheldCount > 0 }
    return {
      systemPromptSection,
      retrievedMemories: recalled,
      proceduralCount,
      withheldCount,
      budget,
      degraded,
      snapshot: snapshotFor(
        systemPromptSection ?? "",
        [...recalled, ...procedural.memories],
        budget,
        degraded
      ),
    }
  } catch {
    const budget = { limit: maxTokens, used: 0, truncated: false }
    return {
      systemPromptSection: null,
      retrievedMemories: [],
      proceduralCount: 0,
      withheldCount: 0,
      budget,
      degraded: true,
      snapshot: snapshotFor("", [], budget, true),
    }
  }
}
