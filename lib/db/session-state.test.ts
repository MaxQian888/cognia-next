jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: jest.fn(() => ({ target: null })),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: () => false }))
jest.mock("@/lib/sync/session-history", () => ({ getSessionHistoryMode: jest.fn(() => null) }))
// Coverage for the per-session unread tracker (session-state.ts).

import {
  bumpUnread,
  getSessionState,
  listSessionStates,
  markSessionRead,
  markSessionReadOnHost,
  markSessionUnread,
  markSessionUnreadOnHost,
  sessionStateRelayChannel,
  SESSION_STATE_RELAY_CLIENT_ID,
} from "./session-state"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import Dexie from "dexie"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  jest
    .requireMock("@/lib/runtime/runtime-snapshot-store")
    .getRuntimeSnapshot.mockReturnValue({ target: null })
  jest.requireMock("@/lib/sync/session-history").getSessionHistoryMode.mockReturnValue(null)
  await getDb().mobileOutboundQueue.clear()
  await getDb().sessionState.clear()
  await getDb().sessions.bulkPut(
    ["s1", "s2"].map((id) => ({
      id,
      projectId: "p",
      kind: "direct" as const,
      title: id,
      createdAt: 1,
      updatedAt: 1,
    }))
  )
})
afterAll(dbFixture.dispose)

describe.each([
  { name: "markSessionRead", write: markSessionRead },
  { name: "bumpUnread", write: bumpUnread },
  { name: "markSessionUnread", write: markSessionUnread },
])("$name lifecycle", ({ write }) => {
  it("does not create state for a missing parent", async () => {
    await write("missing")
    expect(await getSessionState("missing")).toBeUndefined()
  })

  it("does not resurrect state after an overlapping session deletion", async () => {
    const db = getDb()
    await bumpUnread("s1")
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const deletion = db.transaction("rw", db.sessions, db.sessionState, async () => {
      await db.sessions.delete("s1")
      await db.sessionState.delete("s1")
      started()
      await Dexie.waitFor(gate)
    })
    await ready
    const update = Dexie.ignoreTransaction(() => write("s1"))
    release()
    await Promise.all([deletion, update])
    expect(await Dexie.ignoreTransaction(() => getSessionState("s1"))).toBeUndefined()
  })
})

describe("markSessionRead", () => {
  it("creates a row with unreadCount=0 and a fresh lastReadAt", async () => {
    const before = Date.now()
    await markSessionRead("s1")
    const row = await getSessionState("s1")
    expect(row?.unreadCount).toBe(0)
    expect(row?.lastReadAt).toBeGreaterThanOrEqual(before)
  })

  it("overwrites prior unread count for the same session", async () => {
    await bumpUnread("s1")
    await bumpUnread("s1")
    await markSessionRead("s1")
    const row = await getSessionState("s1")
    expect(row?.unreadCount).toBe(0)
  })
})

describe("bumpUnread", () => {
  it("creates a row at count=1 the first time", async () => {
    await bumpUnread("s1")
    const row = await getSessionState("s1")
    expect(row?.unreadCount).toBe(1)
    // No prior read pointer, so lastReadAt defaults to 0.
    expect(row?.lastReadAt).toBe(0)
  })

  it("increments the existing count without resetting lastReadAt", async () => {
    await markSessionRead("s1")
    const before = await getSessionState("s1")
    await bumpUnread("s1")
    await bumpUnread("s1")
    const after = await getSessionState("s1")
    expect(after?.unreadCount).toBe(2)
    expect(after?.lastReadAt).toBe(before?.lastReadAt)
  })
})

describe("getSessionState / listSessionStates", () => {
  it("returns undefined for unknown sessions", async () => {
    expect(await getSessionState("nope")).toBeUndefined()
  })

  it("listSessionStates returns every persisted row", async () => {
    await bumpUnread("s1")
    await bumpUnread("s2")
    const all = await listSessionStates()
    expect(all.length).toBe(2)
    expect(all.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"])
  })
})

describe("multi-device read receipts", () => {
  it("rejects stale receipts without clearing later unread messages", async () => {
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 3,
      updatedAt: 30,
    })
    await markSessionReadOnHost("s1", 20)
    const state = await getSessionState("s1")
    expect(state).toMatchObject({ lastReadAt: 10, unreadCount: 3 })
    expect(state!.updatedAt).toBeGreaterThan(30)
  })

  it("applies a covered receipt and keeps same-millisecond changes ordered", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(30)
    try {
      await getDb().sessionState.put({
        sessionId: "s1",
        lastReadAt: 10,
        unreadCount: 3,
        updatedAt: 30,
      })
      await markSessionReadOnHost("s1", 30)
      expect(await getSessionState("s1")).toMatchObject({
        lastReadAt: 30,
        unreadCount: 0,
        updatedAt: 31,
      })
      await bumpUnread("s1")
      expect(await getSessionState("s1")).toMatchObject({ unreadCount: 1, updatedAt: 32 })
    } finally {
      now.mockRestore()
    }
  })

  it("never stores a remote future timestamp as the read pointer", async () => {
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 3,
      updatedAt: 30,
    })
    await markSessionReadOnHost("s1", Number.MAX_SAFE_INTEGER)
    expect(await getSessionState("s1")).toMatchObject({ lastReadAt: 30, unreadCount: 0 })
  })

  it("durably queues an offline read for its original account and target", async () => {
    const { setActiveRuntimeTargetContext } = await import("@/lib/runtime/runtime-target-context")
    const { getRuntimeSnapshot } = jest.requireMock("@/lib/runtime/runtime-snapshot-store")
    getRuntimeSnapshot.mockReturnValue({ target: { kind: "companion" } })
    setActiveRuntimeTargetContext("acct_read", "host_read")
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 3,
      updatedAt: 30,
    })
    await markSessionRead("s1")
    expect(await getDb().mobileOutboundQueue.toArray()).toEqual([
      expect.objectContaining({
        accountId: "acct_read",
        targetId: "host_read",
        command: "session_mark_read",
        status: "pending",
        payload: { sessionId: "s1", readThrough: 30 },
      }),
    ])
    expect(await getSessionState("s1")).toMatchObject({ unreadCount: 0, updatedAt: 30 })
  })

  it("keeps a browser-owned conversation local while paired", async () => {
    jest
      .requireMock("@/lib/runtime/runtime-snapshot-store")
      .getRuntimeSnapshot.mockReturnValue({ target: { kind: "companion" } })
    jest.requireMock("@/lib/sync/session-history").getSessionHistoryMode.mockReturnValue("local")
    await markSessionRead("s1")
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    expect(await getSessionState("s1")).toMatchObject({ unreadCount: 0 })
  })
})

describe("read relay scope and legacy boundaries", () => {
  async function remoteTarget() {
    const context = await import("@/lib/runtime/runtime-target-context")
    context.setActiveRuntimeTargetContext("acct_read", "host_read")
    jest
      .requireMock("@/lib/runtime/runtime-snapshot-store")
      .getRuntimeSnapshot.mockReturnValue({ target: { kind: "companion" } })
    return context
  }

  it("does not carry a read across a target change during routing", async () => {
    const context = await remoteTarget()
    jest
      .requireMock("@/lib/runtime/runtime-snapshot-store")
      .getRuntimeSnapshot.mockImplementationOnce(() => {
        context.setActiveRuntimeTargetContext("acct_read", "host_next")
        return { target: { kind: "companion" } }
      })
    await markSessionRead("s1")
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    expect(await getSessionState("s1")).toBeUndefined()
  })

  it("does not carry a read across history ownership negotiation", async () => {
    const context = await remoteTarget()
    jest
      .requireMock("@/lib/sync/session-history")
      .getSessionHistoryMode.mockImplementationOnce(() => {
        context.setActiveRuntimeTargetContext("acct_read", "host_next")
        return null
      })
    await markSessionRead("s1")
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    expect(await getSessionState("s1")).toBeUndefined()
  })

  it("does not enqueue a remote read for a missing parent", async () => {
    await remoteTarget()
    await markSessionRead("missing")
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
  })

  it("queues a first read at the empty Host watermark", async () => {
    await remoteTarget()
    await markSessionRead("s1")
    expect(await getDb().mobileOutboundQueue.toArray()).toEqual([
      expect.objectContaining({ payload: { sessionId: "s1", readThrough: 0 } }),
    ])
    expect(await getSessionState("s1")).toMatchObject({ lastReadAt: 0, unreadCount: 0 })
  })

  it("retains legacy read pointers when old rows have no update watermark", async () => {
    await remoteTarget()
    await getDb().sessionState.put({ sessionId: "s1", lastReadAt: 20, unreadCount: 2 })
    await markSessionRead("s1")
    expect(await getDb().mobileOutboundQueue.toArray()).toEqual([
      expect.objectContaining({ payload: { sessionId: "s1", readThrough: 20 } }),
    ])
    await getDb().sessionState.put({ sessionId: "s1", lastReadAt: 20, unreadCount: 2 })
    await markSessionReadOnHost("s1", 20)
    expect(await getSessionState("s1")).toMatchObject({ lastReadAt: 20, unreadCount: 0 })
    await getDb().sessionState.put({ sessionId: "s1", lastReadAt: 20, unreadCount: 2 })
    await bumpUnread("s1")
    expect(await getSessionState("s1")).toMatchObject({ lastReadAt: 20, unreadCount: 3 })
  })

  it("rolls back optimism when no delivery scope is available", async () => {
    const context = await remoteTarget()
    context.clearActiveRuntimeTargetContext()
    await expect(markSessionRead("s1")).rejects.toThrow(
      "Outbound queue requires an active account and runtime target"
    )
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    expect(await getSessionState("s1")).toBeUndefined()
  })
})

describe("markSessionUnread", () => {
  it("raises a read conversation to one unread without moving the read pointer", async () => {
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 0,
      updatedAt: 30,
    })
    await markSessionUnread("s1")
    const row = await getSessionState("s1")
    expect(row).toMatchObject({ lastReadAt: 10, unreadCount: 1 })
    // Stamped past the old watermark so the change syncs.
    expect(row!.updatedAt).toBeGreaterThan(30)
    expect(row!.manualUnread).toEqual({ at: row!.updatedAt, from: 30 })
  })

  it("never lowers an existing unread count", async () => {
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 4,
      updatedAt: 30,
    })
    await markSessionUnread("s1")
    expect(await getSessionState("s1")).toMatchObject({ unreadCount: 4, lastReadAt: 10 })
  })

  it("creates the row for a conversation that was never opened", async () => {
    await markSessionUnread("s1")
    expect(await getSessionState("s1")).toMatchObject({ lastReadAt: 0, unreadCount: 1 })
  })

  it("is idempotent and keeps the watermark the first unread was taken over", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(100)
    try {
      await getDb().sessionState.put({
        sessionId: "s1",
        lastReadAt: 10,
        unreadCount: 0,
        updatedAt: 30,
      })
      await markSessionUnreadOnHost("s1")
      await markSessionUnreadOnHost("s1")
      expect(await getSessionState("s1")).toMatchObject({
        unreadCount: 1,
        updatedAt: 101,
        manualUnread: { at: 101, from: 30 },
      })
    } finally {
      now.mockRestore()
    }
  })
})

describe("read after a manual unread", () => {
  it("lets a device read taken over the unread's snapshot clear it", async () => {
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 0,
      updatedAt: 30,
    })
    await markSessionUnreadOnHost("s1")
    // The phone marked it unread at watermark 30, then opened it: its read
    // still reports 30, and must win over its own earlier choice.
    await markSessionReadOnHost("s1", 30)
    const row = await getSessionState("s1")
    expect(row).toMatchObject({ unreadCount: 0 })
    expect(row).not.toHaveProperty("manualUnread")
  })

  it("still refuses a stale read once a real message followed the unread", async () => {
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 0,
      updatedAt: 30,
    })
    await markSessionUnreadOnHost("s1")
    await bumpUnread("s1")
    await markSessionReadOnHost("s1", 30)
    expect(await getSessionState("s1")).toMatchObject({ unreadCount: 2 })
  })

  it("refuses a read older than the snapshot the unread was taken over", async () => {
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 2,
      updatedAt: 30,
    })
    await markSessionUnreadOnHost("s1")
    await markSessionReadOnHost("s1", 20)
    expect(await getSessionState("s1")).toMatchObject({ unreadCount: 2 })
  })
})

describe("paired read/unread relay", () => {
  async function remoteTarget() {
    const context = await import("@/lib/runtime/runtime-target-context")
    context.setActiveRuntimeTargetContext("acct_read", "host_read")
    jest
      .requireMock("@/lib/runtime/runtime-snapshot-store")
      .getRuntimeSnapshot.mockReturnValue({ target: { kind: "companion" } })
    return context
  }

  it("relays an unread with optimism and leaves the Host watermark alone", async () => {
    await remoteTarget()
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 0,
      updatedAt: 30,
    })
    await markSessionUnread("s1")
    expect(await getDb().mobileOutboundQueue.toArray()).toEqual([
      expect.objectContaining({
        accountId: "acct_read",
        targetId: "host_read",
        command: "session_mark_unread",
        status: "pending",
        payload: { sessionId: "s1" },
        channel: sessionStateRelayChannel("s1"),
        clientId: SESSION_STATE_RELAY_CLIENT_ID,
        clientSeq: 1,
      }),
    ])
    expect(await getSessionState("s1")).toEqual({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 1,
      updatedAt: 30,
    })
  })

  it("orders a later read behind the unread on the session's channel", async () => {
    await remoteTarget()
    await getDb().sessionState.put({
      sessionId: "s1",
      lastReadAt: 10,
      unreadCount: 0,
      updatedAt: 30,
    })
    await markSessionUnread("s1")
    await markSessionRead("s1")
    await markSessionRead("s2")
    const rows = await getDb().mobileOutboundQueue.orderBy("createdAt").toArray()
    const byCommand = rows.map((row) => [row.command, row.channel, row.clientSeq])
    expect(byCommand).toEqual(
      expect.arrayContaining([
        ["session_mark_unread", sessionStateRelayChannel("s1"), 1],
        ["session_mark_read", sessionStateRelayChannel("s1"), 2],
        // Another conversation is its own channel.
        ["session_mark_read", sessionStateRelayChannel("s2"), 1],
      ])
    )
    // The read reports the snapshot the unread was taken over, which is what
    // lets the Host treat it as superseding that unread.
    expect(
      rows.find((row) => row.command === "session_mark_read" && row.payload.sessionId === "s1")
        ?.payload
    ).toEqual({
      sessionId: "s1",
      readThrough: 30,
    })
    expect(await getSessionState("s1")).toMatchObject({ unreadCount: 0 })
  })

  it("keeps a browser-owned conversation's unread local while paired", async () => {
    await remoteTarget()
    jest.requireMock("@/lib/sync/session-history").getSessionHistoryMode.mockReturnValue("local")
    await markSessionUnread("s1")
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    expect(await getSessionState("s1")).toMatchObject({ unreadCount: 1 })
  })

  it("does not relay an unread for a missing conversation", async () => {
    await remoteTarget()
    await markSessionUnread("missing")
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
  })

  it("rolls back the optimistic unread when no delivery scope is available", async () => {
    const context = await remoteTarget()
    context.clearActiveRuntimeTargetContext()
    await expect(markSessionUnread("s1")).rejects.toThrow(
      "Outbound queue requires an active account and runtime target"
    )
    expect(await getSessionState("s1")).toBeUndefined()
  })
})
