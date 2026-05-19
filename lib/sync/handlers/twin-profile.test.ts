/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { syncTwinProfile } from "./twin-profile"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 3,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncTwinProfile", () => {
  it("calls sync_pull with table=twinProfile", async () => {
    const tx = makeTransport()
    const out = await syncTwinProfile(tx, { since: 2 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", { table: "twinProfile", since: 2 })
    expect(out.ok).toBe(true)
  })
})
