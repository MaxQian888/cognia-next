import { appendMemoryAuditEvent } from "@/lib/db/memory-governance"
import { invalidateMemory, listMemories } from "@/lib/db/memories"
import { getSettings } from "@/lib/db/settings"
import { tryBuildMemoryVectorSink } from "@/lib/memory/runtime/build-deps"
import { resolveMemoryConfig } from "@/types/memory/memory"

interface TwinMemoryLifecycleDeps {
  list: typeof listMemories
  invalidate: typeof invalidateMemory
  audit: typeof appendMemoryAuditEvent
  buildSink: () => Promise<{ delete(ids: string[]): Promise<void> } | undefined>
}

const defaultDeps: TwinMemoryLifecycleDeps = {
  list: listMemories,
  invalidate: invalidateMemory,
  audit: appendMemoryAuditEvent,
  buildSink: async () => {
    const settings = await getSettings().catch(() => undefined)
    return tryBuildMemoryVectorSink(resolveMemoryConfig(settings?.memory))
  },
}

/** Invalidate and de-index every memory owned by a Twin's shared namespace. */
export async function invalidateTwinMemoryNamespace(
  twinId: string,
  deps: TwinMemoryLifecycleDeps = defaultDeps
): Promise<number> {
  const rows = await deps.list({ scope: "agent", agentId: `twin:${twinId}` })
  if (rows.length === 0) return 0
  const vectorIds = rows
    .map((memory) => memory.vectorDocId)
    .filter((id): id is string => Boolean(id))
  if (vectorIds.length > 0) {
    const sink = await deps.buildSink()
    await sink?.delete(vectorIds)
  }
  const active = rows.filter((memory) => memory.status === "active")
  for (const memory of active) {
    await deps.invalidate(memory.id)
    await deps.audit({
      action: "invalidated",
      memoryId: memory.id,
      reason: "twin_deleted",
    })
  }
  return active.length
}
