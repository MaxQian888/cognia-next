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
} from "@/types/memory/memory"
import { retrieveMemories, type MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"
import { assembleProceduralBlock } from "@/lib/memory/procedural"
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
  deps: ApplyMemoryContextDeps
}

export interface AppliedMemory {
  id: string
  type: MemoryType
  text: string
  score: number
  relevance: number
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

const EMPTY: ApplyMemoryContextResult = {
  systemPromptSection: null,
  retrievedMemories: [],
  proceduralCount: 0,
  withheldCount: 0,
  budget: { limit: 0, used: 0, truncated: false },
  degraded: false,
}

export async function applyMemoryContext(
  input: ApplyMemoryContextInput
): Promise<ApplyMemoryContextResult> {
  const query = input.userMessage.trim()
  const maxTokens = input.maxTokens ?? 900
  const tokenCounter = createContextManager({ maxTokens })
  const reader = input.reader ?? (input.characterId ? { characterId: input.characterId } : {})
  try {
    const [retrieved, proceduralAll] = await Promise.all([
      query
        ? retrieveMemories(
            {
              queryText: query,
              reader,
              topK: input.topK,
              relevanceFloor: input.relevanceFloor,
              types: RECALLED_TYPES,
              precomputedQueryEmbedding: input.precomputedQueryEmbedding,
              enableQueryExpansion: input.enableQueryExpansion,
              recencyHalfLifeDays: input.recencyHalfLifeDays,
            },
            input.deps
          )
        : Promise.resolve([]),
      input.deps.loadProcedural(reader),
    ])

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
        evidenceState: r.memory.evidenceState ?? "legacy",
        reviewStatus: r.memory.reviewStatus ?? "unreviewed",
      }))

    const proceduralBudget = Math.min(input.proceduralMaxTokens ?? 600, Math.floor(maxTokens * 0.4))
    const safeProcedural = proceduralAll.filter((memory) => hasNoLeakingPii(memory.text))
    const unsafeProceduralCount = proceduralAll.length - safeProcedural.length
    const proceduralBlock = assembleProceduralBlock(safeProcedural, {
      maxTokens: proceduralBudget,
    })
    const proceduralCount = proceduralBlock
      ? Math.max(0, proceduralBlock.split("\n").length - 1)
      : 0
    const activeProceduralCount = safeProcedural.filter(
      (memory) => memory.type === "procedural" && memory.status === "active"
    ).length
    let used = proceduralBlock ? tokenCounter.estimateTokens(proceduralBlock) : 0
    const recallHeadingCost = tokenCounter.estimateTokens(RECALL_HEADING)
    const recalled: AppliedMemory[] = []
    for (const memory of recalledCandidates) {
      const lineCost = tokenCounter.estimateTokens(`- ${memory.text}`)
      const headingCost = recalled.length === 0 ? recallHeadingCost : 0
      if (used + headingCost + lineCost > maxTokens) continue
      used += headingCost + lineCost
      recalled.push(memory)
    }

    const sections: string[] = []
    if (recalled.length > 0) {
      sections.push(`${RECALL_HEADING}\n${recalled.map((m) => `- ${m.text}`).join("\n")}`)
    }
    if (proceduralBlock) sections.push(proceduralBlock)

    const systemPromptSection = sections.length > 0 ? sections.join("\n\n") : null
    const withheldCount =
      unsafeRecalledCount +
      unsafeProceduralCount +
      recalledCandidates.length -
      recalled.length +
      activeProceduralCount -
      proceduralCount
    return {
      systemPromptSection,
      retrievedMemories: recalled,
      proceduralCount,
      withheldCount,
      budget: { limit: maxTokens, used, truncated: withheldCount > 0 },
      degraded: false,
    }
  } catch {
    return { ...EMPTY, budget: { limit: maxTokens, used: 0, truncated: false }, degraded: true }
  }
}
