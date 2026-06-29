/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { syncMcpServers } from "./mcp-servers"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 12,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncMcpServers", () => {
  it("calls sync_pull with table=mcpServers", async () => {
    const tx = makeTransport()
    const out = await syncMcpServers(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", { table: "mcpServers", since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(12)
  })
})
