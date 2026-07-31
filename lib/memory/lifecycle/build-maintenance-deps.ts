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
      listActive: (scope, namespace) =>
        memDb.listMemories({ scope, status: "active", ...namespace, exactNamespace: true }),
      invalidate: (id) => memDb.invalidateMemory(id),
    },
    recordDistillation: async (input, operations) => {
      const { createMemoryEvidence, appendMemoryAuditEvent } =
        await import("@/lib/db/memory-governance")
      const contaminationState = input.contaminationState ?? "clean"
      for (const operation of operations) {
        const memoryId =
          operation.op === "ADD" || operation.op === "CONFLICT"
            ? operation.memory.id
            : operation.op === "UPDATE"
              ? operation.targetId
              : undefined
        if (!memoryId) continue
        await memDb.updateMemory(memoryId, {
          evidenceState: "supported",
          reviewStatus: operation.op === "CONFLICT" ? "conflict" : "unreviewed",
          contaminationState,
          sensitivity: "normal",
        })
        await createMemoryEvidence({
          memoryId,
          kind: "message",
          sourceId: `session-distill:${input.source?.sessionId ?? "unknown"}`,
          sessionId: input.source?.sessionId,
          contaminationState,
          reviewed: false,
        })
        await appendMemoryAuditEvent({
          action:
            operation.op === "CONFLICT"
              ? "conflict"
              : operation.op === "ADD"
                ? "created"
                : "revised",
          memoryId,
          sessionId: input.source?.sessionId,
          reason: "session_distillation",
        })
      }
    },
    recordDecay: async ({ reason, memoryIds, sessionId }) => {
      const { appendMemoryAuditEvent } = await import("@/lib/db/memory-governance")
      for (const memoryId of memoryIds) {
        await appendMemoryAuditEvent({ action: "invalidated", memoryId, sessionId, reason })
      }
    },
  }
}
