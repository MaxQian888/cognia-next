/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncTerminalHistory } from "./terminal-history"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 42,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncTerminalHistory", () => {
  it("calls sync_pull with table=terminalHistory and advances the cursor", async () => {
    const tx = makeTransport()
    const out = await syncTerminalHistory(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "terminalHistory",
      since: 0,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.table).toBe("terminalHistory")
    expect(out.result.nextSince).toBe(42)
  })
})
