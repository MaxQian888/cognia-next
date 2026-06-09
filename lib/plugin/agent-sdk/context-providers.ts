/**
 * Plugin Agent SDK — context/memory provider runtime + guarded reads
 * (Package E).
 *
 * - `resolveContextContributions` runs every registered context provider for a
 *   turn and joins their non-empty outputs; the run runtime appends the result
 *   to the system prompt (channel-agnostic).
 * - `readSharedMemory` projects a team's ACL-readable shared-memory entries.
 * - `queryTwinMemory` retrieves RAG chunks from an employee twin (reusing the
 *   chat twin runtime; PII is vetted at ingest).
 *
 * Permission-agnostic: the read gates (agent:shared-memory:read / twin:read)
 * live in `context.ts`. Heavy deps are lazy-imported.
 */

import { listContextProviderEntries } from "@/lib/plugin/registries/context-provider-registry"
import type {
  PluginContextProviderInput,
  PluginSharedMemoryReadEntry,
  PluginSharedMemoryReadOptions,
  PluginTwinMemoryChunk,
  PluginTwinMemoryQueryOptions,
} from "@/types/plugin/plugin-context-provider"

/**
 * Run every registered context provider and join their contributions. Returns
 * an empty string when nothing is contributed. A throwing provider is skipped
 * (best-effort — one bad provider never breaks the run).
 */
export async function resolveContextContributions(
  input: PluginContextProviderInput
): Promise<string> {
  const entries = listContextProviderEntries()
  if (entries.length === 0) return ""
  const parts: string[] = []
  for (const { entry } of entries) {
    try {
      const out = await entry.provide(input)
      if (typeof out === "string" && out.trim().length > 0) parts.push(out.trim())
    } catch {
      /* skip a failing provider */
    }
  }
  return parts.join("\n\n")
}

/** Project a team's ACL-readable shared-memory entries (operator view). */
export async function readSharedMemory(
  teamId: string,
  options: PluginSharedMemoryReadOptions = {}
): Promise<PluginSharedMemoryReadEntry[]> {
  const [{ useAgentTeamStore }, selectors] = await Promise.all([
    import("@/stores/agent/agent-team-store"),
    import("@/stores/agent/agent-team-store/selectors"),
  ])
  const entries = selectors.selectSharedMemoryEntriesForReader(
    teamId,
    selectors.OPERATOR_READER_ID
  )(useAgentTeamStore.getState())
  const tagFilter = options.tags
  return entries
    .filter((e) =>
      tagFilter && tagFilter.length > 0 ? (e.tags ?? []).some((t) => tagFilter.includes(t)) : true
    )
    .map((e) => ({
      key: e.key,
      value: e.value,
      writtenBy: e.writtenBy,
      ...(e.writerName ? { writerName: e.writerName } : {}),
      version: e.version,
      ...(e.tags ? { tags: e.tags } : {}),
    }))
}

/**
 * Query the employee twin's RAG store for a character. Returns retrieved
 * chunks; degrades to `[]` when the character is not twin-bound or the twin
 * runtime is unavailable (never throws).
 */
export async function queryTwinMemory(
  characterId: string,
  query: string,
  options: PluginTwinMemoryQueryOptions = {}
): Promise<PluginTwinMemoryChunk[]> {
  if (typeof query !== "string" || !query.trim()) return []
  try {
    const { getCharacter } = await import("@/lib/db/characters")
    const character = await getCharacter(characterId)
    if (!character?.twinId) return []
    const [{ tryBuildTwinDeps }, { applyTwinContext }] = await Promise.all([
      import("@/lib/twin/runtime/build-deps"),
      import("@/lib/twin/runtime/apply-twin-context"),
    ])
    const deps = await tryBuildTwinDeps()
    if (!deps) return []
    // Honor an explicit topK by overriding the character's ragTopK setting.
    const scoped =
      typeof options.topK === "number" && options.topK > 0
        ? {
            ...character,
            twinSettings: { ...(character.twinSettings ?? {}), ragTopK: options.topK },
          }
        : character
    const result = await applyTwinContext({
      character: scoped,
      userMessage: query,
      deps: deps as unknown as Parameters<typeof applyTwinContext>[0]["deps"],
    })
    return result.retrievedChunks.map((c) => ({
      content: c.chunk.content,
      score: c.score,
      ...(c.sourceTitle ? { sourceTitle: c.sourceTitle } : {}),
    }))
  } catch {
    return []
  }
}
