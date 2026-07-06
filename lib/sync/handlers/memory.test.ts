/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { Memory } from "@/types/memory/memory"

import { syncMemories } from "./memory"

function makeTransport(rows: Memory[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncMemories", () => {
  it("calls sync_pull with table=memories + the given cursor", async () => {
    const tx = makeTransport([], [], 5)
    const out = await syncMemories(tx, { since: 42 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", { table: "memories", since: 42 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(5)
  })

  it("persists memory upserts into Dexie", async () => {
    const rows = [{ id: "m1" } as unknown as Memory, { id: "m2" } as unknown as Memory]
    const out = await syncMemories(makeTransport(rows), { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
  })
})
