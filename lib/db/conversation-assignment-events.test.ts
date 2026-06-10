import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "./schema"
import {
  appendAssignmentEvent,
  listAssignmentEvents,
  MAX_ASSIGNMENT_EVENTS_PER_CONVERSATION,
} from "./conversation-assignment-events"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

describe("conversation-assignment-events", () => {
  it("appends and lists events oldest → newest", async () => {
    await appendAssignmentEvent({ conversationKey: "k1", kind: "assigned", at: 30 })
    await appendAssignmentEvent({ conversationKey: "k1", kind: "status.resolved", at: 10 })
    await appendAssignmentEvent({ conversationKey: "k1", kind: "label.added", at: 20 })
    const trail = await listAssignmentEvents("k1")
    expect(trail.map((e) => e.at)).toEqual([10, 20, 30])
    expect(trail.map((e) => e.kind)).toEqual(["status.resolved", "label.added", "assigned"])
  })

  it("isolates events by conversationKey", async () => {
    await appendAssignmentEvent({ conversationKey: "k1", kind: "assigned", at: 1 })
    await appendAssignmentEvent({ conversationKey: "k2", kind: "assigned", at: 1 })
    expect(await listAssignmentEvents("k1")).toHaveLength(1)
    expect(await listAssignmentEvents("k2")).toHaveLength(1)
  })

  it("stamps `at` from Date.now() when omitted and carries fields", async () => {
    const ev = await appendAssignmentEvent({
      conversationKey: "k1",
      kind: "reassigned",
      fields: { from: "a", to: "b" },
    })
    expect(ev.at).toBeGreaterThan(0)
    expect(ev.fields).toEqual({ from: "a", to: "b" })
  })

  it("prunes the oldest beyond the per-conversation cap", async () => {
    const total = MAX_ASSIGNMENT_EVENTS_PER_CONVERSATION + 5
    for (let i = 0; i < total; i++) {
      await appendAssignmentEvent({ conversationKey: "k1", kind: "label.added", at: i + 1 })
    }
    const trail = await listAssignmentEvents("k1")
    expect(trail).toHaveLength(MAX_ASSIGNMENT_EVENTS_PER_CONVERSATION)
    // Oldest five (at 1..5) evicted → earliest remaining is at 6.
    expect(trail[0].at).toBe(6)
  })
})
