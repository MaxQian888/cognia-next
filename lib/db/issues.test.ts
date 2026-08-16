/**
 * @jest-environment jsdom
 */

import type { IssueActor } from "@/types/issues"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { createIssueProject } from "./issue-projects"
import { listIssueComments, listIssueEvents } from "./issue-events"
import {
  addIssueComment,
  addIssueLabel,
  countIssuesByStatus,
  createIssue,
  deleteIssue,
  getIssue,
  getIssueByIdentifier,
  linkIssueToGithub,
  listIssues,
  moveIssue,
  moveIssueToProject,
  removeIssueLabel,
  reorderIssues,
  setIssueAssignee,
  updateIssue,
} from "./issues"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }
const AGENT: IssueActor = { kind: "agent", id: "a1" }
const TEAM: IssueActor = { kind: "team", id: "t1" }

let projectId: string

beforeEach(async () => {
  projectId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function make(over: Partial<Parameters<typeof createIssue>[0]> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: projectId,
    title: "Some issue",
    createdBy: HUMAN,
    ...over,
  })
}

async function kindsOf(issueId: string) {
  return (await listIssueEvents({ issueId })).map((e) => e.kind)
}

describe("createIssue", () => {
  it("allocates a printable identifier from the project key", async () => {
    expect((await make()).identifier).toBe("MERC-1")
    expect((await make()).identifier).toBe("MERC-2")
  })

  it("defaults status, priority, labels and derives the status category", async () => {
    expect(await make()).toMatchObject({
      status: "backlog",
      statusCategory: "unstarted",
      priority: "none",
      labelIds: [],
      order: 0,
    })
  })

  it("appends only a `created` event when unassigned", async () => {
    const issue = await make()
    expect(await kindsOf(issue.id)).toEqual(["created"])
  })

  it("appends an `assigned` event when created with an assignee", async () => {
    const issue = await make({ assignee: AGENT })
    expect(await kindsOf(issue.id)).toEqual(["created", "assigned"])
  })

  it("mirrors the assignee into the indexable flat columns", async () => {
    const issue = await make({ assignee: AGENT })
    expect(issue).toMatchObject({ assigneeKind: "agent", assigneeId: "a1" })
  })

  it("omits assigneeId for the id-less local human", async () => {
    const issue = await make({ assignee: HUMAN })
    expect(issue.assigneeKind).toBe("human")
    expect(issue).not.toHaveProperty("assigneeId")
  })

  it("appends to the end of its own column", async () => {
    await make({ status: "todo" })
    await make({ status: "backlog" })
    const third = await make({ status: "todo" })
    expect(third.order).toBe(1)
  })

  it("trims the title and rejects a blank one", async () => {
    expect((await make({ title: "  padded  " })).title).toBe("padded")
    await expect(make({ title: "   " })).rejects.toThrow(/required/i)
  })

  it("rejects an unknown delivery container without burning a number", async () => {
    await expect(make({ issueProjectId: "nope" })).rejects.toThrow(/Unknown issue project/)
    expect((await make()).identifier).toBe("MERC-1")
  })
})

describe("reads", () => {
  it("gets by id and by printed identifier", async () => {
    const issue = await make()
    expect(await getIssue(issue.id)).toMatchObject({ id: issue.id })
    expect(await getIssueByIdentifier("MERC-1")).toMatchObject({ id: issue.id })
    expect(await getIssueByIdentifier("MERC-99")).toBeUndefined()
  })

  it("scopes to a workspace and to a delivery container", async () => {
    const other = (await createIssueProject({ projectId: "w2", name: "Other" })).id
    await make()
    await createIssue({
      projectId: "w2",
      issueProjectId: other,
      title: "elsewhere",
      createdBy: HUMAN,
    })

    expect(await listIssues({ projectId: "w1" })).toHaveLength(1)
    expect(await listIssues({ issueProjectId: other })).toHaveLength(1)
    expect(await listIssues()).toHaveLength(2)
  })

  it("does not return another workspace's issues when both filters are given", async () => {
    await make()
    expect(await listIssues({ projectId: "w2", issueProjectId: projectId })).toEqual([])
  })

  it("filters by status and by the mirrored assignee columns", async () => {
    await make({ status: "done" })
    await make({ assignee: AGENT })
    expect(await listIssues({ projectId: "w1", statuses: ["done"] })).toHaveLength(1)
    expect(await listIssues({ projectId: "w1", assigneeKind: "agent" })).toHaveLength(1)
    expect(await listIssues({ projectId: "w1", assigneeId: "a1" })).toHaveLength(1)
    expect(await listIssues({ projectId: "w1", assigneeId: "nobody" })).toEqual([])
  })
})

describe("moveIssue", () => {
  it("moves, re-derives the category, and appends the event", async () => {
    const issue = await make({ status: "todo" })
    expect(await moveIssue({ id: issue.id, to: "done", by: HUMAN })).toBeNull()

    const moved = await getIssue(issue.id)
    expect(moved).toMatchObject({ status: "done", statusCategory: "completed" })
    expect(moved!.completedAt).toBeGreaterThan(0)
    expect(await kindsOf(issue.id)).toEqual(["created", "status_changed"])
  })

  it("clears lifecycle stamps when an issue is re-opened", async () => {
    const issue = await make({ status: "todo" })
    await moveIssue({ id: issue.id, to: "done", by: HUMAN })
    await moveIssue({ id: issue.id, to: "todo", by: HUMAN })

    const reopened = await getIssue(issue.id)
    expect(reopened).not.toHaveProperty("completedAt")
    expect(reopened).not.toHaveProperty("startedAt")
  })

  it("returns a structured reason instead of throwing when the runtime owns the column", async () => {
    const issue = await make({ status: "todo" })
    expect(await moveIssue({ id: issue.id, to: "in_progress", by: HUMAN, runActive: true })).toBe(
      "runtime-owned"
    )
    expect((await getIssue(issue.id))!.status).toBe("todo")
  })

  it("reports a missing issue rather than throwing", async () => {
    expect(await moveIssue({ id: "nope", to: "done", by: HUMAN })).toBe("issue-not-found")
  })

  it("is a silent no-op when the status is unchanged", async () => {
    const issue = await make({ status: "todo" })
    expect(await moveIssue({ id: issue.id, to: "todo", by: HUMAN })).toBeNull()
    expect(await kindsOf(issue.id)).toEqual(["created"])
  })
})

describe("reorderIssues", () => {
  it("applies only the rows whose order actually changed", async () => {
    const a = await make({ status: "todo" })
    const b = await make({ status: "todo" })
    await reorderIssues([
      { sourceId: b.id, order: 0 },
      { sourceId: a.id, order: 1 },
    ])
    expect((await getIssue(a.id))!.order).toBe(1)
    expect((await getIssue(b.id))!.order).toBe(0)
  })

  it("ignores unknown ids and an empty change set", async () => {
    await expect(reorderIssues([])).resolves.toBeUndefined()
    await expect(reorderIssues([{ sourceId: "nope", order: 3 }])).resolves.toBeUndefined()
  })
})

describe("updateIssue", () => {
  it("emits one event per changed field and none for unchanged ones", async () => {
    const issue = await make({ title: "old", priority: "none" })
    await updateIssue(issue.id, { title: "new", priority: "high", description: "d" }, HUMAN)
    expect(await kindsOf(issue.id)).toEqual([
      "created",
      "title_changed",
      "description_changed",
      "priority_changed",
    ])

    await updateIssue(issue.id, { title: "new", priority: "high" }, HUMAN)
    expect(await kindsOf(issue.id)).toHaveLength(4)
  })

  it("ignores a blank title rather than wiping it", async () => {
    const issue = await make({ title: "keep" })
    await updateIssue(issue.id, { title: "   " }, HUMAN)
    expect((await getIssue(issue.id))!.title).toBe("keep")
  })

  it("is a no-op for an unknown id", async () => {
    await expect(updateIssue("nope", { title: "x" }, HUMAN)).resolves.toBeUndefined()
  })
})

describe("setIssueAssignee", () => {
  it("emits `assigned`, then `reassigned`, then `unassigned`", async () => {
    const issue = await make()
    await setIssueAssignee(issue.id, AGENT, HUMAN)
    await setIssueAssignee(issue.id, TEAM, HUMAN)
    await setIssueAssignee(issue.id, null, HUMAN)
    expect(await kindsOf(issue.id)).toEqual(["created", "assigned", "reassigned", "unassigned"])
  })

  it("keeps the blob and its two mirrors in step, and clears all three", async () => {
    const issue = await make()
    await setIssueAssignee(issue.id, AGENT, HUMAN)
    expect(await getIssue(issue.id)).toMatchObject({
      assignee: AGENT,
      assigneeKind: "agent",
      assigneeId: "a1",
    })

    await setIssueAssignee(issue.id, null, HUMAN)
    const cleared = await getIssue(issue.id)
    expect(cleared).not.toHaveProperty("assignee")
    expect(cleared).not.toHaveProperty("assigneeKind")
    expect(cleared).not.toHaveProperty("assigneeId")
  })

  it("drops a stale assigneeId when reassigning to the id-less human", async () => {
    const issue = await make({ assignee: AGENT })
    await setIssueAssignee(issue.id, HUMAN, HUMAN)
    const reassigned = await getIssue(issue.id)
    expect(reassigned!.assigneeKind).toBe("human")
    expect(reassigned).not.toHaveProperty("assigneeId")
  })

  it("emits nothing when clearing an already-unassigned issue", async () => {
    const issue = await make()
    await setIssueAssignee(issue.id, null, HUMAN)
    expect(await kindsOf(issue.id)).toEqual(["created"])
  })
})

describe("labels", () => {
  it("adds and removes, emitting an event each time", async () => {
    const issue = await make()
    await addIssueLabel(issue.id, "bug", HUMAN)
    expect((await getIssue(issue.id))!.labelIds).toEqual(["bug"])
    await removeIssueLabel(issue.id, "bug", HUMAN)
    expect((await getIssue(issue.id))!.labelIds).toEqual([])
    expect(await kindsOf(issue.id)).toEqual(["created", "label_added", "label_removed"])
  })

  it("ignores a duplicate add and an absent remove", async () => {
    const issue = await make()
    await addIssueLabel(issue.id, "bug", HUMAN)
    await addIssueLabel(issue.id, "bug", HUMAN)
    await removeIssueLabel(issue.id, "missing", HUMAN)
    expect((await getIssue(issue.id))!.labelIds).toEqual(["bug"])
    expect(await kindsOf(issue.id)).toEqual(["created", "label_added"])
  })
})

describe("addIssueComment", () => {
  it("stores comments as activity entries", async () => {
    const issue = await make()
    await addIssueComment(issue.id, "  hello  ", HUMAN)
    const comments = await listIssueComments(issue.id)
    expect(comments).toHaveLength(1)
    expect((comments[0].payload as { body: string }).body).toBe("hello")
  })

  it("ignores an empty body", async () => {
    const issue = await make()
    await addIssueComment(issue.id, "   ", HUMAN)
    expect(await listIssueComments(issue.id)).toEqual([])
  })
})

describe("moveIssueToProject", () => {
  it("keeps the printed identifier stable across a transfer", async () => {
    const issue = await make()
    const target = (await createIssueProject({ projectId: "w1", name: "Cognia" })).id
    await moveIssueToProject(issue.id, target, HUMAN)

    const moved = await getIssue(issue.id)
    expect(moved).toMatchObject({ issueProjectId: target, identifier: "MERC-1" })
    expect(await kindsOf(issue.id)).toEqual(["created", "project_changed"])
  })

  it("rejects an unknown target", async () => {
    const issue = await make()
    await expect(moveIssueToProject(issue.id, "nope", HUMAN)).rejects.toThrow(
      /Unknown issue project/
    )
  })

  it("is a no-op when the issue is already there", async () => {
    const issue = await make()
    await moveIssueToProject(issue.id, projectId, HUMAN)
    expect(await kindsOf(issue.id)).toEqual(["created"])
  })
})

describe("linkIssueToGithub", () => {
  it("records the ref and the event", async () => {
    const issue = await make()
    const ref = { repoFullName: "o/r", number: 7, htmlUrl: "https://example.test/7" }
    await linkIssueToGithub(issue.id, ref, HUMAN)
    expect((await getIssue(issue.id))!.githubRef).toEqual(ref)
    expect(await kindsOf(issue.id)).toEqual(["created", "github_linked"])
  })
})

describe("deleteIssue", () => {
  it("removes the row and its whole trail", async () => {
    const issue = await make()
    await addIssueComment(issue.id, "note", HUMAN)
    await deleteIssue(issue.id)
    expect(await getIssue(issue.id)).toBeUndefined()
    expect(await listIssueEvents({ issueId: issue.id })).toEqual([])
  })

  it("does not release the identifier back to the pool", async () => {
    const issue = await make()
    await deleteIssue(issue.id)
    expect((await make()).identifier).toBe("MERC-2")
  })

  it("leaves other issues alone", async () => {
    const keep = await make()
    const drop = await make()
    await deleteIssue(drop.id)
    expect(await getIssue(keep.id)).toBeDefined()
    expect(await listIssueEvents({ issueId: keep.id })).toHaveLength(1)
  })
})

describe("countIssuesByStatus", () => {
  it("returns a zeroed record for an empty workspace", async () => {
    expect(await countIssuesByStatus("empty")).toEqual({
      backlog: 0,
      todo: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
      canceled: 0,
    })
  })

  it("counts a workspace's issues without seeing another's", async () => {
    await make({ status: "todo" })
    await make({ status: "todo" })
    await make({ status: "done" })

    const other = (await createIssueProject({ projectId: "w2", name: "Other" })).id
    await createIssue({
      projectId: "w2",
      issueProjectId: other,
      title: "elsewhere",
      status: "todo",
      createdBy: HUMAN,
    })

    expect(await countIssuesByStatus("w1")).toMatchObject({ todo: 2, done: 1, backlog: 0 })
  })
})

describe("schema-level guarantees", () => {
  it("refuses a duplicate printed identifier at the index level", async () => {
    const issue = await make()
    await expect(
      getDb().issues.add({ ...issue, id: "clone", identifier: issue.identifier })
    ).rejects.toThrow()
  })
})
