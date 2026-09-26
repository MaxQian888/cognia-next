import Dexie from "dexie"

import {
  createFolder,
  deleteFolder,
  discardLocalFolder,
  listFolderMemberIds,
  listFolders,
  renameFolder,
  reorderFolders,
  writeFolderCreate,
  writeFolderDelete,
  writeFolderRename,
  writeFolderReorder,
} from "./session-folders"
import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"
import { createSession, getSession, assignSessionToFolder } from "./sessions"
import { saveSettings } from "./settings"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

// The /loop cascade tears down backing scheduler tasks via a dynamic import —
// mock the scheduler singleton so no real timing engine spins up.
const schedulerMock = { deleteTask: jest.fn().mockResolvedValue(true) }
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

// Folder writes ask the outbound queue whether a Host takes them. `null` is
// "no Host" (standalone), which is what every test sees unless it says so.
const enqueueHostStateIntentMock = jest.fn(async (..._args: unknown[]) => null as unknown)
jest.mock("./mobile-outbound-queue", () => ({
  ...jest.requireActual("./mobile-outbound-queue"),
  enqueueHostStateIntentIfAvailable: (...args: unknown[]) => enqueueHostStateIntentMock(...args),
}))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await saveSettings({ activeProjectId: "proj-A" })
  enqueueHostStateIntentMock.mockReset().mockResolvedValue(null)
})
afterAll(dbFixture.dispose)

describe("session-folders CRUD", () => {
  it("creates folders at the end of the workspace list and lists them in order", async () => {
    const a = await createFolder("Work")
    const b = await createFolder("Personal")
    expect(a.order).toBe(0)
    expect(b.order).toBe(1)
    expect(b.projectId).toBe("proj-A")
    const list = await listFolders("proj-A")
    expect(list.map((f) => f.id)).toEqual([a.id, b.id])
  })

  it("persists a manual folder order", async () => {
    const a = await createFolder("Work")
    const b = await createFolder("Personal")
    const c = await createFolder("Reading")
    await reorderFolders([c.id, a.id, b.id])
    expect((await listFolders("proj-A")).map((f) => f.name)).toEqual([
      "Reading",
      "Work",
      "Personal",
    ])
    expect((await getDb().sessionFolders.get(c.id))?.order).toBe(0)
  })

  it("ignores unknown ids and keeps unnamed folders after the ones given", async () => {
    const a = await createFolder("A")
    await createFolder("B")
    const c = await createFolder("C")
    // `gone` was deleted by another surface between the drag and the drop; the
    // "B" folder simply was not part of the request.
    await reorderFolders([c.id, "gone", a.id])
    expect((await listFolders("proj-A")).map((f) => f.name)).toEqual(["C", "A", "B"])
  })

  it("does not renumber another workspace's folders", async () => {
    const inA = await createFolder("In A")
    await saveSettings({ activeProjectId: "proj-B" })
    const first = await createFolder("B first")
    const second = await createFolder("B second")
    await reorderFolders([second.id, first.id])
    expect((await listFolders("proj-B")).map((f) => f.name)).toEqual(["B second", "B first"])
    expect((await getDb().sessionFolders.get(inA.id))?.order).toBe(0)
  })

  it("scopes folders to their workspace", async () => {
    await createFolder("In A")
    await saveSettings({ activeProjectId: "proj-B" })
    await createFolder("In B")
    expect((await listFolders("proj-A")).map((f) => f.name)).toEqual(["In A"])
    expect((await listFolders("proj-B")).map((f) => f.name)).toEqual(["In B"])
  })

  it("renames a folder", async () => {
    const f = await createFolder("Old")
    await renameFolder(f.id, "  New  ")
    expect((await getDb().sessionFolders.get(f.id))?.name).toBe("New")
  })

  // Regression: same liveQuery zone-safety as `listScopedSessions` — with an
  // explicit pid the Dexie read must be registered before any await, or folder
  // mutations never re-emit to the sidebar.
  it("re-emits an explicit-pid liveQuery after a rename", async () => {
    const f = await createFolder("Old")

    const emissions: string[][] = []
    // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
    // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
    // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
    const sub = Dexie.liveQuery(() => listFolders("proj-A")).subscribe({
      next: (rows) => emissions.push(rows.map((r) => r.name)),
    })
    const waitUntil = async (pred: () => boolean) => {
      const start = Date.now()
      while (!pred()) {
        if (Date.now() - start > 3000) throw new Error("waitUntil timed out")
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await waitUntil(() => emissions.length >= 1)
    await renameFolder(f.id, "New")
    await waitUntil(() => emissions.length >= 2)
    sub.unsubscribe()

    expect(emissions[emissions.length - 1]).toEqual(["New"])
  })
})

describe("folder membership", () => {
  it("assigns a session to a folder and back to loose without deleting it", async () => {
    const folder = await createFolder("Bucket")
    const s = await createSession({ title: "member" })
    await assignSessionToFolder(s.id, folder.id)
    expect((await getSession(s.id))?.folderId).toBe(folder.id)
    await assignSessionToFolder(s.id, null)
    const after = await getSession(s.id)
    expect(after).toBeDefined()
    expect("folderId" in (after as object)).toBe(false)
  })

  it("deleting a folder reverts its members to loose and never deletes sessions", async () => {
    const folder = await createFolder("Doomed")
    const inside = await createSession({ title: "inside" })
    const outside = await createSession({ title: "outside" })
    await assignSessionToFolder(inside.id, folder.id)

    await deleteFolder(folder.id)

    expect(await getDb().sessionFolders.get(folder.id)).toBeUndefined()
    // The member survives, now loose.
    const member = await getSession(inside.id)
    expect(member).toBeDefined()
    expect(member?.folderId).toBeUndefined()
    // The unrelated session is untouched.
    expect(await getSession(outside.id)).toBeDefined()
  })

  it("lists a folder's members, including a conversation of no workspace", async () => {
    const folder = await createFolder("Mixed")
    const scoped = await createSession({ title: "scoped" })
    await assignSessionToFolder(scoped.id, folder.id)
    // A paired client's host-synced row carries no `projectId`, so it is
    // absent from that index — which is why membership is not read through it.
    await getDb().sessions.put({
      id: "s-unscoped",
      title: "unscoped",
      folderId: folder.id,
      createdAt: 1,
      updatedAt: 1,
    })
    expect((await listFolderMemberIds(folder.id)).sort()).toEqual([scoped.id, "s-unscoped"].sort())
  })

  it("refuses to delete a folder whose member is handoff-locked, and writes nothing", async () => {
    const folder = await createFolder("Frozen")
    const free = await createSession({ title: "free" })
    const locked = await createSession({ title: "locked" })
    await assignSessionToFolder(free.id, folder.id)
    await assignSessionToFolder(locked.id, folder.id)
    await getDb().sessions.update(locked.id, {
      handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
    })

    await expect(deleteFolder(folder.id)).rejects.toBeInstanceOf(SessionHandoffLockedError)

    // One transaction: neither the folder nor the unlocked member moved.
    expect(await getDb().sessionFolders.get(folder.id)).toBeDefined()
    expect((await getSession(free.id))?.folderId).toBe(folder.id)
    expect((await getSession(locked.id))?.folderId).toBe(folder.id)
  })

  it("unfiles members through the folderId index, stamped so they sync in place", async () => {
    const folder = await createFolder("Indexed")
    const member = await createSession({ title: "member" })
    await assignSessionToFolder(member.id, folder.id)
    const before = (await getSession(member.id))!

    await writeFolderDelete(folder.id, before.updatedAt + 1_000)

    const after = (await getSession(member.id))!
    expect(after).not.toHaveProperty("folderId")
    // The unfile is a sync-visible write that does not move the row.
    expect(after.updatedAt).toBe(before.updatedAt + 1_000)
    expect(after.lastMessageAt ?? after.updatedAt).toBe(before.lastMessageAt ?? before.updatedAt)
    expect(await listFolderMemberIds(folder.id)).toEqual([])
  })

  it("tombstones a deleted folder so a paired device drops it, and ignores a second delete", async () => {
    const folder = await createFolder("Doomed")
    await writeFolderDelete(folder.id, 500)
    await writeFolderDelete(folder.id, 600)
    const tombstones = await getDb()
      .syncTombstones.filter((row) => row.table === "sessionFolders")
      .toArray()
    expect(tombstones).toEqual([
      expect.objectContaining({ table: "sessionFolders", id: folder.id, deletedAt: 500 }),
    ])
  })
})

describe("folder writes on a paired client", () => {
  function queued() {
    enqueueHostStateIntentMock.mockImplementation(async () => ({ id: "queued" }))
  }

  it("creates the folder optimistically under the id it hands the Host", async () => {
    queued()
    const folder = await createFolder("  Shared  ")
    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      action: { kind: "folder.create", folderId: folder.id, projectId: "proj-A", name: "Shared" },
    })
    // The row is visible now, so a conversation can be filed into it at once.
    expect(await getDb().sessionFolders.get(folder.id)).toMatchObject({ name: "Shared" })
  })

  it("drops the optimistic row when the outbox refuses the create", async () => {
    enqueueHostStateIntentMock.mockRejectedValueOnce(new Error("host_state_outbox_full"))
    await expect(createFolder("Lost")).rejects.toThrow("host_state_outbox_full")
    expect(await listFolders("proj-A")).toEqual([])
  })

  it("hands rename, reorder and delete to the Host without writing locally", async () => {
    const a = await createFolder("A")
    const b = await createFolder("B")
    const member = await createSession({ title: "member" })
    await assignSessionToFolder(member.id, a.id)
    enqueueHostStateIntentMock.mockClear()
    queued()

    await renameFolder(a.id, "  Renamed  ")
    await reorderFolders([b.id, a.id, b.id])
    await deleteFolder(a.id)

    expect(enqueueHostStateIntentMock.mock.calls.map(([input]) => input)).toEqual([
      { action: { kind: "folder.rename", folderId: a.id, name: "Renamed" } },
      { action: { kind: "folder.reorder", projectId: "proj-A", orderedIds: [b.id, a.id] } },
      { action: { kind: "folder.delete", folderId: a.id } },
    ])
    // The Host's rows come back through `sessionFolders` table sync.
    expect(await getDb().sessionFolders.get(a.id)).toMatchObject({ name: "A", order: 0 })
    expect((await getSession(member.id))?.folderId).toBe(a.id)
  })

  it("writes locally when no Host takes the write", async () => {
    const a = await createFolder("A")
    await renameFolder(a.id, "Local")
    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      action: { kind: "folder.rename", folderId: a.id, name: "Local" },
    })
    expect((await getDb().sessionFolders.get(a.id))?.name).toBe("Local")
  })
})

describe("raw folder repository", () => {
  it("creates under an explicit id and workspace, appended after the existing folders", async () => {
    await createFolder("First")
    const created = await writeFolderCreate({
      id: "f-host",
      projectId: "proj-A",
      name: " Two ",
      now: 7,
    })
    expect(created).toEqual({
      id: "f-host",
      projectId: "proj-A",
      name: "Two",
      order: 1,
      createdAt: 7,
      updatedAt: 7,
    })
  })

  it("reports a rename of a folder that is not there", async () => {
    await expect(writeFolderRename("missing", "x", 1)).resolves.toBe(false)
  })

  it("rewrites only the folders whose position moved", async () => {
    const a = await writeFolderCreate({ id: "a", projectId: "proj-A", name: "a", now: 1 })
    const b = await writeFolderCreate({ id: "b", projectId: "proj-A", name: "b", now: 1 })
    const c = await writeFolderCreate({ id: "c", projectId: "proj-A", name: "c", now: 1 })
    await writeFolderReorder("proj-A", [b.id, a.id], 50)
    const rows = await listFolders("proj-A")
    expect(rows.map((row) => [row.id, row.order, row.updatedAt])).toEqual([
      ["b", 0, 50],
      ["a", 1, 50],
      ["c", 2, 1],
    ])
    expect(c.order).toBe(2)
  })

  it("discards a local-only folder without a tombstone", async () => {
    await writeFolderCreate({ id: "ghost", projectId: "proj-A", name: "ghost", now: 1 })
    await discardLocalFolder("ghost")
    expect(await getDb().sessionFolders.get("ghost")).toBeUndefined()
    expect(
      await getDb()
        .syncTombstones.filter((row) => row.id === "ghost")
        .count()
    ).toBe(0)
  })
})
