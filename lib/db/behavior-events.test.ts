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
