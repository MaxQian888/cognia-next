/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { Goal } from "@/types/goal"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncGoals } from "./goals"

function makeTransport(rows: Goal[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncGoals", () => {
  it("calls sync_pull with table=goals + the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncGoals(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "goals",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("persists goal upserts into Dexie", async () => {
    const rows = [{ id: "g1" } as unknown as Goal, { id: "g2" } as unknown as Goal]
    const out = await syncGoals(makeTransport(rows), { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
  })
})
