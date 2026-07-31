import { getDb } from "./schema"
import type { BehaviorEventRow } from "./behavior-event-types"

export type BehaviorEventDraft = Omit<BehaviorEventRow, "id" | "at"> &
  Partial<Pick<BehaviorEventRow, "id" | "at">>

export interface BehaviorEventRetention {
  maxEntries: number
  maxAgeDays: number
}

export async function appendBehaviorEvent(
  draft: BehaviorEventDraft,
  retention?: BehaviorEventRetention
): Promise<BehaviorEventRow> {
  const row: BehaviorEventRow = {
    id: draft.id ?? crypto.randomUUID(),
    eventName: draft.eventName,
    at: draft.at ?? Date.now(),
    sessionId: draft.sessionId,
    attributes: draft.attributes,
  }
  const table = getDb().behaviorEvents
  await table.db.transaction("rw", table, async () => {
    await table.add(row)
    if (!retention) return

    const maxAgeDays = Math.max(1, retention.maxAgeDays)
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    await table.where("at").below(cutoff).delete()

    const maxEntries = Math.max(1, Math.floor(retention.maxEntries))
    const overflow = (await table.count()) - maxEntries
    if (overflow > 0) {
      const oldestIds = (await table.orderBy("at").limit(overflow).primaryKeys()) as string[]
      await table.bulkDelete(oldestIds)
    }
  })
  return row
}

export async function listBehaviorEvents(limit = 1000): Promise<BehaviorEventRow[]> {
  const query = getDb().behaviorEvents.orderBy("at").reverse()
  return limit > 0 ? query.limit(limit).toArray() : query.toArray()
}

export type BehaviorEventExportFormat = "json" | "csv"

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export async function exportBehaviorEvents(
  format: BehaviorEventExportFormat = "json"
): Promise<string> {
  const rows = await listBehaviorEvents(0)
  if (format === "json") return JSON.stringify(rows, null, 2)

  const header = ["id", "eventName", "at", "sessionId", "attributes"]
  const lines = rows.map((row) =>
    [row.id, row.eventName, row.at, row.sessionId, JSON.stringify(row.attributes)]
      .map(csvCell)
      .join(",")
  )
  return [header.join(","), ...lines].join("\r\n") + "\r\n"
}

export async function clearBehaviorEvents(): Promise<void> {
  await getDb().behaviorEvents.clear()
}
