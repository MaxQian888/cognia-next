/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

import { syncPlatformIdentities } from "./platform-identities"

function identity(id: string, over: Partial<PlatformIdentityRow> = {}): PlatformIdentityRow {
  return {
    id,
    platform: "telegram",
    adapterId: "tg-1",
    remoteUserId: `u-${id}`,
    displayName: `User ${id}`,
    mergedFromIds: [],
    lastSeenAt: 5,
    updatedAt: 5,
    ...over,
  }
}

function makeTransport(rows: PlatformIdentityRow[], deleted: string[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: deleted,
      next_since: 9,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncPlatformIdentities", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("mirrors full rows, merge snapshots included", async () => {
    const absorbed = identity("p2")
    const tx = makeTransport([
      identity("p1", { mergedFromIds: ["p2"], mergedSnapshots: [absorbed] }),
    ])
    const out = await syncPlatformIdentities(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "platformIdentities",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect(await getDb().platformIdentities.get("p1")).toMatchObject({
      displayName: "User p1",
      mergedSnapshots: [{ id: "p2" }],
    })
  })

  it("applies the tombstone a host-side merge records for the absorbed row", async () => {
    await getDb().platformIdentities.bulkPut([identity("p1"), identity("p2")])
    await syncPlatformIdentities(makeTransport([], ["p2"]), { since: 0 })
    expect(await getDb().platformIdentities.get("p2")).toBeUndefined()
    expect(await getDb().platformIdentities.get("p1")).toBeDefined()
  })
})
