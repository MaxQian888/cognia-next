/**
 * CRUD layer for the `twinSources` Dexie table.
 *
 * The ingest pipeline (Phase 4) drives this table — every uploaded artifact
 * lands as a `TwinSource` row in `pending` state, transitions to `parsing`,
 * then `parsed` (or `failed`). The workbench UI (Phase 7) consumes these
 * via `useLiveQuery(listTwinSourcesByTwin)` to render the per-twin source
 * list with status badges.
 */

import type { TwinSource, TwinSourceKind, TwinSourceStatus } from "@/types/twin"
import { getDb } from "./schema"

function newId(): string {
  return "tws_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type TwinSourceDraft = Omit<TwinSource, "id" | "importedAt" | "chunkCount" | "status"> &
  Partial<Pick<TwinSource, "id" | "importedAt" | "chunkCount" | "status">>

export async function createTwinSource(draft: TwinSourceDraft): Promise<TwinSource> {
  const now = Date.now()
  const row: TwinSource = {
    id: draft.id ?? newId(),
    twinId: draft.twinId,
    kind: draft.kind,
    format: draft.format,
    source: draft.source,
    title: draft.title,
    bytes: draft.bytes,
    fingerprint: draft.fingerprint,
    chunkCount: draft.chunkCount ?? 0,
    status: draft.status ?? "pending",
    errorMessage: draft.errorMessage,
    importedAt: draft.importedAt ?? now,
    parsedAt: draft.parsedAt,
    tags: draft.tags,
    redacted: draft.redacted,
    redactionMapEnc: draft.redactionMapEnc,
  }
  await getDb().twinSources.add(row)
  return row
}

export async function getTwinSource(id: string): Promise<TwinSource | undefined> {
  return getDb().twinSources.get(id)
}

export async function listTwinSourcesByTwin(twinId: string): Promise<TwinSource[]> {
  return getDb().twinSources.where("twinId").equals(twinId).reverse().sortBy("importedAt")
}

export async function listTwinSourcesByTwinAndStatus(
  twinId: string,
  status: TwinSourceStatus
): Promise<TwinSource[]> {
  return getDb().twinSources.where(["twinId", "status"]).equals([twinId, status]).toArray()
}

export async function listTwinSourcesByTwinAndKind(
  twinId: string,
  kind: TwinSourceKind
): Promise<TwinSource[]> {
  return getDb().twinSources.where(["twinId", "kind"]).equals([twinId, kind]).toArray()
}

export async function findTwinSourceByFingerprint(
  twinId: string,
  fingerprint: string
): Promise<TwinSource | undefined> {
  return getDb()
    .twinSources.where("fingerprint")
    .equals(fingerprint)
    .filter((s) => s.twinId === twinId)
    .first()
}

export async function updateTwinSource(
  id: string,
  patch: Partial<Omit<TwinSource, "id" | "twinId">>
): Promise<TwinSource | undefined> {
  await getDb().twinSources.update(id, patch as Partial<TwinSource>)
  return getDb().twinSources.get(id)
}

export async function deleteTwinSource(id: string): Promise<void> {
  // Cascade-delete chunks for this source. The runtime (vector store side)
  // is responsible for removing remote vectors via `vectorDocId` before
  // calling this — see `lib/twin/ingest/persist.ts` (Phase 4).
  const db = getDb()
  await db.transaction("rw", db.twinSources, db.twinChunks, async () => {
    await db.twinChunks.where("sourceId").equals(id).delete()
    await db.twinSources.delete(id)
  })
}

export async function deleteAllTwinSourcesForTwin(twinId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.twinSources, db.twinChunks, async () => {
    await db.twinChunks.where("twinId").equals(twinId).delete()
    await db.twinSources.where("twinId").equals(twinId).delete()
  })
}
