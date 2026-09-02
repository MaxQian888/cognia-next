/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { ExecutionRunBinding } from "@/types/execution/run"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

import { syncExecutionRunBindings } from "./execution-run-bindings"

function binding(id: string, over: Partial<ExecutionRunBinding> = {}): ExecutionRunBinding {
  return {
    id,
    runId: `run-${id}`,
    adapterId: "tg-1",
    conversationKey: "telegram:tg-1:chat",
    status: "active",
    deliveryMode: "native",
    lastProjectedRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function makeTransport(rows: ExecutionRunBinding[]): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 4,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncExecutionRunBindings", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("mirrors bindings so the delegation chips can resolve a conversation's runs", async () => {
    const tx = makeTransport([binding("b1"), binding("b2", { status: "finished" })])
    const out = await syncExecutionRunBindings(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "executionRunBindings",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out).toEqual({
      ok: true,
      result: { table: "executionRunBindings", applied: 2, nextSince: 4 },
    })
    const rows = await getDb()
      .executionRunBindings.where("conversationKey")
      .equals("telegram:tg-1:chat")
      .toArray()
    expect(rows.map((row) => row.status).sort()).toEqual(["active", "finished"])
  })
})
