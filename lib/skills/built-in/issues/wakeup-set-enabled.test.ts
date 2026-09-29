const mockResolve = jest.fn()
jest.mock("./_wakeup", () => ({
  resolveWakeupInWorkspace: (...args: unknown[]) => mockResolve(...args),
}))
const mockSetEnabled = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => ({
  setIssueWakeupEnabled: (...args: unknown[]) => mockSetEnabled(...args),
}))

import type { BuiltInSkillContext } from "../types"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./wakeup-set-enabled"

const skill = getSharedBuiltInSkillRegistry().get("issue.wakeup_set_enabled")!
const CTX = { sessionId: "s1", humanConfirmed: true } as BuiltInSkillContext
const task = {
  id: "wk1",
  status: "active",
  trigger: { type: "event" },
  payload: { issueId: "i1", instruction: "x" },
  config: {},
  runCount: 0,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockResolvedValue({ task, issue: { identifier: "MERC-1" } })
  mockSetEnabled.mockResolvedValue({ ...task, status: "paused" })
})

it("pauses as the agent, through the scheduler policy", async () => {
  const out = await skill.execute({ wakeupId: "wk1", enabled: false }, CTX)
  expect(mockSetEnabled).toHaveBeenCalledWith("wk1", false, {
    source: "agent",
    sessionId: "s1",
    humanConfirmed: true,
  })
  expect(out).toMatchObject({
    status: "paused",
    identifier: "MERC-1",
    wakeup: { status: "paused" },
  })
})

it("resumes, and preflight checks the rule is in this workspace", async () => {
  expect(await skill.execute({ wakeupId: "wk1", enabled: true }, CTX)).toMatchObject({
    status: "resumed",
  })
  mockResolve.mockRejectedValueOnce(new Error("belongs to another workspace"))
  await expect(skill.preflight!({ wakeupId: "wk1", enabled: true }, CTX)).rejects.toThrow(
    /another workspace/
  )
})

it("confirms the direction on its card", () => {
  expect(JSON.stringify(skill.hitlSurface!({ wakeupId: "wk1", enabled: false }))).toContain(
    "Pause issue wakeup"
  )
  expect(JSON.stringify(skill.hitlSurface!({ wakeupId: "wk1", enabled: true }))).toContain(
    "Resume issue wakeup"
  )
})
