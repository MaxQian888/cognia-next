/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Dexie `delete()` + `open()` per test is well past the 5 s default hook
// budget when the suite runs alongside the repo's heavier DB suites.
jest.setTimeout(30_000)

import { getDb } from "@/lib/db/schema"
import { readForResolution, upsertByConversationKey } from "@/lib/db/conversation-overrides"

import {
  CONVERSATION_OVERRIDE_MUTATION_KINDS,
  applyConversationOverrideMutation,
  applyOptimisticOverrideMutation,
  conversationKeyOfMutation,
  isConversationOverrideMutation,
  type ConversationOverrideMutation,
} from "./override-mutation"

const KEY = "telegram:tg-1:555"
const SESSION = "s-1"

async function seedRow(): Promise<void> {
  await upsertByConversationKey({ conversationKey: KEY, sessionId: SESSION })
}

/** The append-only assignment trail rows for {@link KEY}, oldest first. */
async function assignmentEvents() {
  return getDb().conversationAssignmentEvents.where("conversationKey").equals(KEY).sortBy("at")
}

beforeEach(async () => {
  await getDb().delete()
  await getDb().open()
})

describe("conversationKeyOfMutation", () => {
  it("reads the key off every kind", () => {
    expect(conversationKeyOfMutation({ kind: "setPinned", conversationKey: KEY })).toBe(KEY)
    expect(
      conversationKeyOfMutation({ kind: "upsert", input: { conversationKey: KEY, sessionId: SESSION } })
    ).toBe(KEY)
  })

  it("is undefined for values that are not mutations", () => {
    expect(conversationKeyOfMutation(null)).toBeUndefined()
    expect(conversationKeyOfMutation("nope")).toBeUndefined()
    expect(conversationKeyOfMutation({ kind: "upsert", input: {} })).toBeUndefined()
    expect(conversationKeyOfMutation({ kind: "setPinned" })).toBeUndefined()
  })
})

describe("isConversationOverrideMutation — wire validation", () => {
  it("accepts one well-formed value per kind", () => {
    const valid: ConversationOverrideMutation[] = [
      { kind: "upsert", input: { conversationKey: KEY, sessionId: SESSION } },
      { kind: "patch", conversationKey: KEY, patch: { pinned: true } },
      {
        kind: "configSection",
        adapterId: "tg-1",
        conversationKey: KEY,
        section: "behavior",
        patch: {},
      },
      { kind: "setStatus", conversationKey: KEY, status: "resolved" },
      { kind: "setAssignee", conversationKey: KEY, assignee: { kind: "human", id: "u1" } },
      { kind: "setAssignee", conversationKey: KEY, assignee: null },
      { kind: "addLabel", conversationKey: KEY, labelId: "l1" },
      { kind: "removeLabel", conversationKey: KEY, labelId: "l1" },
      { kind: "setPinned", conversationKey: KEY, pinned: true },
      { kind: "setArchived", conversationKey: KEY, archived: false },
      { kind: "delete", conversationKey: KEY },
    ]
    for (const mutation of valid) {
      expect(isConversationOverrideMutation(mutation)).toBe(true)
    }
    // Every kind in the union is covered by the fixtures above — otherwise a
    // new kind could ship with no wire validation at all.
    expect(new Set(valid.map((m) => m.kind)).size).toBe(
      CONVERSATION_OVERRIDE_MUTATION_KINDS.length
    )
  })

  it("rejects malformed values a hostile / stale client could send", () => {
    const invalid: unknown[] = [
      null,
      "setPinned",
      [],
      { kind: "nope", conversationKey: KEY },
      { kind: "setPinned", conversationKey: KEY }, // missing `pinned`
      { kind: "setPinned", conversationKey: KEY, pinned: "yes" },
      { kind: "setArchived", conversationKey: KEY, archived: 1 },
      { kind: "patch", conversationKey: KEY }, // missing `patch`
      { kind: "patch", conversationKey: KEY, patch: [] },
      { kind: "upsert", input: { conversationKey: KEY } }, // no sessionId
      { kind: "setStatus", conversationKey: KEY, status: "archived" },
      { kind: "setStatus", conversationKey: KEY, status: "snoozed", snoozeUntil: "soon" },
      { kind: "configSection", conversationKey: KEY, patch: {}, section: "behavior" }, // no adapterId
      { kind: "configSection", adapterId: "a", conversationKey: KEY, patch: {}, section: "nope" },
      { kind: "setAssignee", conversationKey: KEY, assignee: { kind: "robot", id: "x" } },
      { kind: "setAssignee", conversationKey: KEY, assignee: { kind: "human" } },
      { kind: "addLabel", conversationKey: KEY }, // missing labelId
      { kind: "delete" }, // missing key
    ]
    for (const value of invalid) {
      expect(isConversationOverrideMutation(value)).toBe(false)
    }
  })
})

describe("applyConversationOverrideMutation — host semantics", () => {
  it("upserts and patches", async () => {
    await applyConversationOverrideMutation({
      kind: "upsert",
      input: { conversationKey: KEY, sessionId: SESSION, pinned: true },
    })
    expect((await readForResolution(KEY))?.pinned).toBe(true)

    await applyConversationOverrideMutation({
      kind: "patch",
      conversationKey: KEY,
      patch: { archived: true },
    })
    const row = await readForResolution(KEY)
    expect(row?.archived).toBe(true)
    expect(row?.pinned).toBe(true)
  })

  it("sets status, labels, pin and archive through the real primitives", async () => {
    await seedRow()
    await applyConversationOverrideMutation({
      kind: "setStatus",
      conversationKey: KEY,
      status: "resolved",
    })
    expect((await readForResolution(KEY))?.status).toBe("resolved")

    await applyConversationOverrideMutation({ kind: "addLabel", conversationKey: KEY, labelId: "l1" })
    await applyConversationOverrideMutation({ kind: "addLabel", conversationKey: KEY, labelId: "l2" })
    expect((await readForResolution(KEY))?.labelIds).toEqual(["l1", "l2"])

    await applyConversationOverrideMutation({
      kind: "removeLabel",
      conversationKey: KEY,
      labelId: "l1",
    })
    expect((await readForResolution(KEY))?.labelIds).toEqual(["l2"])

    await applyConversationOverrideMutation({ kind: "setPinned", conversationKey: KEY, pinned: true })
    expect((await readForResolution(KEY))?.pinned).toBe(true)
    await applyConversationOverrideMutation({
      kind: "setArchived",
      conversationKey: KEY,
      archived: true,
    })
    expect((await readForResolution(KEY))?.archived).toBe(true)
  })

  it("creates the row when setPinned / setArchived land before it exists", async () => {
    // A thin client can pin a conversation whose override row was never
    // materialised on this host; the legacy primitives take a row id, so the
    // mutation has to fall back to a patch that creates it.
    const row = await applyConversationOverrideMutation({
      kind: "setPinned",
      conversationKey: KEY,
      pinned: true,
      sessionId: SESSION,
    })
    expect(row?.pinned).toBe(true)
    expect((await readForResolution(KEY))?.pinned).toBe(true)
  })

  it("stamps the assignment trail with the caller's provenance", async () => {
    await seedRow()
    await applyConversationOverrideMutation(
      { kind: "setAssignee", conversationKey: KEY, assignee: { kind: "human", id: "u9" } },
      { via: "device:phone-1" }
    )
    const row = await readForResolution(KEY)
    expect(row?.assignee).toEqual({ kind: "human", id: "u9" })
    // The append-only trail is what makes a phone-originated reassignment
    // attributable; the relay would be an anonymity hole without it.
    const events = await assignmentEvents()
    expect(events.map((e) => e.kind)).toEqual(["assigned"])
    expect(events[0]?.fields?.via).toBe("device:phone-1")
    expect(events[0]?.fields?.to).toEqual({ kind: "human", id: "u9" })
  })

  it("prefers the mutation's own `via` over the caller default", async () => {
    await seedRow()
    await applyConversationOverrideMutation(
      {
        kind: "setAssignee",
        conversationKey: KEY,
        assignee: { kind: "team", id: "t1" },
        via: "sla-escalation",
      },
      { via: "device:phone-1" }
    )
    const events = await assignmentEvents()
    expect(events[0]?.fields?.via).toBe("sla-escalation")
  })

  it("deletes the row", async () => {
    await seedRow()
    await applyConversationOverrideMutation({ kind: "delete", conversationKey: KEY })
    expect(await readForResolution(KEY)).toBeUndefined()
  })
})

describe("applyOptimisticOverrideMutation — thin-client mirror", () => {
  it("mirrors only the named fields and writes no assignment trail", async () => {
    await seedRow()
    await applyOptimisticOverrideMutation({
      kind: "setAssignee",
      conversationKey: KEY,
      assignee: { kind: "human", id: "u9" },
    })
    const row = await readForResolution(KEY)
    expect(row?.assignee).toEqual({ kind: "human", id: "u9" })
    expect(row?.assigneeKind).toBe("human")
    // The host owns the trail; a mirror that wrote one would double-count
    // once the authoritative row syncs back.
    expect(await assignmentEvents()).toHaveLength(0)
  })

  it("skips rows it cannot create — the sync will materialise them", async () => {
    await applyOptimisticOverrideMutation({
      kind: "setPinned",
      conversationKey: "telegram:tg-1:absent",
      pinned: true,
    })
    expect(await readForResolution("telegram:tg-1:absent")).toBeUndefined()
  })

  it("creates the row when the mutation carries a sessionId", async () => {
    await applyOptimisticOverrideMutation({
      kind: "setPinned",
      conversationKey: KEY,
      pinned: true,
      sessionId: SESSION,
    })
    expect((await readForResolution(KEY))?.pinned).toBe(true)
  })

  it("is idempotent for label add / remove", async () => {
    await seedRow()
    await applyOptimisticOverrideMutation({ kind: "addLabel", conversationKey: KEY, labelId: "l1" })
    await applyOptimisticOverrideMutation({ kind: "addLabel", conversationKey: KEY, labelId: "l1" })
    expect((await readForResolution(KEY))?.labelIds).toEqual(["l1"])

    await applyOptimisticOverrideMutation({
      kind: "removeLabel",
      conversationKey: KEY,
      labelId: "l1",
    })
    await applyOptimisticOverrideMutation({
      kind: "removeLabel",
      conversationKey: KEY,
      labelId: "l1",
    })
    expect((await readForResolution(KEY))?.labelIds).toEqual([])
  })

  it("clears snoozeUntil when the status leaves `snoozed`", async () => {
    await seedRow()
    await applyOptimisticOverrideMutation({
      kind: "setStatus",
      conversationKey: KEY,
      status: "snoozed",
      snoozeUntil: 12_345,
    })
    expect((await readForResolution(KEY))?.snoozeUntil).toBe(12_345)

    await applyOptimisticOverrideMutation({
      kind: "setStatus",
      conversationKey: KEY,
      status: "open",
    })
    const row = await readForResolution(KEY)
    expect(row?.status).toBe("open")
    expect(row?.snoozeUntil).toBeUndefined()
  })

  it("deletes the mirror row", async () => {
    await seedRow()
    await applyOptimisticOverrideMutation({ kind: "delete", conversationKey: KEY })
    expect(await readForResolution(KEY)).toBeUndefined()
  })
})
