/**
 * @jest-environment jsdom
 */

import type { PendingApproval } from "@cognia/agent-config-types"

// --- store fake ------------------------------------------------------------

interface SliceLike {
  pendingApprovals: PendingApproval[]
}

const state = {
  activeSessionId: null as string | null,
  sessions: {} as Record<string, SliceLike>,
  pendingApprovals: [] as PendingApproval[],
  markApprovalInterrupted: jest.fn((requestId: string, sessionId?: string, reason?: string) => {
    const apply = (list: PendingApproval[]) => {
      for (const a of list) {
        if (a.requestId === requestId && a.status !== "interrupted") {
          a.status = "interrupted"
          a.interruptReason = reason ?? "interrupted"
        }
      }
    }
    for (const slice of Object.values(state.sessions)) apply(slice.pendingApprovals)
    apply(state.pendingApprovals)
  }),
}

jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => state },
}))

// --- channel boundaries -----------------------------------------------------

const mockApproveTool = jest.fn(async () => {})
jest.mock("@/lib/claude/ipc", () => ({
  approveTool: (...args: unknown[]) => mockApproveTool(...(args as [])),
}))

const mockEnqueue = jest.fn(async () => null)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (...args: unknown[]) => mockEnqueue(...(args as [])),
}))

const mockRespondToPermission = jest.fn(async () => {})
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ respondToPermission: mockRespondToPermission }),
}))

const mockResolveRemotePermission = jest.fn(async () => ({ resolved: true }))
jest.mock("@/lib/ai/agent/external/remote-run-client", () => ({
  resolveRemotePermission: (...args: unknown[]) => mockResolveRemotePermission(...(args as [])),
}))

const mockAuthorizeShared = jest.fn(async (_approval?: unknown, decision?: unknown) => decision)
jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  authorizeSharedSessionApproval: (...args: unknown[]) => mockAuthorizeShared(...(args as [])),
}))

import {
  __resetApprovalRegistryForTesting,
  awaitApproval,
} from "@/lib/connectors/hitl/approval-registry"
import {
  __resetExternalApprovalsForTests,
  registerExternalApproval,
} from "@/lib/ai/agent/external/chat-decision-bridge"
import { APPROVAL_SUPERSEDED_REASON, supersedePendingApprovals } from "./approval-supersede"

function approval(over: Partial<PendingApproval>): PendingApproval {
  return {
    sessionId: "s1",
    requestId: "req-1",
    toolUseID: "tu-1",
    toolName: "Bash",
    input: { command: "rm -rf ./build" },
    status: "pending",
    ...over,
  }
}

beforeEach(() => {
  state.activeSessionId = null
  state.sessions = {}
  state.pendingApprovals = []
  state.markApprovalInterrupted.mockClear()
  mockApproveTool.mockClear()
  mockEnqueue.mockClear().mockResolvedValue(null)
  mockRespondToPermission.mockClear()
  mockResolveRemotePermission.mockClear().mockResolvedValue({ resolved: true })
  mockAuthorizeShared
    .mockClear()
    .mockImplementation(async (_approval?: unknown, decision?: unknown) => decision)
  __resetApprovalRegistryForTesting()
  __resetExternalApprovalsForTests()
})

describe("supersedePendingApprovals", () => {
  it("is a no-op when nothing is pending", async () => {
    state.sessions.s1 = { pendingApprovals: [] }
    expect(await supersedePendingApprovals("s1")).toBe(0)
    expect(mockApproveTool).not.toHaveBeenCalled()
  })

  it("denies a sidecar approval via approveTool and marks it superseded", async () => {
    state.sessions.s1 = { pendingApprovals: [approval({})] }
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(1)
    expect(mockApproveTool).toHaveBeenCalledWith(
      "s1",
      "req-1",
      "deny",
      "superseded by a new user instruction"
    )
    expect(state.sessions.s1.pendingApprovals[0].status).toBe("interrupted")
    expect(state.sessions.s1.pendingApprovals[0].interruptReason).toBe(APPROVAL_SUPERSEDED_REASON)
  })

  it("prefers the durable host-state intent when a host channel exists", async () => {
    state.sessions.s1 = { pendingApprovals: [approval({})] }
    mockEnqueue.mockResolvedValue({ id: "job-1" } as never)
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(1)
    expect(mockEnqueue).toHaveBeenCalledWith({
      sessionId: "s1",
      action: { kind: "approval.respond", requestId: "req-1", decision: "deny" },
    })
    expect(mockApproveTool).not.toHaveBeenCalled()
  })

  it("falls back to the execution handle when no host channel is negotiated", async () => {
    state.sessions.s1 = { pendingApprovals: [approval({})] }
    const resolvePermission = jest.fn(async () => {})
    const count = await supersedePendingApprovals("s1", {
      getExecutionHandle: () => ({ resolvePermission }),
    })
    expect(count).toBe(1)
    expect(resolvePermission).toHaveBeenCalledWith("req-1", "deny", {
      message: "superseded by a new user instruction",
    })
    expect(mockApproveTool).not.toHaveBeenCalled()
  })

  it("resolves an in-renderer registry waiter (built-in skill ask)", async () => {
    // `desktop-hitl` prefixes skill approvals with `skill-hitl:`; a real
    // registry waiter proves the Promise settles deny.
    const { BUILTIN_SKILL_APPROVAL_PREFIX } = await import("@/lib/skills/built-in/desktop-hitl")
    const requestId = `${BUILTIN_SKILL_APPROVAL_PREFIX}r1`
    state.sessions.s1 = { pendingApprovals: [approval({ requestId })] }
    const waiter = awaitApproval("s1", requestId)
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(1)
    await expect(waiter).resolves.toEqual({
      decision: "deny",
      message: "superseded by a new user instruction",
    })
    expect(mockApproveTool).not.toHaveBeenCalled()
  })

  it("answers an external-agent approval through the local manager", async () => {
    const requestId = registerExternalApproval({
      agentId: "codex",
      chatSessionId: "s1",
      event: {
        sessionId: "codex-sess",
        request: { id: "agent-req-1", toolCallId: "tc-1" },
      } as never,
    })!.requestId
    state.sessions.s1 = {
      pendingApprovals: [approval({ requestId })],
    }
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(1)
    expect(mockRespondToPermission).toHaveBeenCalledWith(
      "codex",
      "codex-sess",
      expect.objectContaining({ requestId: "agent-req-1", granted: false })
    )
    expect(mockApproveTool).not.toHaveBeenCalled()
  })

  it("answers a remote-hosted external approval over the decision RPC", async () => {
    const requestId = registerExternalApproval({
      agentId: "codex",
      chatSessionId: "s1",
      remoteDecisionId: "dec-9",
      event: {
        sessionId: "codex-sess",
        request: { id: "agent-req-2" },
      } as never,
    })!.requestId
    state.sessions.s1 = { pendingApprovals: [approval({ requestId })] }
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(1)
    expect(mockResolveRemotePermission).toHaveBeenCalledWith("dec-9", "deny")
    expect(mockRespondToPermission).not.toHaveBeenCalled()
  })

  it("leaves the entry pending when the shared-session bridge vetoes the deny", async () => {
    // A steer from a participant without approval authority must not deny
    // another member's ask — the vetoed entry stays answerable.
    state.sessions.s1 = { pendingApprovals: [approval({})] }
    mockAuthorizeShared.mockResolvedValueOnce(null)
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(0)
    expect(mockApproveTool).not.toHaveBeenCalled()
    expect(state.sessions.s1.pendingApprovals[0].status).toBe("pending")
  })

  it("leaves the entry pending when the channel throws", async () => {
    state.sessions.s1 = { pendingApprovals: [approval({})] }
    mockApproveTool.mockRejectedValueOnce(new Error("sidecar gone"))
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(0)
    expect(state.sessions.s1.pendingApprovals[0].status).toBe("pending")
  })

  it("skips already-interrupted entries and reads the active-session mirror", async () => {
    const live = approval({ requestId: "req-live" })
    const dead = approval({ requestId: "req-dead", status: "interrupted" })
    state.activeSessionId = "s1"
    state.pendingApprovals = [live, dead]
    const count = await supersedePendingApprovals("s1")
    expect(count).toBe(1)
    expect(mockApproveTool).toHaveBeenCalledTimes(1)
    expect(mockApproveTool).toHaveBeenCalledWith("s1", "req-live", "deny", expect.any(String))
  })

  it("supersedes subagent-routed approvals through the entry's own sessionId", async () => {
    // The entry was re-bucketed under the parent pane but keeps the ephemeral
    // session id — approveTool must answer THAT session, not the pane's.
    state.sessions.parent = {
      pendingApprovals: [approval({ sessionId: "ephemeral-1", origin: "subagent" })],
    }
    const count = await supersedePendingApprovals("parent")
    expect(count).toBe(1)
    expect(mockApproveTool).toHaveBeenCalledWith("ephemeral-1", "req-1", "deny", expect.any(String))
  })
})
