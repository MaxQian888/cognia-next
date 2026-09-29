const mockResolve = jest.fn()
jest.mock("./_wakeup", () => ({
  resolveWakeupInWorkspace: (...args: unknown[]) => mockResolve(...args),
}))
const mockDelete = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => ({
  deleteIssueWakeup: (...args: unknown[]) => mockDelete(...args),
}))

import type { BuiltInSkillContext } from "../types"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./wakeup-delete"

const skill = getSharedBuiltInSkillRegistry().get("issue.wakeup_delete")!
const CTX = { sessionId: "s1" } as BuiltInSkillContext

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockResolvedValue({ task: { id: "wk1" }, issue: { identifier: "MERC-1" } })
})

it("deletes as the agent, and is destructive + opt-in like issue.delete", async () => {
  expect(skill).toMatchObject({ mutation: "destructive", imAccess: "opt-in" })
  await expect(skill.execute({ wakeupId: "wk1" }, CTX)).resolves.toEqual({
    status: "deleted",
    identifier: "MERC-1",
    wakeupId: "wk1",
  })
  expect(mockDelete).toHaveBeenCalledWith("wk1", { source: "agent", sessionId: "s1" })
})

it("preflight refuses a rule outside the workspace", async () => {
  mockResolve.mockRejectedValueOnce(new Error("belongs to another workspace"))
  await expect(skill.preflight!({ wakeupId: "wk1" }, CTX)).rejects.toThrow(/another workspace/)
  expect(mockDelete).not.toHaveBeenCalled()
})
