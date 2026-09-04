import type { Project } from "@/types"
import { backfillRootsForRow } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  getAllProjects,
  putProject,
  deleteProjectRow,
  loadActiveProjectId,
  persistActiveProjectId,
} from "./projects"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

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

  it("deleteProjectRow cascades the issue tracker rows it owns", async () => {
    // Containers and issues are scoped by this workspace id and have no other
    // owner, so dropping the row alone stranded them where neither tracker
    // console could reach them (ADR-0132).
    const { createIssueProject, listIssueProjects } = await import("./issue-projects")
    const { createIssue, listIssues } = await import("./issues")

    await putProject(makeProject("alpha"))
    const container = await createIssueProject({ projectId: "alpha", name: "Mercury", key: "MERC" })
    await createIssue({
      projectId: "alpha",
      issueProjectId: container.id,
      title: "Something",
      createdBy: { kind: "human" },
    })

    await deleteProjectRow("alpha")

    expect(await listIssueProjects({ projectId: "alpha" })).toEqual([])
    expect(await listIssues({ projectId: "alpha" })).toEqual([])
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

describe("v66 migration backfill", () => {
  it("backfillRootsForRow builds roots from rootDir + additionalDirs", () => {
    const row = {
      id: "legacy-1",
      name: "Legacy",
      rootDir: "/a",
      additionalDirs: ["/b", "/c"],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    } as unknown as Project
    const migrated = backfillRootsForRow(row)
    expect(migrated.roots?.[0]).toMatchObject({ path: "/a", isPrimary: true })
    expect(migrated.roots?.map((r) => r.path)).toEqual(["/a", "/b", "/c"])
  })

  it("backfillRootsForRow is idempotent when roots already present", () => {
    const existing = [{ id: "r", path: "/x", isPrimary: true }]
    const row = { id: "x", roots: existing } as unknown as Project
    expect(backfillRootsForRow(row).roots).toBe(existing)
  })

  it("backfillRootsForRow yields [] for a row with no dirs", () => {
    const row = { id: "y" } as unknown as Project
    expect(backfillRootsForRow(row).roots).toEqual([])
  })
})
