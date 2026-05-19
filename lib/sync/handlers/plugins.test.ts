/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { syncPlugins } from "./plugins"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 9,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncPlugins", () => {
  it("calls sync_pull with table=plugins", async () => {
    const tx = makeTransport()
    const out = await syncPlugins(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", { table: "plugins", since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(9)
  })
})
