import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getSettings } from "@/lib/db/settings"
import {
  getMemory,
  hardDeleteMemory,
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
