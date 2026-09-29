/**
 * @jest-environment jsdom
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

const mockListIssueWakeups = jest.fn()
const mockListWorkspaceIssueWakeups = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => ({
  listIssueWakeups: (...args: unknown[]) => mockListIssueWakeups(...args),
  listWorkspaceIssueWakeups: (...args: unknown[]) => mockListWorkspaceIssueWakeups(...args),
}))

import type { ScheduledTask } from "@/types/scheduler"
import type { BuiltInSkillContext } from "../types"
import { getSharedBuiltInSkillRegistry } from "../registry"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import "./wakeup-list"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const skill = getSharedBuiltInSkillRegistry().get("issue.wakeup_list")!
const CTX = { sessionId: "s1" } as BuiltInSkillContext

const rule = (issueId: string): ScheduledTask =>
  ({
    id: "wk1",
    type: "issue-wakeup",
    status: "paused",
    lastTerminalReason: "wakeup-paused-loop",
    trigger: { type: "interval", intervalMs: 3_600_000 },
    payload: { issueId, instruction: "Check CI" },
    config: { maxRuns: 20 },
    runCount: 4,
  }) as unknown as ScheduledTask

it("lists one issue's rules, with why a stopped one stopped", async () => {
  const container = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
  const issue = await createIssue({
    projectId: "w1",
    issueProjectId: container.id,
    title: "x",
    createdBy: { kind: "human" },
  })
  mockListIssueWakeups.mockResolvedValue([rule(issue.id)])
  const out = (await skill.execute({ issue: issue.identifier }, CTX)) as { wakeups: unknown[] }
  expect(mockListIssueWakeups).toHaveBeenCalledWith(issue.id)
  expect(out).toMatchObject({
    identifier: issue.identifier,
    wakeups: [{ wakeupId: "wk1", pauseReason: "loop", fires: 4, trigger: { on: "interval" } }],
  })
})

it("lists the whole workspace when no issue is named", async () => {
  mockListWorkspaceIssueWakeups.mockResolvedValue([rule("i1")])
  const out = (await skill.execute({}, CTX)) as { wakeups: unknown[] }
  expect(mockListWorkspaceIssueWakeups).toHaveBeenCalledWith("w1")
  expect(out.wakeups).toHaveLength(1)
})

it("is a read", () => {
  expect(skill).toMatchObject({ mutation: "read", mcpToolName: "issue_wakeup_list" })
})
