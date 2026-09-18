/**
 * Shared read path for external memory surfaces (plugin `ctx.memory.search`,
 * MCP `memory_search`, companion RPC `memory_search`). Thin, policy-aware
 * wrapper over `retrieveMemories`: it resolves the user's `MemoryConfig`,
 * enforces the `enabled` / `temporary` gates (temporary mode blocks reads too —
 * "the current context neither reads nor writes memory"), and threads the
 * configured `relevanceFloor` / `decayHalfLifeDays` / `enableQueryExpansion`
 * into the retriever the same way the chat injection path does.
 *
 * Authorization is caller-bound: `caller.policyCharacterId` /
 * `caller.sessionId` (host-issued, not payload fields) resolve the governing
 * `memoryPolicy`, and the request's `characterId` / `projectId` / `agentId`
 * are intersected with `caller.namespaces` — they narrow what the caller may
 * see, they can never widen it.
 *
 * `touch` (accessCount / lastAccessedAt bump) stays ON by default so recency
 * reflects real usage regardless of surface; pass `touch: false` for
 * diagnostics-style reads that should not perturb decay.
 */

import type { Memory, MemoryType } from "@/types/memory/memory"
import { memoryRowWithinNamespaces, type TrustedMemoryCaller } from "@cognia/memory/types/caller"

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
  | {
      ok: false
      reason:
        | "disabled"
        | "temporary"
        | "backend_unavailable"
        | "policy_denied"
        | "unauthorized_namespace"
    }

export async function searchMemoriesExternal(
  input: SearchMemoriesExternalInput,
  caller: TrustedMemoryCaller
): Promise<SearchMemoriesExternalResult> {
  const query = input.query.trim()
  if (!query) throw new Error("memory search requires a non-empty 'query'")

  const { authorizeMemoryRead, narrowReaderToCaller } = await import("./read-memory")
  const authorized = await authorizeMemoryRead(caller)
  if (!authorized.ok) return authorized
  const { config, read } = authorized

  const reader = narrowReaderToCaller(
    {
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      path: input.path,
    },
    caller
  )
  if (!reader) return { ok: false, reason: "unauthorized_namespace" }

  const { tryBuildMemoryDeps } = await import("@/lib/memory/runtime/build-deps")
  let deps = await tryBuildMemoryDeps(config)
  if (!deps) return { ok: false, reason: "backend_unavailable" }
  const baseDeps = deps
  deps = {
    ...baseDeps,
    // Procedural lines are not part of recall — the retriever only reads
    // `loadCandidates` (plus `vectorSearch`/`touch`/`embed`).
    loadCandidates: async (candidateReader) =>
      (await baseDeps.loadCandidates(candidateReader)).filter((memory) =>
        read.isAuthorized(memory)
      ),
  }
  if (input.touch === false) deps = { ...deps, touch: undefined }

  const { retrieveMemories } = await import("@/lib/memory/retrieve/retriever")
  const hits = await retrieveMemories(
    {
      queryText: query,
      reader,
      topK: input.topK ?? config.retrievalTopK,
      relevanceFloor: config.relevanceFloor,
      types: input.types,
      enableQueryExpansion: config.enableQueryExpansion,
      recencyHalfLifeDays: config.decayHalfLifeDays,
    },
    deps
  )
  // Defense in depth: the retriever's own visibility pass can surface a row
  // whose namespace set the caller is not bound to (a scope the Agent may read
  // but the principal may not). Re-check before anything leaves the process.
  return {
    ok: true,
    hits: hits.filter((hit) => memoryRowWithinNamespaces(hit.memory, caller.namespaces)),
  }
}
