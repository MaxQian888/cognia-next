import "fake-indexeddb/auto"
import type { Project } from "@/types"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  getAllProjects,
  putProject,
  deleteProjectRow,
  loadActiveProjectId,
  persistActiveProjectId,
} from "./projects"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeProject(id: string, over: Partial<Project> = {}): Project {
  const now = new Date()
  return {
    id,
    name: id,
    roots: [{ id: `root-${id}`, path: `/tmp/${id}`, isPrimary: true }],
    rootDir: `/tmp/${id}`,
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    ...over,
  }
}

describe("projects table writers", () => {
  it("getAllProjects returns [] when nothing persisted", async () => {
    expect(await getAllProjects()).toEqual([])
  })

  it("putProject upserts a row and getAllProjects retrieves it", async () => {
    await putProject(makeProject("alpha"))
    const all = await getAllProjects()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe("alpha")
    expect(all[0].rootDir).toBe("/tmp/alpha")
  })

  it("putProject round-trips additionalDirs", async () => {
    await putProject(makeProject("multi", { additionalDirs: ["/a", "/b"] }))
    const row = (await getAllProjects())[0]
    expect(row.additionalDirs).toEqual(["/a", "/b"])
  })

  it("putProject overwrites an existing row (upsert by id)", async () => {
    await putProject(makeProject("alpha", { name: "first" }))
    await putProject(makeProject("alpha", { name: "second" }))
    const all = await getAllProjects()
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe("second")
  })

  it("deleteProjectRow removes the row", async () => {
    await putProject(makeProject("alpha"))
    await deleteProjectRow("alpha")
    expect(await getAllProjects()).toEqual([])
  })

  it("deleteProjectRow is a no-op for an unknown id", async () => {
    await expect(deleteProjectRow("missing")).resolves.toBeUndefined()
  })
})

describe("active-workspace pointer (settings singleton)", () => {
  it("loadActiveProjectId returns null before anything is set", async () => {
    expect(await loadActiveProjectId()).toBeNull()
  })

  it("persistActiveProjectId + loadActiveProjectId round-trip", async () => {
    await persistActiveProjectId("alpha")
    expect(await loadActiveProjectId()).toBe("alpha")
  })

  it("persistActiveProjectId(null) clears the pointer", async () => {
    await persistActiveProjectId("alpha")
    await persistActiveProjectId(null)
    expect(await loadActiveProjectId()).toBeNull()
  })
})
