/**
 * @jest-environment jsdom
 */

/**
 * `issue.update`: the whole field vocabulary in one call, and the partial
 * outcome the model has to be told about when the board refuses one field.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import "./update"
import { createIssueRun } from "@/lib/db/issue-runs"
import { getIssue } from "@/lib/db/issues"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.update")!
const run = (args: Record<string, unknown>) =>
  skill.execute(args as never, CTX) as Promise<Record<string, unknown>>

let containerId: string

beforeEach(async () => {
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function makeIssue(over: Record<string, unknown> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "Something",
    createdBy: HUMAN,
    ...over,
  })
}

describe("issue.update", () => {
  it("edits several fields in one call and reports each", async () => {
    const issue = await makeIssue()
    const out = await run({
      issue: "MERC-1",
      title: "Renamed",
      priority: "urgent",
      status: "todo",
    })

    expect(out.status).toBe("applied")
    expect(out.results).toEqual([
      { field: "title", status: "applied" },
      { field: "priority", status: "applied" },
      { field: "status", status: "applied" },
    ])
    expect(await getIssue(issue.id)).toMatchObject({
      title: "Renamed",
      priority: "urgent",
      status: "todo",
    })
  })

  it("assigns and clears an assignee", async () => {
    const issue = await makeIssue()
    await run({ issue: issue.id, assignee: { kind: "agent", id: "c1", label: "Scout" } })
    expect(await getIssue(issue.id)).toMatchObject({ assigneeKind: "agent", assigneeId: "c1" })

    await run({ issue: issue.id, assignee: null })
    expect((await getIssue(issue.id))?.assignee).toBeUndefined()
  })

  it("adds and removes labels", async () => {
    const issue = await makeIssue()
    await run({ issue: issue.id, addLabels: ["lab_a", "lab_b"] })
    expect((await getIssue(issue.id))?.labelIds).toEqual(["lab_a", "lab_b"])

    await run({ issue: issue.id, removeLabels: ["lab_a"] })
    expect((await getIssue(issue.id))?.labelIds).toEqual(["lab_b"])
  })

  it("moves the issue between containers by key", async () => {
    const target = await createIssueProject({ projectId: "w1", name: "Comet", key: "COM" })
    const issue = await makeIssue()

    await run({ issue: issue.id, issueProject: "COM" })
    // The identifier is a printed reference and does not follow the move.
    expect(await getIssue(issue.id)).toMatchObject({
      issueProjectId: target.id,
      identifier: "MERC-1",
    })
  })

  it("refuses a container in another workspace before writing anything", async () => {
    await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    const issue = await makeIssue()

    await expect(run({ issue: issue.id, title: "Renamed", issueProject: "VEN" })).rejects.toThrow(
      /another workspace/
    )
    expect(await getIssue(issue.id)).toMatchObject({ title: "Something" })
  })

  it("lands the edits and refuses only the move while a run holds the issue", async () => {
    // The partial outcome is the whole reason results are per-field: an agent
    // told "applied" for the batch would believe the move happened.
    const issue = await makeIssue({ status: "in_progress" })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: "t1",
      by: HUMAN,
    })

    const out = await run({ issue: issue.id, title: "Renamed", status: "done" })

    expect(out.status).toBe("partial")
    expect(out.results).toEqual([
      { field: "title", status: "applied" },
      { field: "status", status: "refused", reason: "runtime-owned" },
    ])
    expect(await getIssue(issue.id)).toMatchObject({ title: "Renamed", status: "in_progress" })
  })

  it("is a no-op when no field was supplied", async () => {
    const issue = await makeIssue()
    expect(await run({ issue: issue.id })).toMatchObject({ status: "no-op", results: [] })
  })
})
