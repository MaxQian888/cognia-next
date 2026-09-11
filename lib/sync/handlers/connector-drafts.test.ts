/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import Dexie from "dexie"

import type { Transport } from "@/lib/tauri/transport-types"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

import { applyConnectorDraftRows, syncConnectorDrafts } from "./connector-drafts"

function makeTransport(rows: ConnectorDraftRow[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

function draft(id: string, over: Partial<ConnectorDraftRow> = {}): ConnectorDraftRow {
  return {
    id,
    conversationKey: "telegram:a:1",
    sessionId: "s1",
    segments: [{ type: "text", text: "hi" }],
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("syncConnectorDrafts", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("pulls connectorDrafts and mirrors full rows (segments included)", async () => {
    const tx = makeTransport([draft("d1")])
    const out = await syncConnectorDrafts(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "connectorDrafts",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect(await getDb().connectorDrafts.get("d1")).toMatchObject({
      status: "pending",
      segments: [{ type: "text", text: "hi" }],
    })
  })

  it("does not regress an optimistic local approve to pending on a stale delta", async () => {
    await getDb().connectorDrafts.put(draft("d2", { status: "approved", updatedAt: 10 }))
    await applyConnectorDraftRows([draft("d2", { status: "pending", updatedAt: 5 })])
    expect((await getDb().connectorDrafts.get("d2"))?.status).toBe("approved")
  })

  it("lets a newer host row replace the optimistic status", async () => {
    await getDb().connectorDrafts.put(draft("d3", { status: "approved", updatedAt: 10 }))
    await applyConnectorDraftRows([draft("d3", { status: "expired", updatedAt: 11 })])
    expect((await getDb().connectorDrafts.get("d3"))?.status).toBe("expired")
    // A newer *pending* from the host also wins (host re-opened the draft).
    await applyConnectorDraftRows([draft("d3", { status: "pending", updatedAt: 12 })])
    expect((await getDb().connectorDrafts.get("d3"))?.status).toBe("pending")
  })

  it("applies deletions", async () => {
    await getDb().connectorDrafts.put(draft("d4"))
    const tx: Transport = {
      call: jest.fn(async () => ({
        rows: [],
        deleted_ids: ["d4"],
        next_since: 3,
      })) as unknown as Transport["call"],
      subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
    }
    await syncConnectorDrafts(tx, { since: 0 })
    expect(await getDb().connectorDrafts.get("d4")).toBeUndefined()
  })
})

it("rejects cancellation after asynchronous merge preparation", async () => {
  const table = getDb().connectorDrafts
  let current = true
  const read = jest.spyOn(table, "bulkGet").mockImplementation(() =>
    Dexie.Promise.resolve().then(() => {
      current = false
      return []
    })
  )
  const write = jest.spyOn(table, "bulkPut")
  const assertCurrent = () => {
    if (!current) throw new Error("scope cancelled")
  }
  try {
    expect(
      (await syncConnectorDrafts(makeTransport([draft("cancelled")]), { since: 0, assertCurrent }))
        .ok
    ).toBe(false)
    expect(read).toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
    write.mockRestore()
  }
})
