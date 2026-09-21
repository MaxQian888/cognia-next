import type { CogniaDB } from "@/lib/db/schema"
import { parseAttachmentEvidenceSourceId } from "@cognia/memory/extract/project-attachment-evidence"

/**
 * When a message or a session is deleted, the claims that cited it must stop
 * being injected.
 *
 * WHY THIS IS POST-COMMIT AND NOT PART OF THE DELETE TRANSACTION. `clearMessages`
 * and `bulkDeleteSessions` already span the app's widest destructive
 * transactions; adding the memory tables would widen the write lock on the two
 * hottest ones. Vector cleanup is not transactional in the first place — it
 * lives in a shared store, which is exactly why `hardDeleteMemories` writes
 * `retrievalTombstones` instead of deleting inline. And there is already a
 * tested fan-out of this shape next door: `markMessagesRemoved` → the search
 * index drain.
 *
 * BUT with one difference from search, and it is the reason this is split in
 * two. A stale search hit merely fails to open. A claim that outlives its only
 * evidence is injected into the next prompt as a fact about the project. So the
 * REVOKE is synchronous — a small write to one table, on the same post-commit
 * tick as the deletion — and only the arithmetic that follows from it (recount
 * support, invalidate, tombstone the vector) is deferred to the job worker.
 *
 * Idempotent throughout: re-revoking an already-revoked row is a no-op write,
 * and the daily sweep repairs anything a crash lost between the two halves.
 */

/**
 * Narrow the revoked set to rows the re-check can actually act on.
 *
 * Personal memories have no citation model — `revalidateClaim` skips them — so
 * queuing one job per affected personal row would fill the queue with work whose
 * only outcome is `not_a_project_claim`. One bulk read is cheaper than that.
 */
async function projectClaimIdsAmong(memoryIds: readonly string[]): Promise<string[]> {
  if (memoryIds.length === 0) return []
  const { getDb } = await import("@/lib/db/schema")
  const rows = await getDb().memories.bulkGet([...memoryIds])
  return rows
    .filter((row) => row?.projectMemoryKind !== undefined && row.status === "active")
    .map((row) => row!.id)
}

async function queueRechecks(memoryIds: readonly string[]): Promise<number> {
  const targets = await projectClaimIdsAmong(memoryIds)
  if (targets.length === 0) return 0
  const { enqueueClaimRevalidation } = await import("./enqueue-reconcile")
  for (const memoryId of targets) await enqueueClaimRevalidation(memoryId)
  return targets.length
}

/**
 * Revoke every citation of `messageIds` and queue a re-check for each claim
 * that depended on them. Never throws — a deletion must succeed whether or not
 * the memory bookkeeping does.
 */
export async function revokeClaimsForDeletedMessages(
  messageIds: readonly string[]
): Promise<number> {
  if (messageIds.length === 0) return 0
  try {
    const { revokeMemoryEvidenceForMessages } = await import("@/lib/db/memory-governance")
    return await queueRechecks(await revokeMemoryEvidenceForMessages(messageIds))
  } catch {
    // The daily sweep is the backstop.
    return 0
  }
}

/**
 * The whole-session form: revoke everything captured in `sessionId`, cancel its
 * still-pending learning jobs, and queue a re-check for each affected claim.
 *
 * Not expressible as the message-id form. Turn-level citations carry a
 * `sessionId` and no `messageId`, so a sweep keyed on message ids would leave
 * them behind pointing at a conversation that no longer exists.
 */
export async function revokeClaimsForDeletedSession(sessionId: string): Promise<number> {
  if (!sessionId) return 0
  try {
    const { revokeMemoryEvidenceForSession, cancelMemoryJobsForSession } =
      await import("@/lib/db/memory-governance")
    const affected = await revokeMemoryEvidenceForSession(sessionId)
    await cancelMemoryJobsForSession(sessionId).catch(() => 0)
    return await queueRechecks(affected)
  } catch {
    return 0
  }
}

/**
 * Revoke attachment evidence and its claims in the asset mutation transaction.
 * Unlike the legacy message-delete fanout, this must finish before changed or
 * removed source bytes become visible. The caller includes both memory tables
 * in its transaction; failures propagate so source and evidence roll back together.
 */
export async function revokeClaimsForChangedAttachment(
  sessionId: string,
  assetId: string,
  db: Pick<CogniaDB, "memoryEvidence" | "memories">,
  now = Date.now()
): Promise<number> {
  const evidence = (await db.memoryEvidence.where("sessionId").equals(sessionId).toArray()).filter(
    (row) =>
      row.kind === "file" && parseAttachmentEvidenceSourceId(row.sourceId)?.attachmentId === assetId
  )
  if (!evidence.length) return 0
  await db.memoryEvidence.bulkPut(
    evidence.map((row) => ({ ...row, validationState: "revoked" as const, validatedAt: now }))
  )
  const ids = [...new Set(evidence.flatMap((row) => (row.memoryId ? [row.memoryId] : [])))]
  const memories = await db.memories.bulkGet(ids)
  const claims = memories.filter((row) => row?.projectMemoryKind && row.status === "active")
  for (const row of claims) {
    await db.memories.update(row!.id, {
      status: "invalidated",
      staleness: "expired",
      invalidatedAt: now,
      validatedAt: now,
      updatedAt: now,
    })
  }
  return claims.length
}
