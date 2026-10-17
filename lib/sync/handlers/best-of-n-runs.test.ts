/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { BestOfNRunSummary } from "@/types/best-of-n"
import { syncBestOfNRuns } from "./best-of-n-runs"

const row = (version: number, updatedAt = version): BestOfNRunSummary => ({
  id: "run",
  updatedAt,
  parentMessageId: "message",
  group: { groupId: "run", version, phase: "published" } as BestOfNRunSummary["group"],
})
function transport(rows: BestOfNRunSummary[]): Transport {
  return {
    call: jest.fn().mockResolvedValue({ rows, deleted_ids: [], next_since: 50 }),
    subscribe: jest.fn(),
  }
}
beforeEach(async () => {
  await getDb().bestOfNRuns.clear()
})

it("pulls summaries through the read-only sync door and never sends a control command", async () => {
  const tx = transport([row(3)])
  expect((await syncBestOfNRuns(tx, { since: 2 })).ok).toBe(true)
  expect(tx.call).toHaveBeenCalledTimes(1)
  expect(tx.call).toHaveBeenCalledWith(
    "sync_pull",
    expect.objectContaining({ table: "bestOfNRuns", since: 2 })
  )
  expect(await getDb().bestOfNRuns.get("run")).toEqual(row(3))
})

it("rejects stale ledger versions and older evidence snapshots", async () => {
  await getDb().bestOfNRuns.put(row(3, 30))
  await syncBestOfNRuns(transport([row(2, 40)]), { since: 0 })
  await syncBestOfNRuns(transport([row(3, 20)]), { since: 0 })
  expect(await getDb().bestOfNRuns.get("run")).toEqual(row(3, 30))
  await syncBestOfNRuns(transport([row(3, 50)]), { since: 0 })
  expect(await getDb().bestOfNRuns.get("run")).toEqual(row(3, 50))
})

it("rejects mismatched group identities without warming the mirror", async () => {
  const invalid = { ...row(1), id: "other" }
  const result = await syncBestOfNRuns(transport([invalid]), { since: 0 })
  expect(result).toMatchObject({ ok: false, failure: { reason: "schema" } })
  expect(await getDb().bestOfNRuns.count()).toBe(0)
})
