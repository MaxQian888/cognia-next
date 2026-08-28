/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { WorkflowRow } from "@/types/workflow/visual"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncWorkflows } from "./workflows"

function makeTransport(rows: WorkflowRow[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncWorkflows", () => {
  it("calls sync_pull with table=workflows + the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncWorkflows(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "workflows",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("filters out isBuiltIn rows before persisting", async () => {
    const rows = [
      { id: "u", name: "user-workflow", isBuiltIn: false } as unknown as WorkflowRow,
      { id: "b", name: "builtin", isBuiltIn: true } as unknown as WorkflowRow,
    ]
    const tx = makeTransport(rows)
    const out = await syncWorkflows(tx, { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(1)
  })
})
