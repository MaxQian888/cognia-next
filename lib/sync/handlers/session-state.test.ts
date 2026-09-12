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
