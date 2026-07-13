/**
 * Real-wiring factory for idle memory maintenance. Reuses
 * `buildAutoExtractionDeps` for the shared consolidator, a utility LLM client
 * for episodic distillation, and `lib/db/memories` for eviction.
 *
 * Returns `null` when no LLM client is available (the maintenance pass is then
 * skipped). Split into its own module so `maintenance.ts` can lazy-import it.
 */

import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import type { MemoryConfig } from "@/types/memory/memory"
import type { MemoryMaintenanceDeps } from "./maintenance"

export async function buildEpisodicMaintenanceDeps(
  params: { session: ChatSession | null | undefined; appSettings: AppSettings | null | undefined },
  config: MemoryConfig
): Promise<MemoryMaintenanceDeps | null> {
  const { buildUtilityLlmClient } = await import("@/lib/ai/generation/utility-client")
  const client = buildUtilityLlmClient({
    session: params.session ?? null,
    appSettings: params.appSettings ?? null,
    featureId: "memory-episodic-distill",
  })
  if (!client) return null

  const [{ buildAutoExtractionDeps }, { distillEpisodes }, memDb] = await Promise.all([
    import("@/lib/memory/write/run-memory-extraction"),
    import("@/lib/memory/write/run-episodic-distill"),
    import("@/lib/db/memories"),
  ])

  const auto = await buildAutoExtractionDeps(params, config)
  if (!auto) return null

  return {
    distillDeps: {
      distill: (transcript) => distillEpisodes(transcript, client),
      consolidate: auto.consolidate,
    },
    decayDeps: {
      listActive: (scope, characterId) =>
        memDb.listMemories({ scope, status: "active", characterId }),
      invalidate: (id) => memDb.invalidateMemory(id),
    },
  }
}
