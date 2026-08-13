import type { MatrixTimelineEvent } from "@/lib/connectors/adapters/matrix/parse"
import { getDb } from "./schema"

export const MATRIX_PENDING_EVENT_CAP = 10_000
export const MATRIX_RECOVERY_REQUIRED_ATTEMPTS = 8

export type MatrixPendingEncryptedEventState = "pending" | "recovery_required"

export interface MatrixPendingEncryptedEventRow {
  id: string
  adapterId: string
  eventId: string
  roomId: string
  rawEvent: MatrixTimelineEvent
  attempts: number
  firstSeenAt: number
  updatedAt: number
  nextAttemptAt: number
  state: MatrixPendingEncryptedEventState
  lastError?: string
}

export type PersistMatrixPendingEventResult =
  | { ok: true; row: MatrixPendingEncryptedEventRow; deduplicated: boolean }
  | { ok: false; reason: "capacity" }

function rowId(adapterId: string, eventId: string): string {
  return `${adapterId}\u0000${eventId}`
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.max(0, attempts - 1))
}

export async function persistMatrixPendingEncryptedEvent(input: {
  adapterId: string
  roomId: string
  event: MatrixTimelineEvent
}): Promise<PersistMatrixPendingEventResult> {
  const db = getDb()
  return db.transaction("rw", db.matrixPendingEncryptedEvents, async () => {
    const id = rowId(input.adapterId, input.event.event_id)
    const existing = await db.matrixPendingEncryptedEvents.get(id)
    const now = Date.now()
    if (existing) {
      const row = { ...existing, roomId: input.roomId, rawEvent: input.event, updatedAt: now }
      await db.matrixPendingEncryptedEvents.put(row)
      return { ok: true, row, deduplicated: true }
    }

    // `recovery_required` rows remain retained and visible by design, so they
    // must consume the same per-adapter bound as retryable rows. Otherwise a
    // long-lived broken room could grow without limit after rows age out of
    // the retry state.
    const retainedCount = await db.matrixPendingEncryptedEvents
      .where("adapterId")
      .equals(input.adapterId)
      .count()
    if (retainedCount >= MATRIX_PENDING_EVENT_CAP) return { ok: false, reason: "capacity" }

    const row: MatrixPendingEncryptedEventRow = {
      id,
      adapterId: input.adapterId,
      eventId: input.event.event_id,
      roomId: input.roomId,
      rawEvent: input.event,
      attempts: 0,
      firstSeenAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      state: "pending",
    }
    await db.matrixPendingEncryptedEvents.add(row)
    return { ok: true, row, deduplicated: false }
  })
}

// Dexie.minKey/maxKey cannot be imported as values through a type-only schema
// path in every static-export bundle; infinities are valid numeric index bounds.
const DexieMinKey = Number.NEGATIVE_INFINITY
const DexieMaxKey = Number.POSITIVE_INFINITY

export async function listRetryableMatrixPendingEvents(
  adapterId: string,
  now = Date.now(),
  limit = 100
): Promise<MatrixPendingEncryptedEventRow[]> {
  return getDb()
    .matrixPendingEncryptedEvents.where("[adapterId+state+nextAttemptAt]")
    .between([adapterId, "pending", DexieMinKey], [adapterId, "pending", now])
    .limit(limit)
    .toArray()
}

export async function markMatrixPendingEventFailed(id: string, error: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.matrixPendingEncryptedEvents, async () => {
    const row = await db.matrixPendingEncryptedEvents.get(id)
    if (!row) return
    const attempts = row.attempts + 1
    const now = Date.now()
    await db.matrixPendingEncryptedEvents.put({
      ...row,
      attempts,
      updatedAt: now,
      nextAttemptAt: now + retryDelayMs(attempts),
      state: attempts >= MATRIX_RECOVERY_REQUIRED_ATTEMPTS ? "recovery_required" : "pending",
      lastError: error,
    })
  })
}

export async function deleteMatrixPendingEvent(id: string): Promise<void> {
  await getDb().matrixPendingEncryptedEvents.delete(id)
}

export async function countMatrixRecoveryRequired(adapterId: string): Promise<number> {
  return getDb()
    .matrixPendingEncryptedEvents.where("[adapterId+state+nextAttemptAt]")
    .between(
      [adapterId, "recovery_required", DexieMinKey],
      [adapterId, "recovery_required", DexieMaxKey]
    )
    .count()
}
