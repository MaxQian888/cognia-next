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

import type { Memory, MemoryType } from "@/types/memory/memory"
import { retrieveMemories, type MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"
import { assembleProceduralBlock } from "@/lib/memory/procedural"

export interface ApplyMemoryContextDeps extends MemoryRetrieverDeps {
  /** All active procedural memories for the reader (global + character). */
  loadProcedural: (characterId?: string) => Promise<Memory[]>
}

export interface ApplyMemoryContextInput {
  userMessage: string
  characterId?: string
  topK: number
  relevanceFloor: number
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
  deps: ApplyMemoryContextDeps
}

export interface AppliedMemory {
  id: string
  type: MemoryType
  text: string
  score: number
  relevance: number
}

export interface ApplyMemoryContextResult {
  /** Section to append to the system prompt, or null when nothing to inject. */
  systemPromptSection: string | null
  retrievedMemories: AppliedMemory[]
  proceduralCount: number
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
  degraded: false,
}

export async function applyMemoryContext(
  input: ApplyMemoryContextInput
): Promise<ApplyMemoryContextResult> {
  const query = input.userMessage.trim()
  try {
    const [retrieved, proceduralAll] = await Promise.all([
      query
        ? retrieveMemories(
            {
              queryText: query,
              characterId: input.characterId,
              topK: input.topK,
              relevanceFloor: input.relevanceFloor,
              types: RECALLED_TYPES,
              precomputedQueryEmbedding: input.precomputedQueryEmbedding,
              enableQueryExpansion: input.enableQueryExpansion,
            },
            input.deps
          )
        : Promise.resolve([]),
      input.deps.loadProcedural(input.characterId),
    ])

    const twinTexts = input.twinChunkTexts ?? []
    const recalled = retrieved
      .filter((r) => !overlapsTwin(r.memory.text, twinTexts))
      .map<AppliedMemory>((r) => ({
        id: r.memory.id,
        type: r.memory.type,
        text: r.memory.text,
        score: r.score,
        relevance: r.relevance,
      }))

    const proceduralBlock = assembleProceduralBlock(proceduralAll, {
      maxTokens: input.proceduralMaxTokens,
    })
    const proceduralCount = proceduralBlock
      ? proceduralAll.filter((m) => m.type === "procedural" && m.status === "active").length
      : 0

    const sections: string[] = []
    if (recalled.length > 0) {
      sections.push(`${RECALL_HEADING}\n${recalled.map((m) => `- ${m.text}`).join("\n")}`)
    }
    if (proceduralBlock) sections.push(proceduralBlock)

    return {
      systemPromptSection: sections.length > 0 ? sections.join("\n\n") : null,
      retrievedMemories: recalled,
      proceduralCount,
      degraded: false,
    }
  } catch {
    return { ...EMPTY, degraded: true }
  }
}
