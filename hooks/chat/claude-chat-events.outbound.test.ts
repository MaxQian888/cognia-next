/** @jest-environment jsdom */
// The desktop listener's outbound chokepoint (ADR-0239): the plan runs before
// the always-allow list, an enforced ask is a person's alone, and shadow mode
// leaves the old path as it was.

const mockApproveTool = jest.fn(async (..._args: unknown[]) => {})
jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  approveTool: (...args: unknown[]) => mockApproveTool(...args),
}))
const mockPlanOutboundAsk = jest.fn()
const mockRecordShadow = jest.fn(async (..._args: unknown[]) => {})
jest.mock("@/lib/policy/action-review/plan-tool-call", () => ({
  planOutboundAsk: (...args: unknown[]) => mockPlanOutboundAsk(...args),
  recordOutboundShadowObservation: (...args: unknown[]) => mockRecordShadow(...args),
}))
jest.mock("@/lib/claude/adapter-hooks", () => ({
  ...jest.requireActual("@/lib/claude/adapter-hooks"),
  dispatchPreToolUse: jest.fn(async () => ({ action: "allow" })),
}))
jest.mock("@/lib/claude/permissions/auto-mode-runner", () => ({ runAutoModeForTool: jest.fn() }))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => null),
}))

import type { PendingOutboundReview } from "@cognia/agent-config-types"

import { useChatStore } from "@/stores/chat"

import { handleEvent } from "./claude-chat-events"

const SEND = "mcp__cognia-plugin-tools__im_broadcast"
const REVIEW: PendingOutboundReview = {
  enforced: true,
  targets: [{ kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_1" }],
  unauthorized: [{ kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_1" }],
}

function request(sessionId = "s1", toolName = SEND) {
  return {
    type: "permission_request",
    sessionId,
    requestId: "req-1",
    toolUseID: "tu-1",
    toolName,
    input: { conversationKeys: ["lark:bot-a:oc_1"] },
  }
}

async function deliver(evt: unknown, allowList: string[] = []) {
  await handleEvent(
    evt as never,
    { current: "s1" },
    { current: allowList },
    { current: new Map() },
    { current: new Map() },
    { current: null },
    {
      messagesMirrorRef: { current: new Map() },
      registry: {},
      getExecutionHandle: () => undefined,
    } as never
  )
}

const pending = () => useChatStore.getState().sessions.s1?.pendingApprovals ?? []

beforeEach(() => {
  mockApproveTool.mockClear()
  mockPlanOutboundAsk.mockReset()
  mockRecordShadow.mockClear()
  useChatStore.getState().clear()
  useChatStore.setState({ openSessionIds: ["s1"] } as never)
  useChatStore.getState().replaceSessionMessages("s1", [])
})

describe("outbound permission requests on the desktop", () => {
  it("lets the plan answer the call, before the always-allow list", async () => {
    mockPlanOutboundAsk.mockImplementation(async (_evt, _options, approve) => {
      await approve("deny", "fenced", { authority: "policy-deny" })
      return { answered: true }
    })
    await deliver(request(), [SEND])
    expect(mockPlanOutboundAsk).toHaveBeenCalledTimes(1)
    expect(mockApproveTool).toHaveBeenCalledTimes(1)
    expect(mockApproveTool).toHaveBeenCalledWith(
      "s1",
      "req-1",
      "deny",
      "fenced",
      undefined,
      undefined,
      { authority: "policy-deny" }
    )
    expect(pending()).toHaveLength(0)
  })

  it("keeps an enforced ask for a person: no always-allow, a per-call card naming the recipient", async () => {
    mockPlanOutboundAsk.mockResolvedValue({ answered: false, personOnly: true, review: REVIEW })
    await deliver(request(), [SEND])
    expect(mockApproveTool).not.toHaveBeenCalled()
    expect(pending()).toEqual([
      expect.objectContaining({
        requestId: "req-1",
        outbound: REVIEW,
        suppressAlwaysAllowRule: true,
        requiresPerCallApproval: true,
      }),
    ])
  })

  it("changes nothing in shadow mode: the always-allow list still answers", async () => {
    mockPlanOutboundAsk.mockResolvedValue({
      answered: false,
      personOnly: false,
      review: { ...REVIEW, enforced: false },
    })
    await deliver(request(), [SEND])
    expect(mockApproveTool).toHaveBeenCalledWith(
      "s1",
      "req-1",
      "allow",
      undefined,
      undefined,
      undefined,
      { authority: "policy-rule" }
    )
  })

  it("plans a session nobody watches as unattended, and names the system for its denial", async () => {
    mockPlanOutboundAsk.mockResolvedValue({ answered: false, personOnly: true, review: REVIEW })
    await deliver(request("closed"))
    expect(mockPlanOutboundAsk.mock.calls[0][1]).toMatchObject({ unattended: true })
    expect(mockApproveTool).toHaveBeenCalledWith(
      "closed",
      "req-1",
      "deny",
      "auto-denied: session not open",
      undefined,
      undefined,
      { authority: "system" }
    )
  })

  it("does not consult the plan for a tool that is not outbound", async () => {
    mockPlanOutboundAsk.mockResolvedValue(null)
    await deliver(request("s1", "mcp__cognia-tools__write"), ["mcp__cognia-tools__write"])
    expect(mockPlanOutboundAsk).not.toHaveBeenCalled()
    expect(mockApproveTool).toHaveBeenCalledWith(
      "s1",
      "req-1",
      "allow",
      undefined,
      undefined,
      undefined,
      { authority: "policy-rule" }
    )
  })

  it("records a shadow observation the sidecar reports", async () => {
    const event = {
      type: "explicit_tool_allowed",
      sessionId: "s1",
      toolName: SEND,
      input: {},
      permissionClass: "outbound",
    }
    await deliver(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockRecordShadow).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ unattended: false })
    )
  })
})
