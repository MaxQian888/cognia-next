/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { AgentPlan } from "@/types/agent/plan"

import { syncPlans } from "./plans"

function makeTransport(rows: AgentPlan[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncPlans", () => {
  it("calls sync_pull with table=plans + the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncPlans(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith(
      "sync_pull",
      expect.objectContaining({ table: "plans", since: 99 })
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("persists plan upserts into Dexie so the dock can read them offline", async () => {
    const rows = [{ id: "p1" } as unknown as AgentPlan, { id: "p2" } as unknown as AgentPlan]
    const out = await syncPlans(makeTransport(rows), { since: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
  })
})
