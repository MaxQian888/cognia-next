/**
 * @jest-environment jsdom
 */

/**
 * `issue.wakeup_checkin` against real run rows: only the run the periodic
 * rule started, and only from one of that run's own sessions.
 */

const mockGetIssueWakeup = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => ({
  getIssueWakeup: (...args: unknown[]) => mockGetIssueWakeup(...args),
}))

import type { BuiltInSkillContext } from "../types"
import { getSharedBuiltInSkillRegistry } from "../registry"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { applyRuntimeIssueStatus, createIssue, getIssue } from "@/lib/db/issues"
import { createIssueRun, getIssueRun } from "@/lib/db/issue-runs"
import { registerIssueRunAdapter, resetIssueRunRegistry } from "@/lib/issues/run/registry"
import "./wakeup-checkin"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(resetIssueRunRegistry)

const skill = getSharedBuiltInSkillRegistry().get("issue.wakeup_checkin")!
const ctx = (sessionId: string) => ({ sessionId }) as BuiltInSkillContext

const periodic = (issueId: string) => ({
  id: "wk1",
  type: "issue-wakeup",
  trigger: { type: "interval", intervalMs: 3_600_000 },
  payload: { issueId, instruction: "x" },
})

async function setup(
  runWakeup: { taskId: string; periodic: boolean } = { taskId: "wk1", periodic: true }
) {
  registerIssueRunAdapter({
    id: "fake",
    kind: "agent-task",
    canRun: async () => ({ ok: true }),
    start: async () => {
      throw new Error("unused")
    },
    poll: async () => null,
    sessionIds: async () => ["session-of-run"],
  })
  const container = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
  const issue = await createIssue({
    projectId: "w1",
    issueProjectId: container.id,
    title: "x",
    status: "todo",
    createdBy: { kind: "human" },
  })
  const run = await createIssueRun({
    issueId: issue.id,
    projectId: "w1",
    adapterId: "fake",
    kind: "agent-task",
    targetId: "t",
    by: { kind: "agent" },
    wakeup: { ...runWakeup, chain: [runWakeup.taskId], statusBefore: "todo" },
  })
  await applyRuntimeIssueStatus(issue.id, "in_progress", { kind: "agent" })
  mockGetIssueWakeup.mockResolvedValue(periodic(issue.id))
  return { issue, run }
}

it("settles the run from its own session and hands the issue back", async () => {
  const { issue, run } = await setup()
  await expect(
    skill.execute({ wakeupId: "wk1", note: "CI green" }, ctx("session-of-run"))
  ).resolves.toEqual({
    status: "checked-in",
    runId: run.id,
    wakeupId: "wk1",
  })
  expect((await getIssueRun(run.id))!.status).toBe("succeeded")
  expect((await getIssue(issue.id))!.status).toBe("todo")
})

it("refuses any other session", async () => {
  const { run } = await setup()
  await expect(
    skill.execute({ wakeupId: "wk1", note: "x" }, ctx("someone-else"))
  ).resolves.toMatchObject({
    status: "refused",
    reason: "not-this-run",
  })
  expect((await getIssueRun(run.id))!.status).toBe("running")
})

it("refuses when this wakeup started no active run, or is not periodic, or is unknown", async () => {
  await setup({ taskId: "other-rule", periodic: true })
  await expect(
    skill.execute({ wakeupId: "wk1", note: "x" }, ctx("session-of-run"))
  ).resolves.toMatchObject({
    reason: "no-active-run",
  })
  mockGetIssueWakeup.mockResolvedValueOnce({ ...periodic("i"), trigger: { type: "event" } })
  await expect(
    skill.execute({ wakeupId: "wk1", note: "x" }, ctx("session-of-run"))
  ).resolves.toMatchObject({
    reason: "not-periodic",
  })
  mockGetIssueWakeup.mockResolvedValueOnce(undefined)
  await expect(
    skill.execute({ wakeupId: "wk1", note: "x" }, ctx("session-of-run"))
  ).resolves.toMatchObject({
    reason: "not-a-wakeup",
  })
})
