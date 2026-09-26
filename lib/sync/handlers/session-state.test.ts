/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncSessionState } from "./session-state"

type WireRow = {
  id: string
  sessionId: string
  lastReadAt: number
  unreadCount: number
  updatedAt?: number
  manualUnread?: { at: number; from: number }
}

function makeTransport(rows: WireRow[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

const wire = (sessionId: string, unreadCount = 1): WireRow => ({
  id: sessionId,
  sessionId,
  lastReadAt: 10,
  unreadCount,
  updatedAt: 20,
})

describe("syncSessionState", () => {
  it("calls sync_pull with table=sessionState and the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncSessionState(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "sessionState",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("writes the row under its own primary key, without the wire's id alias", async () => {
    // The table is keyed by `sessionId`, but `runSyncHandler` is generic over
    // `{ id: string }`, so the host sends an alias. Persisting the alias would
    // work in IndexedDB and then diverge from every desktop-written row, which
    // only ever shows up later as a badge that will not clear.
    const out = await syncSessionState(makeTransport([wire("s1", 3)]), { since: 0 })
    expect(out.ok).toBe(true)

    const stored = await getDb().sessionState.get("s1")
    expect(stored).toEqual({ sessionId: "s1", lastReadAt: 10, unreadCount: 3, updatedAt: 20 })
    expect(stored).not.toHaveProperty("id")
  })

  it("applies several rows in one pull", async () => {
    const out = await syncSessionState(makeTransport([wire("a"), wire("b")]), { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
  })
})

it("preserves pending read optimism without hiding a newer Host message", async () => {
  const { setActiveRuntimeTargetContext } = await import("@/lib/runtime/runtime-target-context")
  setActiveRuntimeTargetContext("acct_read", "host_read")
  const db = getDb()
  await db.mobileOutboundQueue.put({
    id: "read-job",
    accountId: "acct_read",
    targetId: "host_read",
    command: "session_mark_read",
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    idempotencyKey: "read-job",
    payload: { sessionId: "pending-read", readThrough: 20 },
  })
  try {
    await syncSessionState(makeTransport([wire("pending-read", 3)]), { since: 0 })
    expect(await db.sessionState.get("pending-read")).toMatchObject({
      unreadCount: 0,
      lastReadAt: 20,
    })
    await syncSessionState(makeTransport([{ ...wire("pending-read", 4), updatedAt: 21 }]), {
      since: 0,
    })
    expect(await db.sessionState.get("pending-read")).toMatchObject({
      unreadCount: 4,
      updatedAt: 21,
    })
  } finally {
    await db.mobileOutboundQueue.delete("read-job")
  }
})

it("ignores foreign or unrelated pending reads and accepts legacy Host rows", async () => {
  const { setActiveRuntimeTargetContext } = await import("@/lib/runtime/runtime-target-context")
  setActiveRuntimeTargetContext("acct_read", "host_read")
  const db = getDb()
  const base = {
    accountId: "acct_read",
    targetId: "host_read",
    command: "session_mark_read" as const,
    status: "pending" as const,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    idempotencyKey: "boundary",
  }
  await db.mobileOutboundQueue.bulkPut([
    {
      ...base,
      id: "foreign-read",
      targetId: "host_other",
      payload: { sessionId: "legacy-read", readThrough: 999 },
    },
    { ...base, id: "unrelated-read", payload: { sessionId: "other-session", readThrough: 999 } },
  ])
  try {
    const row = { ...wire("legacy-read", 3), updatedAt: undefined }
    await syncSessionState(makeTransport([row]), { since: 0 })
    expect(await db.sessionState.get("legacy-read")).toMatchObject({
      unreadCount: 3,
      lastReadAt: 10,
    })
  } finally {
    await db.mobileOutboundQueue.bulkDelete(["foreign-read", "unrelated-read"])
  }
})

describe("pending read/unread relay", () => {
  const job = (
    id: string,
    command: "session_mark_read" | "session_mark_unread",
    payload: Record<string, unknown>,
    createdAt: number
  ) => ({
    id,
    accountId: "acct_read",
    targetId: "host_read",
    command,
    status: "pending" as const,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt,
    idempotencyKey: id,
    payload,
    channel: `session-state:${String(payload.sessionId)}`,
    clientId: "session-state-relay",
    clientSeq: createdAt,
  })

  beforeEach(async () => {
    const { setActiveRuntimeTargetContext } = await import("@/lib/runtime/runtime-target-context")
    setActiveRuntimeTargetContext("acct_read", "host_read")
  })
  afterEach(async () => {
    await getDb().mobileOutboundQueue.clear()
  })

  it("keeps a pending unread visible over a Host row that has not applied it", async () => {
    await getDb().mobileOutboundQueue.put(job("u", "session_mark_unread", { sessionId: "u1" }, 1))
    await syncSessionState(makeTransport([wire("u1", 0)]), { since: 0 })
    expect(await getDb().sessionState.get("u1")).toMatchObject({ unreadCount: 1, lastReadAt: 10 })
  })

  it("lets the later choice win when both a read and an unread are pending", async () => {
    await getDb().mobileOutboundQueue.bulkPut([
      job("u", "session_mark_unread", { sessionId: "u2" }, 1),
      job("r", "session_mark_read", { sessionId: "u2", readThrough: 20 }, 2),
    ])
    await syncSessionState(makeTransport([wire("u2", 3)]), { since: 0 })
    expect(await getDb().sessionState.get("u2")).toMatchObject({ unreadCount: 0 })

    await getDb().mobileOutboundQueue.put(
      job("u-later", "session_mark_unread", { sessionId: "u2" }, 3)
    )
    await syncSessionState(makeTransport([wire("u2", 0)]), { since: 0 })
    expect(await getDb().sessionState.get("u2")).toMatchObject({ unreadCount: 1 })
  })

  it("treats a pending read as covering the manual unread it was taken over", async () => {
    // The Host already applied this device's unread (watermark 25, taken over
    // 20); the read the device queued afterwards reports 20 and supersedes it.
    await getDb().mobileOutboundQueue.put(
      job("r", "session_mark_read", { sessionId: "u3", readThrough: 20 }, 2)
    )
    await syncSessionState(
      makeTransport([{ ...wire("u3", 1), updatedAt: 25, manualUnread: { at: 25, from: 20 } }]),
      { since: 0 }
    )
    expect(await getDb().sessionState.get("u3")).toMatchObject({ unreadCount: 0 })
  })

  it("does not let that read hide a message that arrived after the unread", async () => {
    await getDb().mobileOutboundQueue.put(
      job("r", "session_mark_read", { sessionId: "u4", readThrough: 20 }, 2)
    )
    // A real message replaced the row, so the manual unread is no longer live.
    await syncSessionState(
      makeTransport([{ ...wire("u4", 2), updatedAt: 26, manualUnread: { at: 25, from: 20 } }]),
      { since: 0 }
    )
    expect(await getDb().sessionState.get("u4")).toMatchObject({ unreadCount: 2 })
  })
})
