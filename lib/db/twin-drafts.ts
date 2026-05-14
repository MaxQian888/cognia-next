/**
 * CRUD layer for the `twinDrafts` Dexie table.
 *
 * The distill pipeline (Phase 5) writes drafts here in bulk. The workbench
 * (Phase 7) lists them sorted by `evaluation.qualityScore` ascending so the
 * lowest-confidence drafts surface first. On accept the draft is converted
 * into a real `Character` or `Skill` row by the workbench layer; the draft
 * itself is then marked `accepted` and retains its provenance for audit.
 */

import type { TwinDraft, TwinDraftKind, TwinDraftPayload, TwinDraftStatus } from "@/types/twin"
import { getDb } from "./schema"

function newId(): string {
  return "twd_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type TwinDraftCreate = Omit<TwinDraft, "id" | "status" | "createdAt"> &
  Partial<Pick<TwinDraft, "id" | "status" | "createdAt">>

export async function createTwinDraft(draft: TwinDraftCreate): Promise<TwinDraft> {
  const row: TwinDraft = {
    id: draft.id ?? newId(),
    twinId: draft.twinId,
    jobId: draft.jobId,
    kind: draft.kind,
    payload: draft.payload,
    provenance: draft.provenance,
    evaluation: draft.evaluation,
    status: draft.status ?? "pending",
    reviewedAt: draft.reviewedAt,
    reviewerNote: draft.reviewerNote,
    acceptedAsId: draft.acceptedAsId,
    createdAt: draft.createdAt ?? Date.now(),
  }
  await getDb().twinDrafts.add(row)
  return row
}

export async function bulkCreateTwinDrafts(drafts: TwinDraftCreate[]): Promise<TwinDraft[]> {
  if (drafts.length === 0) return []
  const now = Date.now()
  const rows: TwinDraft[] = drafts.map((draft) => ({
    id: draft.id ?? newId(),
    twinId: draft.twinId,
    jobId: draft.jobId,
    kind: draft.kind,
    payload: draft.payload,
    provenance: draft.provenance,
    evaluation: draft.evaluation,
    status: draft.status ?? "pending",
    reviewedAt: draft.reviewedAt,
    reviewerNote: draft.reviewerNote,
    acceptedAsId: draft.acceptedAsId,
    createdAt: draft.createdAt ?? now,
  }))
  await getDb().twinDrafts.bulkAdd(rows)
  return rows
}

export async function getTwinDraft(id: string): Promise<TwinDraft | undefined> {
  return getDb().twinDrafts.get(id)
}

export async function listTwinDraftsByTwin(twinId: string): Promise<TwinDraft[]> {
  return getDb().twinDrafts.where("twinId").equals(twinId).reverse().sortBy("createdAt")
}

export async function listTwinDraftsByTwinAndStatus(
  twinId: string,
  status: TwinDraftStatus
): Promise<TwinDraft[]> {
  return getDb().twinDrafts.where(["twinId", "status"]).equals([twinId, status]).toArray()
}

export async function listTwinDraftsByTwinAndKind(
  twinId: string,
  kind: TwinDraftKind
): Promise<TwinDraft[]> {
  return getDb().twinDrafts.where(["twinId", "kind"]).equals([twinId, kind]).toArray()
}

export async function listPendingTwinDraftsSortedByQuality(twinId: string): Promise<TwinDraft[]> {
  const pending = await listTwinDraftsByTwinAndStatus(twinId, "pending")
  // Lower quality score = needs review more urgently. Drafts without an
  // evaluation sort last (treated as "trust unknown").
  return pending.sort((a, b) => {
    const sa = a.evaluation?.qualityScore ?? Number.POSITIVE_INFINITY
    const sb = b.evaluation?.qualityScore ?? Number.POSITIVE_INFINITY
    return sa - sb
  })
}

export async function updateTwinDraft(
  id: string,
  patch: Partial<Omit<TwinDraft, "id" | "twinId">>
): Promise<TwinDraft | undefined> {
  await getDb().twinDrafts.update(id, patch as Partial<TwinDraft>)
  return getDb().twinDrafts.get(id)
}

export async function markTwinDraftAccepted(
  id: string,
  acceptedAsId: string,
  reviewerNote?: string
): Promise<TwinDraft | undefined> {
  return updateTwinDraft(id, {
    status: "accepted",
    acceptedAsId,
    reviewerNote,
    reviewedAt: Date.now(),
  })
}

export async function markTwinDraftRejected(
  id: string,
  reviewerNote?: string
): Promise<TwinDraft | undefined> {
  return updateTwinDraft(id, {
    status: "rejected",
    reviewerNote,
    reviewedAt: Date.now(),
  })
}

/**
 * Overwrite the draft's payload (Character / Skill body) and flip the
 * row to `status="edited"`. The workbench calls this after the reviewer
 * tweaks a pending draft in the DraftEditorDialog — they're saving the
 * edits separately from accepting the draft, so we keep the row in a
 * reviewable state.
 */
export async function updateTwinDraftPayload(
  id: string,
  payload: TwinDraftPayload,
  reviewerNote?: string
): Promise<TwinDraft | undefined> {
  return updateTwinDraft(id, {
    payload,
    status: "edited",
    reviewerNote,
    reviewedAt: Date.now(),
  })
}

/** Flip a draft to `status="edited"` without touching the payload. */
export async function markTwinDraftEdited(
  id: string,
  reviewerNote?: string
): Promise<TwinDraft | undefined> {
  return updateTwinDraft(id, {
    status: "edited",
    reviewerNote,
    reviewedAt: Date.now(),
  })
}

export async function deleteTwinDraft(id: string): Promise<void> {
  await getDb().twinDrafts.delete(id)
}

export async function deleteTwinDraftsByJob(jobId: string): Promise<number> {
  return getDb().twinDrafts.where("jobId").equals(jobId).delete()
}
