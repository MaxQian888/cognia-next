import type { ChatSession } from "@cognia/agent-config-types"

import { trashLibraryItems, setLibraryItemFavorite } from "@/lib/db/files-library-items"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { MessageMediaRow } from "@/lib/db/message-media"
import type { LibraryItemRow } from "@/lib/db/files-library-types"

import {
  purgeTrashedItems,
  resolveTrashPurgeTargets,
  trashPurgeAction,
  type TrashPurgeTarget,
} from "./trash"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().sessions.bulkPut(
    ["s1"].map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 }) as ChatSession)
  )
})
afterAll(fixture.dispose)

function media(hash: string): MessageMediaRow {
  return {
    hash,
    mediaType: "image/png",
    width: 1,
    height: 1,
    blob: new Blob([hash], { type: "image/png" }),
    byteSize: hash.length,
    createdAt: 1,
    lastUsedAt: 1,
  }
}

function target(overrides: Partial<TrashPurgeTarget>): TrashPurgeTarget {
  return {
    key: "artifact:a1",
    kind: "artifact",
    sourceId: "a1",
    ownedByFiles: false,
    originAlive: true,
    ...overrides,
  }
}

describe("trashPurgeAction", () => {
  it("deletes what Files owns, retires what lives elsewhere, and drops orphans", () => {
    expect(trashPurgeAction(target({ ownedByFiles: true, originAlive: true }))).toBe("delete-owned")
    expect(trashPurgeAction(target({ originAlive: true }))).toBe("retire")
    expect(trashPurgeAction(target({ originAlive: false }))).toBe("delete-orphan")
  })
})

describe("purgeTrashedItems", () => {
  it("routes each target to its action and deletes orphaned sources", async () => {
    const deps = {
      deleteOwned: jest.fn(async () => undefined),
      retire: jest.fn(async () => []),
      deleteRows: jest.fn(async () => undefined),
      deleteOrphanSource: jest.fn(async () => undefined),
    }
    const outcome = await purgeTrashedItems(
      [
        target({ key: "upload:u1", kind: "upload", sourceId: "u1", ownedByFiles: true }),
        target({ key: "canvas:c1", kind: "canvas", sourceId: "c1", originAlive: true }),
        target({ key: "artifact:a1", originAlive: false }),
        target({ key: "image:h9", kind: "image", sourceId: "h9", originAlive: false }),
      ],
      deps
    )
    expect(outcome).toEqual({ deleted: 3, retired: 1 })
    expect(deps.deleteOwned).toHaveBeenCalledWith("upload:u1")
    expect(deps.retire).toHaveBeenCalledWith([{ kind: "canvas", sourceId: "c1" }])
    expect(deps.deleteOrphanSource).toHaveBeenCalledTimes(1)
    expect(deps.deleteOrphanSource).toHaveBeenCalledWith("artifact", "a1")
    expect(deps.deleteRows).toHaveBeenCalledWith(["artifact:a1", "image:h9"])
  })

  it("does nothing for an empty Trash", async () => {
    const deps = {
      deleteOwned: jest.fn(),
      retire: jest.fn(),
      deleteRows: jest.fn(),
      deleteOrphanSource: jest.fn(),
    }
    expect(await purgeTrashedItems([], deps)).toEqual({ deleted: 0, retired: 0 })
    expect(deps.retire).not.toHaveBeenCalled()
    expect(deps.deleteRows).not.toHaveBeenCalled()
  })
})

describe("resolveTrashPurgeTargets", () => {
  it("reads whether each row's source is still held outside Files", async () => {
    const db = getDb()
    await db.messageMedia.bulkPut([media("h1"), media("h2")])
    await db.messageMediaRefs.bulkPut([
      { messageId: "m1", sessionId: "s1", hash: "h1" },
      { messageId: "m2", sessionId: "gone", hash: "h2" },
    ])
    await setLibraryItemFavorite({ kind: "image", sourceId: "h2", mediaHash: "h2" }, true)
    await trashLibraryItems([
      { kind: "image", sourceId: "h1", mediaHash: "h1" },
      { kind: "image", sourceId: "h2", mediaHash: "h2" },
      { kind: "artifact", sourceId: "a-live", originSessionId: "s1" },
      { kind: "artifact", sourceId: "a-dead", originSessionId: "gone" },
      { kind: "canvas", sourceId: "c-standalone" },
      { kind: "session-upload", sourceId: "sha-gone" },
      // A workspace file follows its conversation; its disk is never touched.
      { kind: "workspace-file", sourceId: "w-live", originSessionId: "s1" },
      { kind: "workspace-file", sourceId: "w-dead", originSessionId: "gone" },
    ])
    const rows = (await db.libraryItems.toArray()) as LibraryItemRow[]
    const byKey = new Map(
      (await resolveTrashPurgeTargets(rows)).map((entry) => [entry.key, entry.originAlive])
    )
    expect(Object.fromEntries(byKey)).toEqual({
      "image:h1": true,
      "image:h2": false,
      "artifact:a-live": true,
      "artifact:a-dead": false,
      "canvas:c-standalone": true,
      "session-upload:sha-gone": false,
      "workspace-file:w-live": true,
      "workspace-file:w-dead": false,
    })
  })
})
