/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssueCycle } from "@/lib/db/issue-cycles"
import { createIssue, getIssue } from "@/lib/db/issues"
import { createIssueRun } from "@/lib/db/issue-runs"
import { listIssueEvents } from "@/lib/db/issue-events"
import { createLabel, listLabels } from "@/lib/db/labels"
import type { Issue, IssueActor } from "@/types/issues"
import { syncActorFor } from "@/types/issues"
import {
  applyRemoteField,
  ensureIssueLabels,
  fieldValuesDiffer,
  localFieldValue,
  remoteFieldValue,
} from "./apply"
import type { RemoteIssue } from "./types"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }
const SYNC = syncActorFor("fake")

let containerId: string
beforeEach(async () => {
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function make(over: Partial<Parameters<typeof createIssue>[0]> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "t",
    createdBy: HUMAN,
    ...over,
  })
}

const noContext = { labelsById: new Map(), cycleExternalIdOf: () => undefined }

describe("remoteFieldValue / localFieldValue / fieldValuesDiffer", () => {
  it("normalises both sides into one comparable shape", async () => {
    const remote: RemoteIssue = {
      externalId: "x",
      title: "T",
      description: "",
      status: "todo",
      labels: ["b", "a", " a "],
      assigneeLabel: null,
      dueDate: null,
      remoteUpdatedAt: 1,
    }
    expect(remoteFieldValue(remote, "description")).toBeNull()
    expect(remoteFieldValue(remote, "labels")).toEqual(["a", "b"])
    expect(remoteFieldValue(remote, "priority")).toBeUndefined()
    expect(remoteFieldValue(remote, "estimate")).toBeUndefined()
    expect(remoteFieldValue(remote, "cycle")).toBeUndefined()

    const bug = await createLabel({ scope: "issue", name: "b" })
    const issue = await make({ labelIds: [bug.id], cycleId: undefined })
    const context = { labelsById: new Map([[bug.id, bug]]), cycleExternalIdOf: () => "m/1" }
    expect(localFieldValue(issue, "labels", context)).toEqual(["b"])
    expect(localFieldValue(issue, "description", context)).toBeNull()
    expect(localFieldValue(issue, "assignee", context)).toBeNull()
    expect(localFieldValue(issue, "cycle", context)).toBeNull()

    expect(fieldValuesDiffer(["a", "b"], ["a", "b"])).toBe(false)
    expect(fieldValuesDiffer(["a"], ["a", "b"])).toBe(true)
    expect(fieldValuesDiffer(null, "x")).toBe(true)
    expect(fieldValuesDiffer(3, 3)).toBe(false)
  })
})

describe("ensureIssueLabels", () => {
  it("reuses rows by name, case-insensitively, and creates the rest once", async () => {
    await createLabel({ scope: "issue", name: "Bug" })
    const rows = await ensureIssueLabels(["bug", "Feature", "feature"])
    expect(rows.map((row) => row.name)).toEqual(["Bug", "Feature"])
    expect((await listLabels("issue")).filter((row) => row.name === "Feature")).toHaveLength(1)
  })
})

describe("applyRemoteField", () => {
  it("writes every field through the board's writers and records synced_in", async () => {
    const cycle = await createIssueCycle({ projectId: "w1", kind: "cycle", name: "S1" })
    const issue = await make()
    const reload = async () => (await getIssue(issue.id)) as Issue
    const opts = { provider: "fake", cycleIdOf: () => cycle.id }
    expect(await applyRemoteField(issue, "title", "New", SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "description", "Body", SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "status", "in_review", SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "priority", "high", SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "assignee", "octocat", SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "labels", ["x", "y"], SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "labels", ["y"], SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "dueDate", 123, SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "estimate", 5, SYNC, opts)).toBe(true)
    expect(await applyRemoteField(await reload(), "cycle", "m/1", SYNC, opts)).toBe(true)
    const after = await reload()
    expect(after).toMatchObject({
      title: "New",
      description: "Body",
      status: "in_review",
      priority: "high",
      assignee: { kind: "human", label: "octocat" },
      dueDate: 123,
      estimate: 5,
      cycleId: cycle.id,
    })
    const names = (await listLabels("issue"))
      .filter((row) => after.labelIds.includes(row.id))
      .map((r) => r.name)
    expect(names).toEqual(["y"])
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)
    expect(kinds.filter((k) => k === "synced_in")).toHaveLength(10)
    expect(await applyRemoteField(await reload(), "assignee", null, SYNC, opts)).toBe(true)
    expect((await reload()).assignee).toBeUndefined()
  })

  it("refuses a status write while a run owns the issue, and an empty title", async () => {
    const issue = await make({ status: "in_progress" })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "a",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
    })
    expect(await applyRemoteField(issue, "status", "done", SYNC, { runActive: true })).toBe(false)
    expect((await getIssue(issue.id))!.status).toBe("in_progress")
    expect(await applyRemoteField(issue, "title", "  ", SYNC)).toBe(false)
  })

  it("can write without recording, for a person's conflict resolution", async () => {
    const issue = await make()
    await applyRemoteField(issue, "title", "Kept", HUMAN, { record: false })
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)
    expect(kinds).toEqual(["created", "title_changed"])
    void noContext
  })
})
