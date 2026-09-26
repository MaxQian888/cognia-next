/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { SessionFolder } from "@cognia/agent-config-types"
import type { Transport } from "@/lib/tauri/transport-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

import { syncSessionFolders } from "./session-folders"

function folder(id: string, over: Partial<SessionFolder> = {}): SessionFolder {
  return { id, projectId: "p1", name: id, order: 0, createdAt: 1, updatedAt: 1, ...over }
}

function makeTransport(rows: SessionFolder[], deletedIds: string[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: deletedIds,
      next_since: 9,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncSessionFolders", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("pulls the sessionFolders table and mirrors the Host's rows", async () => {
    const tx = makeTransport([folder("f1", { name: "Work" }), folder("f2", { order: 1 })])
    const out = await syncSessionFolders(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "sessionFolders",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect(await getDb().sessionFolders.get("f1")).toMatchObject({ name: "Work", projectId: "p1" })
    expect(await getDb().sessionFolders.count()).toBe(2)
  })

  it("replaces an optimistic create with the Host's row under the same id", async () => {
    // The phone showed the folder at the end of its own list; the Host placed it.
    await getDb().sessionFolders.put(folder("f-new", { name: "Draft", order: 7 }))
    await syncSessionFolders(
      makeTransport([folder("f-new", { name: "Draft", order: 2, updatedAt: 5 })]),
      {
        since: 0,
      }
    )
    expect(await getDb().sessionFolders.get("f-new")).toMatchObject({ order: 2, updatedAt: 5 })
  })

  it("drops a folder the Host deleted", async () => {
    await getDb().sessionFolders.bulkPut([folder("keep"), folder("gone")])
    await syncSessionFolders(makeTransport([], ["gone"]), { since: 1 })
    expect(await getDb().sessionFolders.get("gone")).toBeUndefined()
    expect(await getDb().sessionFolders.get("keep")).toBeDefined()
  })
})
