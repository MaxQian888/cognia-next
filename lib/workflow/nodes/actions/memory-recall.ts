/**
 * `action.memory.recall` — query the autonomous long-term memory store
 * (lib/memory) from a workflow. Read-only: BM25 + (when configured and
 * privacy-permitted) vector hybrid retrieval with the same 3-factor scoring
 * the chat injection path uses.
 *
 * Best-effort contract: a disabled memory system or missing backend never
 * fails the step — it returns `{ entries: [], degraded: true }` with a
 * warning log, mirroring how chat degrades.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { MemoryType } from "@/types/memory/memory"

export interface MemoryRecallParams {
  query?: string
  topK?: number
  scope?: "global" | "character"
  /** Required when scope === "character". */
  characterId?: string
  /** Drop hits whose normalized relevance is below this (0..1). */
  relevanceFloor?: number
  /** Restrict to memory types (semantic / episodic / procedural). */
  types?: MemoryType[]
}

export async function runMemoryRecall(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as MemoryRecallParams
  const query = (params.query ?? "").trim()
  if (!query) throw nonRetryable("action.memory.recall requires a non-empty 'query'")
  const scope = params.scope ?? "global"
  if (scope === "character" && !params.characterId) {
    throw nonRetryable("action.memory.recall: 'characterId' is required when scope is 'character'")
  }

  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) {
    ctx.log("warn", "action.memory.recall: long-term memory is disabled — returning no entries.")
    return { output: { entries: [], degraded: true, reason: "memory_disabled" } }
  }

  const { tryBuildMemoryDeps } = await import("@/lib/memory/runtime/build-deps")
  const deps = await tryBuildMemoryDeps(config)
  if (!deps) {
    ctx.log("warn", "action.memory.recall: memory backend unavailable — returning no entries.")
    return { output: { entries: [], degraded: true, reason: "backend_unavailable" } }
  }

  const { retrieveMemories } = await import("@/lib/memory/retrieve/retriever")
  const hits = await retrieveMemories(
    {
      queryText: query,
      characterId: scope === "character" ? params.characterId : undefined,
      topK: params.topK ?? 6,
      relevanceFloor: params.relevanceFloor ?? 0.1,
      types: params.types,
    },
    deps
  )

  return {
    output: {
      entries: hits.map((h) => ({
        id: h.memory.id,
        text: h.memory.text,
        type: h.memory.type,
        scope: h.memory.scope,
        importance: h.memory.importance,
        relevance: h.relevance,
        score: h.score,
      })),
      degraded: false,
    },
  }
}

function nonRetryable(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { retryable: boolean }).retryable = false
  return err
}
