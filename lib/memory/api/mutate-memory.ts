/**
 * Shared mutation path for external memory surfaces (plugin `ctx.memory`
 * update/forget, MCP `memory_update`/`memory_forget`, companion RPC).
 *
 * - `updateExternalMemory`: patch text / importance / tags / key on an existing
 *   row. Text patches are PII-gated (block-only) and bump `version`; the vector
 *   doc is re-upserted best-effort so semantic search stays in sync.
 * - `forgetExternalMemory`: soft-invalidate (the consolidation-path contract —
 *   hard deletes stay user-panel-only). No PII risk, so it only requires
 *   `memory.enabled` (allowed even in temporary mode: forgetting reduces data).
 */

import { clampImportance } from "./store-memory"

export interface UpdateExternalMemoryPatch {
  text?: string
  importance?: number
  tags?: string[]
  key?: string
  pinned?: boolean
}

export type MutateExternalMemoryResult =
  { ok: true } | { ok: false; reason: "disabled" | "temporary" | "pii_blocked" | "not_found" }

export async function updateExternalMemory(
  id: string,
  patch: UpdateExternalMemoryPatch
): Promise<MutateExternalMemoryResult> {
  const text = patch.text?.trim()
  if (text === "") throw new Error("memory update: 'text' must be non-empty when provided")
  if (
    text === undefined &&
    patch.importance === undefined &&
    !patch.tags &&
    patch.key === undefined &&
    patch.pinned === undefined
  ) {
    throw new Error("memory update requires at least one field to change")
  }

  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }

  if (text !== undefined) {
    const { hasNoLeakingPii } = await import("@cognia/redact")
    if (!hasNoLeakingPii(text)) return { ok: false, reason: "pii_blocked" }
  }

  const memDb = await import("@/lib/db/memories")
  const existing = await memDb.getMemory(id)
  if (!existing) return { ok: false, reason: "not_found" }

  await memDb.updateMemory(id, {
    ...(text !== undefined ? { text, bumpVersion: true } : {}),
    ...(patch.importance !== undefined ? { importance: clampImportance(patch.importance) } : {}),
    ...(patch.tags ? { tags: patch.tags.map((t) => t.trim()).filter(Boolean) } : {}),
    ...(patch.key !== undefined ? { key: patch.key } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
  })

  const { appendMemoryAuditEvent } = await import("@/lib/db/memory-governance")
  if (
    text !== undefined ||
    patch.importance !== undefined ||
    patch.tags ||
    patch.key !== undefined
  ) {
    await appendMemoryAuditEvent({
      action: "revised",
      memoryId: id,
      reason: "external_update",
    })
  }
  if (patch.pinned !== undefined && patch.pinned !== existing.pinned) {
    await appendMemoryAuditEvent({
      action: patch.pinned ? "pinned" : "unpinned",
      memoryId: id,
      reason: "external_update",
    })
  }

  // Keep the vector doc in sync with a text change — best-effort, the Dexie
  // update is authoritative and BM25 recall works without the vector.
  if (text !== undefined && existing.vectorDocId) {
    try {
      const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
      const sink = await tryBuildMemoryVectorSink(config)
      await sink?.upsert(existing.vectorDocId, text)
    } catch {
      // ignore — keep the Dexie update
    }
  }
  return { ok: true }
}

export async function forgetExternalMemory(id: string): Promise<MutateExternalMemoryResult> {
  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }

  const memDb = await import("@/lib/db/memories")
  const existing = await memDb.getMemory(id)
  if (!existing) return { ok: false, reason: "not_found" }

  await memDb.invalidateMemory(id)
  if (existing.vectorDocId) {
    try {
      const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
      const sink = await tryBuildMemoryVectorSink(config)
      await sink?.delete([existing.vectorDocId])
    } catch {
      // Canonical invalidation is authoritative; vector cleanup is best-effort.
    }
  }
  const { appendMemoryAuditEvent } = await import("@/lib/db/memory-governance")
  await appendMemoryAuditEvent({
    action: "invalidated",
    memoryId: id,
    reason: "external_forget",
  })
  return { ok: true }
}
