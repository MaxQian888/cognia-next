/**
 * Shared read path for external memory surfaces (plugin `ctx.memory.search`,
 * MCP `memory_search`, companion RPC `memory_search`). Thin, policy-aware
 * wrapper over `retrieveMemories`: it resolves the user's `MemoryConfig`,
 * enforces the `enabled` / `temporary` gates (temporary mode blocks reads too —
 * "the current context neither reads nor writes memory"), and threads the
 * configured `relevanceFloor` / `decayHalfLifeDays` / `enableQueryExpansion`
 * into the retriever the same way the chat injection path does.
 *
 * `touch` (accessCount / lastAccessedAt bump) stays ON by default so recency
 * reflects real usage regardless of surface; pass `touch: false` for
 * diagnostics-style reads that should not perturb decay.
 */

import type { Memory, MemoryType } from "@/types/memory/memory"

export interface SearchMemoriesExternalInput {
  query: string
  /** Defaults to the configured `retrievalTopK`. */
  topK?: number
  types?: MemoryType[]
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  path?: string
  /** Default true; false = don't bump lastAccessedAt/accessCount. */
  touch?: boolean
}

export interface ExternalMemoryHit {
  memory: Memory
  /** Normalized fused relevance in [0,1]. */
  relevance: number
  /** Combined multi-factor score. */
  score: number
}

export type SearchMemoriesExternalResult =
  | { ok: true; hits: ExternalMemoryHit[] }
  | { ok: false; reason: "disabled" | "temporary" | "backend_unavailable" }

export async function searchMemoriesExternal(
  input: SearchMemoriesExternalInput
): Promise<SearchMemoriesExternalResult> {
  const query = input.query.trim()
  if (!query) throw new Error("memory search requires a non-empty 'query'")

  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }

  const { tryBuildMemoryDeps } = await import("@/lib/memory/runtime/build-deps")
  let deps = await tryBuildMemoryDeps(config)
  if (!deps) return { ok: false, reason: "backend_unavailable" }
  if (input.touch === false) deps = { ...deps, touch: undefined }

  const { retrieveMemories } = await import("@/lib/memory/retrieve/retriever")
  const hits = await retrieveMemories(
    {
      queryText: query,
      reader: {
        characterId: input.characterId,
        projectId: input.projectId,
        agentId: input.agentId,
        branch: input.branch,
        path: input.path,
      },
      topK: input.topK ?? config.retrievalTopK,
      relevanceFloor: config.relevanceFloor,
      types: input.types,
      enableQueryExpansion: config.enableQueryExpansion,
      recencyHalfLifeDays: config.decayHalfLifeDays,
    },
    deps
  )
  return { ok: true, hits }
}
