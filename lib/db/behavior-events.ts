import { getDb } from "./schema"
import type { BehaviorEventRow } from "./behavior-event-types"

export type BehaviorEventDraft = Omit<BehaviorEventRow, "id" | "at"> &
  Partial<Pick<BehaviorEventRow, "id" | "at">>

export async function appendBehaviorEvent(draft: BehaviorEventDraft): Promise<BehaviorEventRow> {
  const row: BehaviorEventRow = {
    id: draft.id ?? crypto.randomUUID(),
    eventName: draft.eventName,
    at: draft.at ?? Date.now(),
    sessionId: draft.sessionId,
    attributes: draft.attributes,
  }
  await getDb().behaviorEvents.add(row)
  return row
}

export async function listBehaviorEvents(limit = 1000): Promise<BehaviorEventRow[]> {
  const query = getDb().behaviorEvents.orderBy("at").reverse()
  return limit > 0 ? query.limit(limit).toArray() : query.toArray()
}

export async function exportBehaviorEvents(): Promise<string> {
  return JSON.stringify(await listBehaviorEvents(0), null, 2)
}

export async function clearBehaviorEvents(): Promise<void> {
  await getDb().behaviorEvents.clear()
}
