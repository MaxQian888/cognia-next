const mockPushApproval = jest.fn()
const mockClearApproval = jest.fn()
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: {
    getState: () => ({
      pushApproval: (...a: unknown[]) => mockPushApproval(...a),
      clearApproval: (...a: unknown[]) => mockClearApproval(...a),
    }),
  },
}))

import {
  __resetApprovalRegistryForTesting,
  resolveApproval,
} from "@/lib/connectors/hitl/approval-registry"
import {
  BUILTIN_SKILL_APPROVAL_PREFIX,
  grantDesktopSkillSessionBypass,
  isBuiltInSkillApprovalRequestId,
  isSessionGrantWithheld,
  requestDesktopSkillApproval,
} from "./desktop-hitl"

const SCHEDULE_WRITE = {
  id: "schedule.create",
  family: "schedule",
  mcpToolName: "scheduler_create_task",
  label: { en: "Schedule a task", "zh-CN": "新建定时任务" },
  mutation: "write" as const,
}

const SKILL = {
  id: "im.create_chat",
  family: "im",
  mcpToolName: "im_create_chat",
  label: { en: "Create group chat", "zh-CN": "创建群聊" },
  mutation: "write" as const,
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetApprovalRegistryForTesting()
})

describe("requestDesktopSkillApproval", () => {
  it("pushes a synthetic PendingApproval and resolves allow on user approval", async () => {
    const p = requestDesktopSkillApproval({ sessionId: "s1", skill: SKILL, args: { name: "G" } })
    // Let the lazy store import + pushApproval land.
    await new Promise((r) => setTimeout(r, 0))
    expect(mockPushApproval).toHaveBeenCalledTimes(1)
    const approval = mockPushApproval.mock.calls[0][0] as {
      sessionId: string
      requestId: string
      toolName: string
      input: unknown
    }
    expect(approval.sessionId).toBe("s1")
    expect(approval.requestId.startsWith(BUILTIN_SKILL_APPROVAL_PREFIX)).toBe(true)
    expect(approval.toolName).toBe("im_create_chat")
    expect(approval.input).toEqual({ name: "G" })

    resolveApproval("s1", approval.requestId, { decision: "allow" })
    await expect(p).resolves.toEqual({ approved: true, reason: "user" })
    // The dialog card is cleared after resolution.
    expect(mockClearApproval).toHaveBeenCalledWith(approval.requestId, "s1")
  })

  it("resolves deny on user decline", async () => {
    const p = requestDesktopSkillApproval({ sessionId: "s1", skill: SKILL, args: {} })
    await new Promise((r) => setTimeout(r, 0))
    const { requestId } = mockPushApproval.mock.calls[0][0] as { requestId: string }
    resolveApproval("s1", requestId, { decision: "deny" })
    await expect(p).resolves.toEqual({ approved: false, reason: "user" })
  })

  it("auto-denies with reason=expired when the TTL elapses", async () => {
    jest.useFakeTimers()
    try {
      const p = requestDesktopSkillApproval({ sessionId: "s1", skill: SKILL, args: {} })
      // Flush the lazy imports/microtasks so awaitApproval has registered.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(10 * 60 * 1000 + 1)
      await expect(p).resolves.toEqual({ approved: false, reason: "expired" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("short-circuits without a dialog when a session bypass was granted", async () => {
    grantDesktopSkillSessionBypass("s1", "im_create_chat")
    const out = await requestDesktopSkillApproval({ sessionId: "s1", skill: SKILL, args: {} })
    expect(out).toEqual({ approved: true, reason: "session_bypass" })
    expect(mockPushApproval).not.toHaveBeenCalled()
  })
})

describe("schedule writes are approved one at a time", () => {
  it("withholds the session grant for schedule writes only", () => {
    expect(isSessionGrantWithheld(SCHEDULE_WRITE)).toBe(true)
    expect(isSessionGrantWithheld({ ...SCHEDULE_WRITE, mutation: "read" })).toBe(false)
    expect(isSessionGrantWithheld(SKILL)).toBe(false)
  })

  it("hides 'allow for session' on the dialog it pushes", async () => {
    const p = requestDesktopSkillApproval({ sessionId: "s1", skill: SCHEDULE_WRITE, args: {} })
    await new Promise((r) => setTimeout(r, 0))
    const approval = mockPushApproval.mock.calls[0][0] as {
      requestId: string
      suppressAlwaysAllowRule?: boolean
    }
    expect(approval.suppressAlwaysAllowRule).toBe(true)
    resolveApproval("s1", approval.requestId, { decision: "allow" })
    await expect(p).resolves.toEqual({ approved: true, reason: "user" })
  })

  it("asks again even when a session grant exists for the tool", async () => {
    grantDesktopSkillSessionBypass("s1", "scheduler_create_task")
    const p = requestDesktopSkillApproval({ sessionId: "s1", skill: SCHEDULE_WRITE, args: {} })
    await new Promise((r) => setTimeout(r, 0))
    expect(mockPushApproval).toHaveBeenCalledTimes(1)
    const { requestId } = mockPushApproval.mock.calls[0][0] as { requestId: string }
    resolveApproval("s1", requestId, { decision: "deny" })
    await expect(p).resolves.toEqual({ approved: false, reason: "user" })
  })

  it("does not mark other families' dialogs", async () => {
    const p = requestDesktopSkillApproval({ sessionId: "s1", skill: SKILL, args: {} })
    await new Promise((r) => setTimeout(r, 0))
    const approval = mockPushApproval.mock.calls[0][0] as {
      requestId: string
      suppressAlwaysAllowRule?: boolean
    }
    expect(approval.suppressAlwaysAllowRule).toBeUndefined()
    resolveApproval("s1", approval.requestId, { decision: "deny" })
    await p
  })
})

describe("isBuiltInSkillApprovalRequestId", () => {
  it("matches only the builtin-skill: prefix", () => {
    expect(isBuiltInSkillApprovalRequestId("builtin-skill:im.create_chat:x")).toBe(true)
    expect(isBuiltInSkillApprovalRequestId("perm_12345")).toBe(false)
  })
})
