/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

import {
  applySessionUsageRows,
  sessionUsageFromWire,
  syncSessionUsage,
  type SessionUsageWireRow,
} from "./session-usage"

function usage(messageId: string, overrides: Partial<SessionUsageRow> = {}): SessionUsageWireRow {
  return {
    id: messageId,
    messageId,
    sessionId: "s1",
    at: 1_000,
    model: "ark-deepseek-v4.1-flash",
    providerId: "deepseek",
    inputTokens: 12,
    outputTokens: 7,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.001,
    durationMs: 900,
    ...overrides,
  }
}

function makeTransport(rows: SessionUsageWireRow[], deleted: string[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: deleted,
      next_since: 2_000,
      next_cursor: '{"version":1}',
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncSessionUsage", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("pulls with the paged cursor and stores rows under their message id", async () => {
    const tx = makeTransport([usage("assistant-1")])
    const out = await syncSessionUsage(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "sessionUsage",
      since: 0,
      content_protocol_version: 1,
      cursor: "",
    })
    expect(out).toMatchObject({ ok: true, result: { table: "sessionUsage", applied: 1 } })
    const stored = await getDb().sessionUsage.get("assistant-1")
    expect(stored).toMatchObject({ sessionId: "s1", inputTokens: 12, providerId: "deepseek" })
    expect(stored).not.toHaveProperty("id")
  })

  it("replaces the row this device booked for the same turn instead of adding one", async () => {
    await getDb().sessionUsage.put(sessionUsageFromWire(usage("assistant-1", { inputTokens: 3 }))!)
    await applySessionUsageRows([usage("assistant-1")])
    const rows = await getDb().sessionUsage.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ messageId: "assistant-1", inputTokens: 12 })
  })

  it("drops a deleted conversation's rows by their message ids", async () => {
    await getDb().sessionUsage.bulkPut([
      sessionUsageFromWire(usage("assistant-1"))!,
      sessionUsageFromWire(usage("assistant-2"))!,
    ])
    await syncSessionUsage(makeTransport([], ["assistant-1"]), { since: 0 })
    expect((await getDb().sessionUsage.toArray()).map((row) => row.messageId)).toEqual([
      "assistant-2",
    ])
  })
})

describe("sessionUsageFromWire", () => {
  it("refuses malformed rows and rows scanned from another machine's agent logs", () => {
    expect(sessionUsageFromWire(usage("a", { sessionId: undefined as never }))).toBeNull()
    expect(sessionUsageFromWire({ ...usage("a"), id: "b" })).toBeNull()
    expect(sessionUsageFromWire(usage("a", { at: Number.NaN }))).toBeNull()
    expect(sessionUsageFromWire(usage("a", { sourceId: "claude-code" }))).toBeNull()
    expect(sessionUsageFromWire(usage("a"))).toEqual(
      expect.objectContaining({ messageId: "a", sessionId: "s1" })
    )
  })
})
