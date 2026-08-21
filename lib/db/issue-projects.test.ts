/**
 * @jest-environment jsdom
 */

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { allocateIssueNumber } from "./issue-counters"
import { createIssue } from "./issues"
import { listIssueEvents } from "./issue-events"
import {
  addIssueProjectResource,
  computeIssueProjectProgress,
  createIssueProject,
  deleteIssueProject,
  getIssueProject,
  getIssueProjectByKey,
  listIssueProjects,
  listTakenProjectKeys,
  removeIssueProjectResource,
  updateIssueProject,
} from "./issue-projects"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const

describe("createIssueProject", () => {
  it("derives a key from the name and defaults the rest", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "Cognia" })
    expect(project).toMatchObject({
      projectId: "w1",
      key: "COGN",
      name: "Cognia",
      status: "backlog",
      priority: "none",
      resources: [],
    })
  })

  it("derives a non-colliding key when the natural one is taken", async () => {
    await createIssueProject({ projectId: "w1", name: "Cognia" })
    const second = await createIssueProject({ projectId: "w1", name: "Cognia" })
    expect(second.key).toBe("COGN2")
  })

  it("keys are unique across workspaces, so a pasted identifier is unambiguous", async () => {
    await createIssueProject({ projectId: "w1", name: "Cognia" })
    const other = await createIssueProject({ projectId: "w2", name: "Cognia" })
    expect(other.key).not.toBe("COGN")
  })

  it("accepts and uppercases an explicit key", async () => {
    expect((await createIssueProject({ projectId: "w1", name: "X", key: "merc" })).key).toBe("MERC")
  })

  it("rejects an invalid explicit key", async () => {
    await expect(
      createIssueProject({ projectId: "w1", name: "X", key: "TOOLONG" })
    ).rejects.toThrow(/Invalid project key/)
    await expect(createIssueProject({ projectId: "w1", name: "X", key: "1AB" })).rejects.toThrow(
      /Invalid project key/
    )
  })

  it("rejects a duplicate explicit key rather than silently renaming it", async () => {
    await createIssueProject({ projectId: "w1", name: "A", key: "MERC" })
    await expect(createIssueProject({ projectId: "w1", name: "B", key: "MERC" })).rejects.toThrow(
      /already in use/
    )
  })

  it("requires a name", async () => {
    await expect(createIssueProject({ projectId: "w1", name: "  " })).rejects.toThrow(/required/i)
  })
})

describe("reads", () => {
  it("gets by id and by key (case-insensitively)", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X", key: "MERC" })
    expect(await getIssueProject(project.id)).toMatchObject({ key: "MERC" })
    expect(await getIssueProjectByKey("merc")).toMatchObject({ id: project.id })
    expect(await getIssueProjectByKey("nope")).toBeUndefined()
  })

  it("scopes the list to a workspace", async () => {
    await createIssueProject({ projectId: "w1", name: "One" })
    await createIssueProject({ projectId: "w2", name: "Two" })
    expect((await listIssueProjects({ projectId: "w1" })).map((p) => p.name)).toEqual(["One"])
    expect(await listIssueProjects()).toHaveLength(2)
  })

  it("filters by status", async () => {
    await createIssueProject({ projectId: "w1", name: "One", status: "planned" })
    await createIssueProject({ projectId: "w1", name: "Two", status: "completed" })
    expect(
      (await listIssueProjects({ projectId: "w1", statuses: ["planned"] })).map((p) => p.name)
    ).toEqual(["One"])
  })

  it("collects every key in use", async () => {
    await createIssueProject({ projectId: "w1", name: "X", key: "AAA" })
    await createIssueProject({ projectId: "w2", name: "Y", key: "BBB" })
    expect([...(await listTakenProjectKeys())].sort()).toEqual(["AAA", "BBB"])
  })
})

describe("updateIssueProject", () => {
  it("patches scalar fields", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    await updateIssueProject(project.id, {
      name: "  Renamed ",
      status: "in_progress",
      priority: "high",
    })
    expect(await getIssueProject(project.id)).toMatchObject({
      name: "Renamed",
      status: "in_progress",
      priority: "high",
    })
  })

  it("cannot change the key — it is immutable by omission from the patch type", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X", key: "MERC" })
    await updateIssueProject(project.id, { name: "Y" })
    expect((await getIssueProject(project.id))!.key).toBe("MERC")
  })

  it("clears optional fields when passed null", async () => {
    const project = await createIssueProject({
      projectId: "w1",
      name: "X",
      lead: HUMAN,
      startDate: 1,
      targetDate: 2,
    })
    await updateIssueProject(project.id, { lead: null, startDate: null, targetDate: null })
    const reloaded = await getIssueProject(project.id)
    expect(reloaded).not.toHaveProperty("lead")
    expect(reloaded).not.toHaveProperty("startDate")
    expect(reloaded).not.toHaveProperty("targetDate")
  })

  it("is a no-op for an unknown id", async () => {
    await expect(updateIssueProject("nope", { name: "x" })).resolves.toBeUndefined()
  })
})

describe("resources", () => {
  const REPO = { kind: "github-repo", repoFullName: "o/r", addedAt: 1 } as const
  const ROOT = { kind: "workspace-root", rootId: "root-1", addedAt: 1 } as const

  it("adds repo and directory references", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    await addIssueProjectResource(project.id, REPO)
    await addIssueProjectResource(project.id, ROOT)
    expect((await getIssueProject(project.id))!.resources).toEqual([REPO, ROOT])
  })

  it("is idempotent per target", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    await addIssueProjectResource(project.id, REPO)
    await addIssueProjectResource(project.id, { ...REPO, addedAt: 999 })
    expect((await getIssueProject(project.id))!.resources).toHaveLength(1)
  })

  it("does not confuse a repo with a directory", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    await addIssueProjectResource(project.id, REPO)
    await removeIssueProjectResource(project.id, ROOT)
    expect((await getIssueProject(project.id))!.resources).toEqual([REPO])
  })

  it("removes a reference", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    await addIssueProjectResource(project.id, REPO)
    await removeIssueProjectResource(project.id, REPO)
    expect((await getIssueProject(project.id))!.resources).toEqual([])
  })

  it("is a no-op for an unknown project", async () => {
    await expect(addIssueProjectResource("nope", REPO)).resolves.toBeUndefined()
    await expect(removeIssueProjectResource("nope", REPO)).resolves.toBeUndefined()
  })
})

describe("deleteIssueProject", () => {
  it("cascades to its issues, their events and its counter", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: project.id,
      title: "t",
      createdBy: HUMAN,
    })
    expect(await listIssueEvents({ issueId: issue.id })).not.toHaveLength(0)

    await deleteIssueProject(project.id)

    const db = getDb()
    expect(await getIssueProject(project.id)).toBeUndefined()
    expect(await db.issues.get(issue.id)).toBeUndefined()
    expect(await listIssueEvents({ issueId: issue.id })).toEqual([])
    expect(await db.issueCounters.get(project.id)).toBeUndefined()
  })

  it("releases the key so a fresh project can reuse it and renumber from 1", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X", key: "MERC" })
    await allocateIssueNumber(project.id)
    await deleteIssueProject(project.id)

    const reused = await createIssueProject({ projectId: "w1", name: "Y", key: "MERC" })
    expect(await allocateIssueNumber(reused.id)).toBe(1)
  })

  it("leaves another project's issues alone", async () => {
    const keep = await createIssueProject({ projectId: "w1", name: "Keep" })
    const drop = await createIssueProject({ projectId: "w1", name: "Drop" })
    const kept = await createIssue({
      projectId: "w1",
      issueProjectId: keep.id,
      title: "kept",
      createdBy: HUMAN,
    })
    await deleteIssueProject(drop.id)
    expect(await getDb().issues.get(kept.id)).toBeDefined()
  })
})

describe("computeIssueProjectProgress", () => {
  async function seed(statuses: readonly string[]) {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    for (const status of statuses) {
      await createIssue({
        projectId: "w1",
        issueProjectId: project.id,
        title: status,
        status: status as never,
        createdBy: HUMAN,
      })
    }
    return project
  }

  it("is all zeroes for an empty project", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "X" })
    expect(await computeIssueProjectProgress(project.id)).toEqual({
      total: 0,
      completed: 0,
      canceled: 0,
      started: 0,
      denominator: 0,
      ratio: 0,
    })
  })

  it("counts by category and excludes cancelled work from the denominator", async () => {
    const project = await seed(["done", "todo", "canceled", "in_progress"])
    expect(await computeIssueProjectProgress(project.id)).toEqual({
      total: 4,
      completed: 1,
      canceled: 1,
      started: 1,
      // 1 done out of 3 non-cancelled.
      denominator: 3,
      ratio: 1 / 3,
    })
  })

  it("reports 0 rather than dividing by zero when everything is cancelled", async () => {
    const project = await seed(["canceled", "canceled"])
    expect((await computeIssueProjectProgress(project.id)).ratio).toBe(0)
  })

  it("reports a complete project as 1", async () => {
    const project = await seed(["done", "done", "canceled"])
    expect((await computeIssueProjectProgress(project.id)).ratio).toBe(1)
  })
})
