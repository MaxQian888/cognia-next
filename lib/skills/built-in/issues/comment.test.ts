/**
 * @jest-environment jsdom
 */

/**
 * `issue.comment`: append-only, attributed to the assistant rather than to
 * whoever happens to be at the keyboard.
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
import "./comment"
import { listIssueComments } from "@/lib/db/issue-events"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.comment")!
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

describe("issue.comment", () => {
  it("appends the comment to the trail", async () => {
    const issue = await makeIssue()
    const out = await run({ issue: "MERC-1", body: "Reproduced on 800px." })

    expect(out).toMatchObject({ status: "added", identifier: "MERC-1" })
    const comments = await listIssueComments(issue.id)
    expect(comments).toHaveLength(1)
    expect(comments[0].payload).toMatchObject({ body: "Reproduced on 800px." })
  })

  it("signs the comment as an agent, never as the user", async () => {
    const issue = await makeIssue()
    await run({ issue: issue.id, body: "note" })

    const [comment] = await listIssueComments(issue.id)
    expect((comment.payload as { by: { kind: string } }).by.kind).toBe("agent")
  })

  it("leaves the issue's own fields alone", async () => {
    const issue = await makeIssue()
    await run({ issue: issue.id, body: "note" })

    const { getIssue } = await import("@/lib/db/issues")
    expect(await getIssue(issue.id)).toMatchObject({ status: "backlog", title: "Something" })
  })

  it("refuses an issue in another workspace", async () => {
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "Not mine",
      createdBy: HUMAN,
    })

    await expect(run({ issue: "VEN-1", body: "note" })).rejects.toThrow(/another workspace/)
  })
})
