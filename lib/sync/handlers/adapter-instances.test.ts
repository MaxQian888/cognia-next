/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { syncAdapterInstances } from "./adapter-instances"
import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 11,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncAdapterInstances", () => {
  it("calls sync_pull with table=adapterInstances", async () => {
    const tx = makeTransport()
    const out = await syncAdapterInstances(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "adapterInstances",
      since: 0,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
  })
})
