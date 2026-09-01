/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncTwins, syncTwinDrafts } from "./twins"

function makeTransport(rows: unknown[], deleted_ids: string[] = [], next_since = 1): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

const twin = (id: string) => ({
  id,
  name: `Twin ${id}`,
  archived: false,
  createdAt: 1,
  updatedAt: 20,
})

const draft = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  twinId: "t1",
  jobId: "j1",
  kind: "character",
  payload: { name: "Ada" },
  provenance: { chunkIds: [], rationale: "because" },
  status: "pending",
  createdAt: 5,
  ...extra,
})

describe("syncTwins", () => {
  it("pulls the twins table with the given cursor", async () => {
    const tx = makeTransport([], [], 7)
    const out = await syncTwins(tx, { since: 99 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "twins",
      since: 99,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(7)
  })

  it("writes rows the mobile twin selector can read back", async () => {
    const out = await syncTwins(makeTransport([twin("a"), twin("b")]), { since: 0 })
    expect(out.ok).toBe(true)

    expect(await getDb().twins.get("a")).toMatchObject({ id: "a", name: "Twin a" })
    expect((await getDb().twins.toArray()).map((row) => row.id).sort()).toEqual(["a", "b"])
  })

  it("removes a twin the host tombstoned", async () => {
    await getDb().twins.bulkPut([twin("gone") as never])
    const out = await syncTwins(makeTransport([], ["gone"]), { since: 0 })

    expect(out.ok).toBe(true)
    expect(await getDb().twins.get("gone")).toBeUndefined()
  })
})

describe("syncTwinDrafts", () => {
  it("strips the synthetic cursor the host derived for it", async () => {
    // `TwinDraft` carries no `updatedAt`. The host sends one so the generic
    // cursor machinery has a watermark to read. Persisting it would leave a
    // field in Dexie that no other reader of this table knows about.
    const out = await syncTwinDrafts(makeTransport([draft("d1", { updatedAt: 42 })]), { since: 0 })
    expect(out.ok).toBe(true)

    const stored = await getDb().twinDrafts.get("d1")
    expect(stored).toMatchObject({ id: "d1", twinId: "t1", status: "pending" })
    expect(stored).not.toHaveProperty("updatedAt")
  })

  it("lands a reviewed draft over the pending copy the phone already had", async () => {
    // The review half of the cursor is the point: without it a phone that
    // pulled the draft while pending would keep offering Accept for something
    // the host has already accepted.
    await syncTwinDrafts(makeTransport([draft("d1", { updatedAt: 5 })]), { since: 0 })
    await syncTwinDrafts(
      makeTransport([draft("d1", { status: "accepted", reviewedAt: 42, updatedAt: 42 })]),
      { since: 5 }
    )

    expect(await getDb().twinDrafts.get("d1")).toMatchObject({
      status: "accepted",
      reviewedAt: 42,
    })
  })
})
