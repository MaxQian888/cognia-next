/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { syncConversationOverrides } from "./conversation-overrides"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncConversationOverrides", () => {
  it("calls sync_pull with table=conversationOverrides", async () => {
    const tx = makeTransport()
    const out = await syncConversationOverrides(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "conversationOverrides",
      since: 0,
    })
    expect(out.ok).toBe(true)
  })
})
