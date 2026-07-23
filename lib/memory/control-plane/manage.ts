import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getSettings } from "@/lib/db/settings"
import {
  getMemory,
  hardDeleteMemory,
  invalidateMemory,
  listMemories,
  setMemoryPinned,
  updateMemory,
} from "@/lib/db/memories"
import {
  appendMemoryAuditEvent,
  createMemoryEvidence,
  deleteMemoryEvidence,
} from "@/lib/db/memory-governance"
import { tryBuildMemoryVectorSink } from "@/lib/memory/runtime/build-deps"
import { storeMemoryCore } from "@/lib/memory/api/store-memory"
import { resolveMemoryConfig, type MemoryScope, type MemoryType } from "@/types/memory/memory"

export type ManageMemoryCommand =
  | {
      kind: "create"
      text: string
      type: MemoryType
      importance: number
      tags: string[]
      scope?: MemoryScope
      characterId?: string
      projectId?: string
      agentId?: string
      branch?: string
      pathPattern?: string
    }
  | {
      kind: "update"
      id: string
      patch: { text?: string; tags?: string[]; importance?: number; key?: string }
    }
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "review"; id: string; status: "verified" | "conflict" }
  | { kind: "delete"; id: string }
  /**
   * Soft-delete (chat-chip 撤销 and conflict resolution): status →
   * `invalidated`, history preserved; mirrors `forgetExternalMemory`.
   */
  | { kind: "invalidate"; id: string; supersededById?: string }
  /**
   * One-shot conflict disposition from the comparison card. `keep` verifies
   * `keepId` and soft-invalidates `dropId` (superseded link); `keep-both`
   * verifies both and clears the conflict edges; `merge` writes `mergedText`
   * onto `keepId` (PII-gated) and soft-invalidates `dropId`.
   */
  | {
      kind: "resolve-conflict"
      keepId: string
      dropId: string
      mode: "keep" | "keep-both" | "merge"
      mergedText?: string
    }
  | { kind: "clear" }

export type ManageMemoryResult =
  | { ok: true; memoryId?: string; piiRedacted?: boolean }
  | { ok: false; reason: "not_found" | "disabled" | "temporary" | "pii_blocked" }

export async function manageMemory(command: ManageMemoryCommand): Promise<ManageMemoryResult> {
  if (command.kind === "create") {
    const result = await storeMemoryCore({
      text: command.text,
      type: command.type,
      importance: command.importance,
      tags: command.tags,
      scope: command.scope,
      characterId: command.characterId,
      projectId: command.projectId,
      agentId: command.agentId,
      branch: command.branch,
      pathPattern: command.pathPattern,
      provenance: "explicit",
      piiGate: "redact",
    })
    return result.ok
      ? { ok: true, memoryId: result.memoryId, piiRedacted: result.piiRedacted }
      : result
  }

  if (command.kind === "clear") {
    const rows = await listMemories()
    for (const row of rows) await manageMemory({ kind: "delete", id: row.id })
    return { ok: true }
  }

  if (command.kind === "resolve-conflict") {
    const [keep, drop] = await Promise.all([getMemory(command.keepId), getMemory(command.dropId)])
    if (!keep || !drop) return { ok: false, reason: "not_found" }
    const settings = await getSettings().catch(() => undefined)
    const config = resolveMemoryConfig(settings?.memory)

    let piiRedacted = false
    if (command.mode === "merge") {
      const raw = command.mergedText?.trim()
      if (!raw) throw new Error("resolve-conflict merge requires non-empty mergedText")
      const redacted = redactText(raw).redacted
      if (!hasNoLeakingPii(redacted)) return { ok: false, reason: "pii_blocked" }
      piiRedacted = redacted !== raw
      await updateMemory(command.keepId, {
        text: redacted,
        bumpVersion: true,
        reviewStatus: "verified",
        conflictWithIds: (keep.conflictWithIds ?? []).filter((id) => id !== command.dropId),
        evidenceState: "supported",
        contaminationState: "clean",
      })
      try {
        const sink = await tryBuildMemoryVectorSink(config)
        await sink?.upsert(keep.vectorDocId ?? keep.id, redacted)
      } catch {
        // Canonical update remains BM25-searchable.
      }
      await createMemoryEvidence({
        memoryId: command.keepId,
        kind: "manual",
        sourceId: `conflict-merge:${command.keepId}:${command.dropId}`,
        contaminationState: "clean",
        reviewed: true,
      })
      await appendMemoryAuditEvent({
        action: "revised",
        memoryId: command.keepId,
        reason: "conflict_merge",
      })
    } else {
      await updateMemory(command.keepId, {
        reviewStatus: "verified",
        conflictWithIds: (keep.conflictWithIds ?? []).filter((id) => id !== command.dropId),
      })
      await appendMemoryAuditEvent({
        action: "promoted",
        memoryId: command.keepId,
        reason: "conflict_resolved",
      })
    }

    if (command.mode === "keep-both") {
      await updateMemory(command.dropId, {
        reviewStatus: "verified",
        conflictWithIds: (drop.conflictWithIds ?? []).filter((id) => id !== command.keepId),
      })
      await appendMemoryAuditEvent({
        action: "promoted",
        memoryId: command.dropId,
        reason: "conflict_resolved",
      })
    } else {
      await invalidateMemory(command.dropId, command.keepId)
      if (drop.vectorDocId) {
        try {
          const sink = await tryBuildMemoryVectorSink(config)
          await sink?.delete([drop.vectorDocId])
        } catch {
          // Canonical invalidation is authoritative; vector cleanup is best-effort.
        }
      }
      await appendMemoryAuditEvent({
        action: "invalidated",
        memoryId: command.dropId,
        reason: "conflict_resolved",
      })
    }
    return { ok: true, memoryId: command.keepId, ...(piiRedacted ? { piiRedacted } : {}) }
  }

  const existing = await getMemory(command.id)
  if (!existing) return { ok: false, reason: "not_found" }

  if (command.kind === "pin") {
    await setMemoryPinned(command.id, command.pinned)
    await appendMemoryAuditEvent({
      action: command.pinned ? "pinned" : "unpinned",
      memoryId: command.id,
      reason: "user",
    })
    return { ok: true, memoryId: command.id }
  }

  if (command.kind === "review") {
    await updateMemory(command.id, { reviewStatus: command.status })
    await appendMemoryAuditEvent({
      action: command.status === "verified" ? "promoted" : "conflict",
      memoryId: command.id,
      reason: "user_review",
    })
    return { ok: true, memoryId: command.id }
  }

  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }

  if (command.kind === "delete") {
    const sink = await tryBuildMemoryVectorSink(config)
    try {
      await sink?.delete([existing.vectorDocId ?? existing.id])
    } catch {
      // Canonical deletion still proceeds; reconciliation removes stale vectors later.
    }
    await hardDeleteMemory(command.id)
    await deleteMemoryEvidence(command.id)
    await appendMemoryAuditEvent({ action: "deleted", memoryId: command.id, reason: "user" })
    return { ok: true, memoryId: command.id }
  }

  if (command.kind === "invalidate") {
    await invalidateMemory(command.id, command.supersededById)
    if (existing.vectorDocId) {
      try {
        const sink = await tryBuildMemoryVectorSink(config)
        await sink?.delete([existing.vectorDocId])
      } catch {
        // Canonical invalidation is authoritative; vector cleanup is best-effort.
      }
    }
    await appendMemoryAuditEvent({
      action: "invalidated",
      memoryId: command.id,
      reason: "user_undo",
    })
    return { ok: true, memoryId: command.id }
  }

  if (config.temporary) return { ok: false, reason: "temporary" }
  const rawText = command.patch.text?.trim()
  if (rawText === "") throw new Error("memory update requires non-empty text")
  const redactedText = rawText ? redactText(rawText).redacted : undefined
  if (redactedText && !hasNoLeakingPii(redactedText)) return { ok: false, reason: "pii_blocked" }

  await updateMemory(command.id, {
    ...command.patch,
    ...(redactedText !== undefined ? { text: redactedText, bumpVersion: true } : {}),
    evidenceState: "supported",
    reviewStatus: "verified",
    contaminationState: "clean",
  })
  if (redactedText !== undefined) {
    try {
      const sink = await tryBuildMemoryVectorSink(config)
      await sink?.upsert(existing.vectorDocId ?? existing.id, redactedText)
    } catch {
      // Canonical update remains BM25-searchable.
    }
  }
  await createMemoryEvidence({
    memoryId: command.id,
    kind: "manual",
    sourceId: `manual:${command.id}:v${existing.version + 1}`,
    contaminationState: "clean",
    reviewed: true,
  })
  await appendMemoryAuditEvent({ action: "revised", memoryId: command.id, reason: "user" })
  return {
    ok: true,
    memoryId: command.id,
    piiRedacted: rawText !== undefined && rawText !== redactedText,
  }
}
