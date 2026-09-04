/**
 * @jest-environment jsdom
 */

/**
 * `issue.delete`: the destructive tier, and the run guard that still applies
 * to it.
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
import "./delete"
import { getIssue } from "@/lib/db/issues"
import { listIssueEvents } from "@/lib/db/issue-events"
import { createIssueRun } from "@/lib/db/issue-runs"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.delete")!
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

describe("issue.delete", () => {
  it("is destructive and opt-in, so a channel must name it before it is offered", () => {
    expect(skill.mutation).toBe("destructive")
    expect(skill.imAccess).toBe("opt-in")
  })

  it("removes the issue and its trail", async () => {
    const issue = await makeIssue()
    const out = await run({ issue: "MERC-1" })

    expect(out).toMatchObject({ status: "deleted", identifier: "MERC-1" })
    expect(await getIssue(issue.id)).toBeUndefined()
    expect(await listIssueEvents({ issueId: issue.id })).toEqual([])
  })

  it("burns the identifier rather than reusing it", async () => {
    await makeIssue()
    await run({ issue: "MERC-1" })
    const next = await makeIssue()

    expect(next.identifier).toBe("MERC-2")
  })

  it("still deletes an issue a run currently holds", async () => {
    // `canDelete` is a separate bit from `canMove`: the run guard owns the
    // status column, not the row's existence.
    const issue = await makeIssue({ status: "in_progress" })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: "t1",
      by: HUMAN,
    })

    expect(await run({ issue: issue.id })).toMatchObject({ status: "deleted" })
    expect(await getIssue(issue.id)).toBeUndefined()
  })

  it("refuses an issue in another workspace", async () => {
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    const foreign = await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "Not mine",
      createdBy: HUMAN,
    })

    await expect(run({ issue: "VEN-1" })).rejects.toThrow(/another workspace/)
    expect(await getIssue(foreign.id)).toBeDefined()
  })
})
