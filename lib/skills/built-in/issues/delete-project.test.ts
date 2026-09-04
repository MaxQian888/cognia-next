/**
 * @jest-environment jsdom
 */

/**
 * `issue.delete_project`: the widest cascade in the family, and the count
 * check that stops it taking rows the caller did not know were there.
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
import "./delete-project"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listIssues } from "@/lib/db/issues"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.delete_project")!
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

describe("issue.delete_project", () => {
  it("is destructive and opt-in", () => {
    expect(skill.mutation).toBe("destructive")
    expect(skill.imAccess).toBe("opt-in")
  })

  it("cascades the container and everything in it", async () => {
    await makeIssue()
    await makeIssue()

    const out = await run({ issueProject: "MERC", confirmIssueCount: 2 })

    expect(out).toMatchObject({ status: "deleted", key: "MERC", deletedIssues: 2 })
    expect(await listIssueProjects({ projectId: "w1" })).toEqual([])
    expect(await listIssues({ projectId: "w1" })).toEqual([])
  })

  it("refuses when the caller's count is stale, and writes nothing", async () => {
    // The count is the whole safety property: an agent that read the board
    // three turns ago must not delete rows filed since.
    await makeIssue()
    await makeIssue()

    const out = await run({ issueProject: "MERC", confirmIssueCount: 1 })

    expect(out).toMatchObject({
      status: "refused",
      reason: "count-mismatch",
      actualIssueCount: 2,
      expectedIssueCount: 1,
    })
    expect(await listIssueProjects({ projectId: "w1" })).toHaveLength(1)
    expect(await listIssues({ projectId: "w1" })).toHaveLength(2)
  })

  it("deletes an empty container on a count of zero", async () => {
    expect(await run({ issueProject: "MERC", confirmIssueCount: 0 })).toMatchObject({
      status: "deleted",
      deletedIssues: 0,
    })
  })

  it("refuses a container in another workspace", async () => {
    await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await expect(run({ issueProject: "VEN", confirmIssueCount: 0 })).rejects.toThrow(
      /another workspace/
    )
    expect(await listIssueProjects({ projectId: "w2" })).toHaveLength(1)
  })

  it("states the blast radius on the confirmation card", async () => {
    const surface = skill.hitlSurface!({ issueProject: "MERC", confirmIssueCount: 4 } as never)
    expect(JSON.stringify(surface)).toContain("4")
  })
})
