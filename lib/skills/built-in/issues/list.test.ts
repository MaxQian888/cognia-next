/**
 * @jest-environment jsdom
 */

/**
 * `issue.list` against real rows: the filters, the cap, and the workspace
 * scope that keeps another workspace's board out of the answer.
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
import "./list"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.list")!
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

describe("issue.list", () => {
  it("returns the workspace's rows with the identifiers other tools accept", async () => {
    await makeIssue({ title: "Alpha" })
    const out = await run({})

    expect(out).toMatchObject({ workspaceId: "w1", total: 1, returned: 1 })
    expect((out.issues as { identifier: string }[])[0]).toMatchObject({
      identifier: "MERC-1",
      title: "Alpha",
    })
  })

  it("never reaches into another workspace", async () => {
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "Not mine",
      createdBy: HUMAN,
    })

    expect(await run({})).toMatchObject({ total: 0 })
  })

  it("filters by column, priority and free text", async () => {
    await makeIssue({ title: "Crash on boot", status: "todo", priority: "urgent" })
    await makeIssue({ title: "Polish copy", status: "backlog", priority: "low" })

    expect(await run({ status: ["todo"] })).toMatchObject({ total: 1 })
    expect(await run({ priority: ["low"] })).toMatchObject({ total: 1 })
    expect(await run({ query: "CRASH" })).toMatchObject({ total: 1 })
    expect(await run({ query: "nothing here" })).toMatchObject({ total: 0 })
  })

  it("matches on the identifier, which is how a user names an issue", async () => {
    await makeIssue()
    expect(await run({ query: "merc-1" })).toMatchObject({ total: 1 })
  })

  it("separates the three assignee buckets", async () => {
    await makeIssue({ title: "Mine", assignee: { kind: "human" } })
    await makeIssue({ title: "Bot", assignee: { kind: "agent", id: "c1" } })
    await makeIssue({ title: "Squad", assignee: { kind: "team", id: "t1" } })
    await makeIssue({ title: "Nobody" })

    expect(await run({ assignee: "me" })).toMatchObject({ total: 1 })
    // One bucket for both, because an assistant asking "what are the agents on"
    // does not distinguish a character from a squad.
    expect(await run({ assignee: "agents" })).toMatchObject({ total: 2 })
    expect(await run({ assignee: "unassigned" })).toMatchObject({ total: 1 })
    expect(await run({ assignee: "any" })).toMatchObject({ total: 4 })
  })

  it("scopes to one container, named by key", async () => {
    const second = await createIssueProject({ projectId: "w1", name: "Comet", key: "COM" })
    await makeIssue()
    await createIssue({
      projectId: "w1",
      issueProjectId: second.id,
      title: "Elsewhere",
      createdBy: HUMAN,
    })

    expect(await run({ issueProject: "COM" })).toMatchObject({ total: 1 })
  })

  it("caps the page while still reporting the true total", async () => {
    await makeIssue()
    await makeIssue()
    await makeIssue()

    expect(await run({ limit: 2 })).toMatchObject({ total: 3, returned: 2 })
  })
})
