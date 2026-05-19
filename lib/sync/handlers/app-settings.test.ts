/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { syncAppSettings } from "./app-settings"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 4,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncAppSettings", () => {
  it("calls sync_pull with table=settings", async () => {
    const tx = makeTransport()
    const out = await syncAppSettings(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", { table: "settings", since: 0 })
    expect(out.ok).toBe(true)
  })
})
