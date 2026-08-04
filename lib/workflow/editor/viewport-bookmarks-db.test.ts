import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  deleteBookmark,
  listBookmarks,
  renameBookmark,
  saveBookmark,
} from "./viewport-bookmarks-db"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

const VP = (x = 0, y = 0, zoom = 1) => ({ x, y, zoom })

describe("viewport-bookmarks-db", () => {
  it("returns an empty list when no bookmarks have been saved", async () => {
    expect(await listBookmarks("wf_a")).toEqual([])
  })

  it("saveBookmark inserts a row with a vb_ id and trimmed name", async () => {
    const row = await saveBookmark("wf_a", "  My view  ", VP(10, 20, 1.5))
    expect(row.id).toMatch(/^vb_/)
    expect(row.workflowId).toBe("wf_a")
    expect(row.name).toBe("My view")
    expect(row.viewport).toEqual(VP(10, 20, 1.5))
    expect(typeof row.createdAt).toBe("number")
  })

  it("saveBookmark falls back to 'Untitled view' for empty names", async () => {
    const row = await saveBookmark("wf_a", "   ", VP())
    expect(row.name).toBe("Untitled view")
  })

  it("listBookmarks returns rows newest-first for the requested workflow", async () => {
    // Use an explicit Date.now mock-free flow: ensure ordering by spacing the calls.
    const a = await saveBookmark("wf_a", "A", VP(1, 0, 1))
    // Force a later timestamp.
    await new Promise((r) => setTimeout(r, 5))
    const b = await saveBookmark("wf_a", "B", VP(2, 0, 1))
    await new Promise((r) => setTimeout(r, 5))
    const c = await saveBookmark("wf_a", "C", VP(3, 0, 1))
    const list = await listBookmarks("wf_a")
    expect(list.map((r) => r.id)).toEqual([c.id, b.id, a.id])
  })

  it("listBookmarks isolates by workflowId", async () => {
    await saveBookmark("wf_a", "A", VP())
    await saveBookmark("wf_b", "B", VP())
    const listA = await listBookmarks("wf_a")
    expect(listA).toHaveLength(1)
    expect(listA[0].name).toBe("A")
    const listB = await listBookmarks("wf_b")
    expect(listB).toHaveLength(1)
    expect(listB[0].name).toBe("B")
  })

  it("deleteBookmark removes the row by id", async () => {
    const row = await saveBookmark("wf_a", "A", VP())
    await deleteBookmark(row.id)
    expect(await listBookmarks("wf_a")).toEqual([])
  })

  it("renameBookmark updates the name without bumping createdAt", async () => {
    const row = await saveBookmark("wf_a", "A", VP())
    const before = row.createdAt
    await renameBookmark(row.id, "renamed")
    const list = await listBookmarks("wf_a")
    expect(list[0].name).toBe("renamed")
    expect(list[0].createdAt).toBe(before)
  })

  it("renameBookmark ignores empty / whitespace names", async () => {
    const row = await saveBookmark("wf_a", "Original", VP())
    await renameBookmark(row.id, "   ")
    const list = await listBookmarks("wf_a")
    expect(list[0].name).toBe("Original")
  })

  it("saveBookmark with empty workflowId throws", async () => {
    await expect(saveBookmark("", "x", VP())).rejects.toThrow(/workflowId/)
  })

  it("listBookmarks returns [] when workflowId is empty", async () => {
    expect(await listBookmarks("")).toEqual([])
  })
})
