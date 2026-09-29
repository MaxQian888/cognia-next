/**
 * @jest-environment jsdom
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

const mockGetIssueWakeup = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => ({
  getIssueWakeup: (...args: unknown[]) => mockGetIssueWakeup(...args),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { resolveWakeupInWorkspace } from "./_wakeup"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function issueIn(workspace: string, key: string) {
  const container = await createIssueProject({ projectId: workspace, name: key, key })
  return createIssue({
    projectId: workspace,
    issueProjectId: container.id,
    title: "x",
    createdBy: { kind: "human" },
  })
}

it("returns the rule and its issue when both are in the session's workspace", async () => {
  const issue = await issueIn("w1", "MERC")
  mockGetIssueWakeup.mockResolvedValue({
    id: "wk",
    payload: { issueId: issue.id, instruction: "x" },
  })
  await expect(resolveWakeupInWorkspace("wk", { sessionId: "s" })).resolves.toMatchObject({
    task: { id: "wk" },
    issue: { id: issue.id },
  })
})

it("refuses an unknown id and a rule from another workspace", async () => {
  mockGetIssueWakeup.mockResolvedValue(undefined)
  await expect(resolveWakeupInWorkspace("nope", { sessionId: "s" })).rejects.toThrow(
    /issue_wakeup_list/
  )
  const foreign = await issueIn("w2", "VEN")
  mockGetIssueWakeup.mockResolvedValue({
    id: "wk",
    payload: { issueId: foreign.id, instruction: "x" },
  })
  await expect(resolveWakeupInWorkspace("wk", { sessionId: "s" })).rejects.toThrow(
    /another workspace/
  )
})
