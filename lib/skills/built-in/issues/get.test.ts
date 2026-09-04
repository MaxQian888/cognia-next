/**
 * @jest-environment jsdom
 */

/**
 * `issue.get`: the one round trip an assistant needs before it acts, and the
 * adapter failure it must survive.
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
import "./get"
import { createIssueRun } from "@/lib/db/issue-runs"
import { addIssueComment } from "@/lib/db/issues"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.get")!
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

describe("issue.get", () => {
  it("resolves by printed identifier and carries the container", async () => {
    await makeIssue()
    const out = await run({ issue: "MERC-1" })

    expect(out.issue).toMatchObject({ identifier: "MERC-1", title: "Something" })
    expect(out.issueProject).toMatchObject({ key: "MERC", name: "Mercury" })
  })

  it("returns the activity trail newest first", async () => {
    const issue = await makeIssue()
    await addIssueComment(issue.id, "looked at it", HUMAN)

    const activity = (await run({ issue: issue.id })).activity as { kind: string }[]
    expect(activity.map((entry) => entry.kind)).toEqual(["commented", "created"])
  })

  it("honours an activity limit of zero", async () => {
    // A caller that only wants the fields should not pay for the trail.
    const issue = await makeIssue()
    expect((await run({ issue: issue.id, activityLimit: 0 })).activity).toEqual([])
  })

  it("lists runs with their artifacts", async () => {
    const issue = await makeIssue()
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: "t1",
      by: HUMAN,
    })

    const runs = (await run({ issue: issue.id })).runs as { status: string; kind: string }[]
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: "running", kind: "agent-task" })
  })

  it("still answers when no run adapter is registered", async () => {
    // A read must not fail because an engine is unavailable in this host.
    const issue = await makeIssue()
    expect(await run({ issue: issue.id })).toMatchObject({ runnableBy: [] })
  })

  it("refuses an issue belonging to another workspace", async () => {
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "Not mine",
      createdBy: HUMAN,
    })

    await expect(run({ issue: "VEN-1" })).rejects.toThrow(/another workspace/)
  })
})
