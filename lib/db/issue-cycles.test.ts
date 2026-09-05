/**
 * @jest-environment jsdom
 */

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  createIssueProject,
  deleteIssueProject,
  deleteIssueDataForWorkspace,
} from "./issue-projects"
import { createIssue, getIssue, setIssueCycle } from "./issues"
import {
  compareIssueCycles,
  createIssueCycle,
  deleteIssueCycle,
  deleteIssueCyclesForWorkspace,
  getIssueCycle,
  getIssueCycleByExternalKey,
  listIssueCycles,
  updateIssueCycle,
} from "./issue-cycles"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

let projectId: string

beforeEach(async () => {
  projectId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

describe("createIssueCycle", () => {
  it("writes the row with its indexed external keys", async () => {
    const cycle = await createIssueCycle({
      projectId: "w1",
      kind: "milestone",
      name: " v1.0 ",
      externalRefs: [{ provider: "github", externalId: "o/r#milestone/3" }],
    })
    expect(cycle.name).toBe("v1.0")
    expect(cycle.status).toBe("planned")
    expect(cycle.externalKeys).toEqual(["github:o/r#milestone/3"])
    expect(await getIssueCycleByExternalKey("github", "o/r#milestone/3")).toMatchObject({
      id: cycle.id,
    })
  })

  it("refuses an empty name and a window that ends before it starts", async () => {
    await expect(createIssueCycle({ projectId: "w1", kind: "cycle", name: "  " })).rejects.toThrow(
      /name/
    )
    await expect(
      createIssueCycle({ projectId: "w1", kind: "cycle", name: "x", startsAt: 10, endsAt: 5 })
    ).rejects.toThrow(/end before/)
  })
})

describe("listIssueCycles", () => {
  it("scopes by workspace and by container, keeping workspace-wide cycles", async () => {
    const wide = await createIssueCycle({ projectId: "w1", kind: "cycle", name: "Sprint" })
    const bound = await createIssueCycle({
      projectId: "w1",
      kind: "milestone",
      name: "Repo milestone",
      issueProjectId: projectId,
    })
    await createIssueCycle({
      projectId: "w1",
      kind: "milestone",
      name: "Other repo",
      issueProjectId: "other-container",
    })
    await createIssueCycle({ projectId: "w2", kind: "cycle", name: "Elsewhere" })

    const forContainer = await listIssueCycles({ projectId: "w1", issueProjectId: projectId })
    expect(forContainer.map((row) => row.id).sort()).toEqual([wide.id, bound.id].sort())
    expect((await listIssueCycles({ projectId: "w1" })).length).toBe(3)
    expect(
      (await listIssueCycles({ projectId: "w1", kind: "cycle" })).map((row) => row.id)
    ).toEqual([wide.id])
  })

  it("orders active, then planned by start, then completed", () => {
    const base = {
      projectId: "w1",
      kind: "cycle" as const,
      externalRefs: [],
      externalKeys: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const rows = [
      { ...base, id: "done", name: "Done", status: "completed" as const },
      { ...base, id: "late", name: "Late", status: "planned" as const, startsAt: 20 },
      { ...base, id: "soon", name: "Soon", status: "planned" as const, startsAt: 10 },
      { ...base, id: "unset", name: "Unset", status: "planned" as const },
      { ...base, id: "now", name: "Now", status: "active" as const },
    ]
    expect(rows.sort(compareIssueCycles).map((row) => row.id)).toEqual([
      "now",
      "soon",
      "late",
      "unset",
      "done",
    ])
  })
})

describe("updateIssueCycle", () => {
  it("patches fields, clears with null, and keeps external keys in step", async () => {
    const cycle = await createIssueCycle({
      projectId: "w1",
      kind: "cycle",
      name: "S1",
      startsAt: 5,
    })
    await updateIssueCycle(cycle.id, {
      name: "S1 renamed",
      description: "focus",
      status: "active",
      startsAt: null,
      endsAt: 50,
      issueProjectId: projectId,
      externalRefs: [{ provider: "lark-task", externalId: "section-1" }],
    })
    const after = (await getIssueCycle(cycle.id))!
    expect(after).toMatchObject({
      name: "S1 renamed",
      description: "focus",
      status: "active",
      endsAt: 50,
      issueProjectId: projectId,
      externalKeys: ["lark-task:section-1"],
    })
    expect(after.startsAt).toBeUndefined()
    await updateIssueCycle(cycle.id, { description: null, issueProjectId: null })
    const cleared = (await getIssueCycle(cycle.id))!
    expect(cleared.description).toBeUndefined()
    expect(cleared.issueProjectId).toBeUndefined()
  })

  it("refuses a patch that makes the window end before it starts", async () => {
    const cycle = await createIssueCycle({
      projectId: "w1",
      kind: "cycle",
      name: "S1",
      startsAt: 5,
    })
    await expect(updateIssueCycle(cycle.id, { endsAt: 1 })).rejects.toThrow(/end before/)
  })
})

describe("deleteIssueCycle", () => {
  it("unplans every issue in the cycle and records a tombstone", async () => {
    const cycle = await createIssueCycle({ projectId: "w1", kind: "cycle", name: "S1" })
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: projectId,
      title: "x",
      createdBy: { kind: "human" },
    })
    await setIssueCycle(issue.id, cycle.id, { kind: "human" })
    expect((await getIssue(issue.id))!.cycleId).toBe(cycle.id)

    await deleteIssueCycle(cycle.id)
    expect(await getIssueCycle(cycle.id)).toBeUndefined()
    expect((await getIssue(issue.id))!.cycleId).toBeUndefined()
    const tombstones = await getDb().syncTombstones.where("table").equals("issueCycles").toArray()
    expect(tombstones.map((row) => row.id)).toEqual([cycle.id])
  })
})

describe("cascades", () => {
  it("deleting a container takes its own cycles and leaves workspace-wide ones", async () => {
    const wide = await createIssueCycle({ projectId: "w1", kind: "cycle", name: "Sprint" })
    const bound = await createIssueCycle({
      projectId: "w1",
      kind: "milestone",
      name: "M",
      issueProjectId: projectId,
    })
    await deleteIssueProject(projectId)
    expect(await getIssueCycle(bound.id)).toBeUndefined()
    expect(await getIssueCycle(wide.id)).toBeDefined()
  })

  it("deleting the workspace takes every cycle, even with no container left", async () => {
    await deleteIssueProject(projectId)
    const wide = await createIssueCycle({ projectId: "w1", kind: "cycle", name: "Sprint" })
    await deleteIssueDataForWorkspace("w1")
    expect(await getIssueCycle(wide.id)).toBeUndefined()
    expect(await deleteIssueCyclesForWorkspace("w1")).toEqual([])
  })
})
