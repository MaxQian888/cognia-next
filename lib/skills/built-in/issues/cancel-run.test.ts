/**
 * @jest-environment jsdom
 */

/**
 * `issue.cancel_run`: the counterpart to `issue.run`, including the workspace
 * check that a run id alone does not carry.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { createIssueRun, getIssueRun, settleIssueRun } from "@/lib/db/issue-runs"
import { resetIssueRunRegistry } from "@/lib/issues/run/registry"
import "./cancel-run"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const CTX = { sessionId: "s1" } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.cancel_run")!
const run = (args: Record<string, unknown>) =>
  skill.execute(args as never, CTX) as Promise<Record<string, unknown>>

let containerId: string

beforeEach(async () => {
  resetIssueRunRegistry()
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

afterEach(resetIssueRunRegistry)

async function startedRun(workspaceId = "w1", container = () => containerId) {
  const issue = await createIssue({
    projectId: workspaceId,
    issueProjectId: container(),
    title: "Something",
    status: "in_progress",
    createdBy: HUMAN,
  })
  const created = await createIssueRun({
    issueId: issue.id,
    projectId: workspaceId,
    adapterId: "engine-a",
    kind: "agent-task",
    targetId: "t1",
    by: HUMAN,
  })
  return { issue, run: created }
}

describe("issue.cancel_run", () => {
  it("settles the run and returns the issue to todo", async () => {
    // Cancelling parks the issue at todo, not at in_review: nothing was
    // produced for a human to review.
    const { issue, run: created } = await startedRun()

    expect(await run({ runId: created.id })).toMatchObject({
      status: "cancelled",
      runId: created.id,
    })
    expect((await getIssueRun(created.id))?.status).toBe("cancelled")
    expect(await getIssue(issue.id)).toMatchObject({ status: "todo" })
  })

  it("says so for an unknown run id", async () => {
    expect(await run({ runId: "irun_nope" })).toMatchObject({ status: "not-found" })
  })

  it("refuses a run belonging to another workspace", async () => {
    // A run id is opaque and carries no workspace on its face, so without this
    // check a stray id would cancel work this session cannot even see.
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    const { run: foreign } = await startedRun("w2", () => other.id)

    expect(await run({ runId: foreign.id })).toMatchObject({
      status: "refused",
      reason: "other-workspace",
    })
    expect((await getIssueRun(foreign.id))?.status).toBe("running")
  })

  it("reports an already-settled run instead of settling it twice", async () => {
    const { run: created } = await startedRun()
    await settleIssueRun(created.id, { status: "succeeded" })

    expect(await run({ runId: created.id })).toMatchObject({
      status: "already-settled",
      runStatus: "succeeded",
    })
    expect((await getIssueRun(created.id))?.status).toBe("succeeded")
  })
})
