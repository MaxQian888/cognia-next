/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import {
  appendBehaviorEvent,
  clearBehaviorEvents,
  exportBehaviorEvents,
  listBehaviorEvents,
} from "./behavior-events"
import { __resetDbForTesting, getDb } from "./schema"

beforeEach(async () => {
  const db = getDb()
  await db.delete()
  __resetDbForTesting()
})

afterAll(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("appends, lists newest first, exports, and clears behavior events", async () => {
  await appendBehaviorEvent({
    id: "first",
    at: 1,
    eventName: "chat.message.sent",
    sessionId: "session-1",
    attributes: { provider: "anthropic" },
  })
  await appendBehaviorEvent({
    id: "second",
    at: 2,
    eventName: "workflow.run.started",
    attributes: { source: "manual" },
  })

  expect((await listBehaviorEvents()).map((row) => row.id)).toEqual(["second", "first"])
  expect(JSON.parse(await exportBehaviorEvents())).toHaveLength(2)

  await clearBehaviorEvents()
  expect(await listBehaviorEvents()).toEqual([])
})

it("generates identity and time when callers omit them", async () => {
  const row = await appendBehaviorEvent({
    eventName: "telemetry.preference.changed",
    attributes: { enabled: true },
  })
  expect(row.id).toMatch(/\S+/)
  expect(row.at).toBeGreaterThan(0)
  expect(row.sessionId).toBeUndefined()
})

it("enforces age and count retention when appending", async () => {
  const now = 3 * 24 * 60 * 60 * 1000
  jest.spyOn(Date, "now").mockReturnValue(now)
  await appendBehaviorEvent(
    { id: "expired", at: 0, eventName: "chat.message.sent", attributes: {} },
    { maxEntries: 2, maxAgeDays: 1 }
  )
  await appendBehaviorEvent(
    { id: "middle", at: now - 2, eventName: "chat.message.sent", attributes: {} },
    { maxEntries: 2, maxAgeDays: 1 }
  )
  await appendBehaviorEvent(
    { id: "latest", at: now - 1, eventName: "workflow.run.completed", attributes: {} },
    { maxEntries: 2, maxAgeDays: 1 }
  )
  await appendBehaviorEvent(
    { id: "newest", at: now, eventName: "connector.message.sent", attributes: {} },
    { maxEntries: 2, maxAgeDays: 1 }
  )

  expect((await listBehaviorEvents(0)).map((row) => row.id)).toEqual(["newest", "latest"])
  jest.restoreAllMocks()
})

it("exports RFC 4180 CSV without flattening typed attributes", async () => {
  await appendBehaviorEvent({
    id: "csv-1",
    at: 123,
    eventName: "connector.message.sent",
    sessionId: "session,1",
    attributes: { outcome: "failed", errorCode: 'bad "gateway"' },
  })

  const csv = await exportBehaviorEvents("csv")
  expect(csv).toBe(
    "id,eventName,at,sessionId,attributes\r\n" +
      'csv-1,connector.message.sent,123,"session,1","{""outcome"":""failed"",""errorCode"":""bad \\""gateway\\""""}"\r\n'
  )
})
