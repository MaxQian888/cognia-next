import type {
  AcpElicitationRequest,
  AcpPermissionOption,
  ExternalAgentElicitationRequestEvent,
  ExternalAgentPermissionRequestEvent,
} from "@/types/agent/external-agent"

import {
  EXTERNAL_AGENT_APPROVAL_PREFIX,
  __resetExternalApprovalsForTests,
  externalApprovalRequestId,
  getExternalApprovalTarget,
  isExternalAgentApprovalRequestId,
  pickPermissionOptionId,
  elicitationCancelResponse,
  registerExternalApproval,
  registerExternalElicitation,
  releaseExternalApprovals,
  resolveExternalApproval,
  resolveExternalElicitation,
  toPermissionResponse,
} from "./chat-decision-bridge"

const OPTIONS: AcpPermissionOption[] = [
  { optionId: "o-allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "o-allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "o-reject-once", name: "Reject", kind: "reject_once" },
]

function event(
  overrides: Partial<ExternalAgentPermissionRequestEvent["request"]> = {},
  sessionId = "ext-session"
): ExternalAgentPermissionRequestEvent {
  return {
    type: "permission_request",
    timestamp: new Date(),
    sessionId,
    request: {
      id: "req-1",
      toolInfo: { id: "t1", name: "bash", description: "Run a command" },
      rawInput: { command: "git status" },
      options: OPTIONS,
      ...overrides,
    },
  } as ExternalAgentPermissionRequestEvent
}

beforeEach(() => __resetExternalApprovalsForTests())

describe("request id namespacing", () => {
  // The prefix is the whole contract with `respondToApproval`: these ids are
  // answered in-renderer and must never reach `approveTool`, which has no
  // waiter for them and would leave both the dialog and the agent hanging.
  it("marks its ids and rejects foreign ones", () => {
    const id = externalApprovalRequestId("agent-a", "req-1")
    expect(id.startsWith(EXTERNAL_AGENT_APPROVAL_PREFIX)).toBe(true)
    expect(isExternalAgentApprovalRequestId(id)).toBe(true)
    expect(isExternalAgentApprovalRequestId("realtime-tool:x")).toBe(false)
    expect(isExternalAgentApprovalRequestId("toolu_123")).toBe(false)
  })

  it("is stable for the same agent + request, so a re-emit does not stack a second dialog", () => {
    expect(externalApprovalRequestId("a", "r")).toBe(externalApprovalRequestId("a", "r"))
    expect(externalApprovalRequestId("a", "r")).not.toBe(externalApprovalRequestId("b", "r"))
  })
})

describe("registerExternalApproval", () => {
  it("builds a chat-session-scoped approval and remembers the agent's own session", () => {
    const approval = registerExternalApproval({
      agentId: "agent-a",
      chatSessionId: "chat-1",
      event: event(),
    })
    // Scoped to the CHAT session — the dialog is rendered per pane, so an
    // external session id here would render the card into no pane at all.
    expect(approval?.sessionId).toBe("chat-1")
    expect(approval?.toolName).toBe("bash")
    expect(approval?.input).toEqual({ command: "git status" })
    expect(approval?.status).toBe("pending")

    const target = getExternalApprovalTarget(approval!.requestId)
    expect(target?.agentId).toBe("agent-a")
    // The answer goes back to the session that asked, not the pane in front of
    // the user — a mid-turn pane switch must not misroute it.
    expect(target?.externalSessionId).toBe("ext-session")
    expect(target?.responseRequestId).toBe("req-1")
  })

  it("prefers request.requestId over request.id as the answer target", () => {
    const approval = registerExternalApproval({
      agentId: "a",
      chatSessionId: "chat-1",
      event: event({ requestId: "wire-7" }),
    })
    expect(getExternalApprovalTarget(approval!.requestId)?.responseRequestId).toBe("wire-7")
  })

  it("falls back to the request's own session id before the chat id", () => {
    const approval = registerExternalApproval({
      agentId: "a",
      chatSessionId: "chat-1",
      event: event({ sessionId: "from-request" }, ""),
    })
    expect(getExternalApprovalTarget(approval!.requestId)?.externalSessionId).toBe("from-request")
  })

  // An approval with no id could never be answered. Showing it would pin an
  // undismissable dialog over the pane, which is worse than not showing it.
  it("refuses a request with no usable id", () => {
    expect(
      registerExternalApproval({
        agentId: "a",
        chatSessionId: "chat-1",
        event: event({ id: "", requestId: undefined }),
      })
    ).toBeNull()
  })

  it("carries the title and description the dialog reads", () => {
    const approval = registerExternalApproval({
      agentId: "a",
      chatSessionId: "chat-1",
      event: event({ title: "Run git status?" }),
    })
    expect(approval?.title).toBe("Run git status?")
    expect(approval?.description).toBe("Run a command")
  })

  it("falls back to the reason when the tool carries no description", () => {
    const approval = registerExternalApproval({
      agentId: "a",
      chatSessionId: "chat-1",
      event: event({
        toolInfo: { id: "t", name: "write" },
        reason: "writes outside the workspace",
      }),
    })
    expect(approval?.description).toBe("writes outside the workspace")
  })
})

describe("pickPermissionOptionId", () => {
  it("maps each decision onto the agent's own option ids", () => {
    expect(pickPermissionOptionId("allow", OPTIONS)).toBe("o-allow-once")
    expect(pickPermissionOptionId("allow_always", OPTIONS)).toBe("o-allow-always")
    expect(pickPermissionOptionId("deny", OPTIONS)).toBe("o-reject-once")
  })

  it("prefers an allow the agent marked as its default", () => {
    const withDefault: AcpPermissionOption[] = [
      { optionId: "o1", name: "Allow once", kind: "allow_once" },
      { optionId: "o2", name: "Always", kind: "allow_always", isDefault: true },
    ]
    expect(pickPermissionOptionId("allow", withDefault)).toBe("o2")
  })

  // Losing the "always" nuance is better than losing the approval: the user
  // asked to proceed.
  it("degrades allow_always to allow_once rather than sending nothing", () => {
    const onlyOnce: AcpPermissionOption[] = [
      { optionId: "o1", name: "Allow once", kind: "allow_once" },
    ]
    expect(pickPermissionOptionId("allow_always", onlyOnce)).toBe("o1")
  })

  it("returns undefined when the agent advertises no options", () => {
    expect(pickPermissionOptionId("allow", undefined)).toBeUndefined()
    expect(pickPermissionOptionId("allow", [])).toBeUndefined()
  })

  it("falls back to reject_always when reject_once is not offered", () => {
    const rejectAlwaysOnly: AcpPermissionOption[] = [
      { optionId: "ra", name: "Never", kind: "reject_always" },
    ]
    expect(pickPermissionOptionId("deny", rejectAlwaysOnly)).toBe("ra")
  })
})

describe("toPermissionResponse", () => {
  const target = {
    agentId: "a",
    externalSessionId: "s",
    responseRequestId: "req-1",
    chatSessionId: "chat-1",
    options: OPTIONS,
  }

  it("grants on allow and refuses on deny", () => {
    expect(toPermissionResponse("allow", target)).toMatchObject({
      requestId: "req-1",
      granted: true,
      optionId: "o-allow-once",
    })
    expect(toPermissionResponse("deny", target)).toMatchObject({
      granted: false,
      optionId: "o-reject-once",
    })
  })

  // The sidecar ruleset an `allow_always` would normally write is invisible to
  // an external agent, so the remembered choice has to travel in the agent's
  // own protocol or it is silently discarded.
  it("expresses allow_always in the protocol rather than in sidecar rules", () => {
    expect(toPermissionResponse("allow_always", target)).toMatchObject({
      granted: true,
      rememberChoice: true,
      scope: "session",
      optionId: "o-allow-always",
    })
  })

  it("does not mark a plain allow as remembered", () => {
    const response = toPermissionResponse("allow", target)
    expect(response.rememberChoice).toBeUndefined()
    expect(response.scope).toBeUndefined()
  })
})

describe("resolveExternalApproval", () => {
  it("answers the agent and forgets the entry", async () => {
    const approval = registerExternalApproval({
      agentId: "agent-a",
      chatSessionId: "chat-1",
      event: event(),
    })!
    const respond = jest.fn(async () => undefined)

    await expect(resolveExternalApproval(approval.requestId, "allow", respond)).resolves.toBe(true)
    expect(respond).toHaveBeenCalledWith(
      "agent-a",
      "ext-session",
      expect.objectContaining({ requestId: "req-1", granted: true })
    )
    expect(getExternalApprovalTarget(approval.requestId)).toBeUndefined()
  })

  it("reports an unknown id instead of pretending it answered", async () => {
    const respond = jest.fn(async () => undefined)
    await expect(resolveExternalApproval("external-agent:a:gone", "allow", respond)).resolves.toBe(
      false
    )
    expect(respond).not.toHaveBeenCalled()
  })

  // A failed dispatch must leave the entry registered so the operator can
  // retry; dropping it would strand the agent with a dialog the user already
  // dismissed.
  it("keeps the entry when the agent rejects the answer", async () => {
    const approval = registerExternalApproval({
      agentId: "a",
      chatSessionId: "chat-1",
      event: event(),
    })!
    const respond = jest.fn(async () => {
      throw new Error("adapter gone")
    })
    await expect(resolveExternalApproval(approval.requestId, "allow", respond)).rejects.toThrow(
      "adapter gone"
    )
    expect(getExternalApprovalTarget(approval.requestId)).toBeDefined()
  })
})

describe("releaseExternalApprovals", () => {
  it("drops only the named chat session's entries and reports them", () => {
    const a = registerExternalApproval({
      agentId: "a",
      chatSessionId: "chat-1",
      event: event({ id: "r1" }),
    })!
    const b = registerExternalApproval({
      agentId: "a",
      chatSessionId: "chat-2",
      event: event({ id: "r2" }),
    })!

    expect(releaseExternalApprovals("chat-1")).toEqual([a.requestId])
    expect(getExternalApprovalTarget(a.requestId)).toBeUndefined()
    expect(getExternalApprovalTarget(b.requestId)).toBeDefined()
  })

  it("is safe on a session with nothing pending", () => {
    expect(releaseExternalApprovals("chat-none")).toEqual([])
  })
})

describe("registerExternalElicitation", () => {
  const elicitation = (
    id: string,
    overrides: Partial<AcpElicitationRequest> = {}
  ): ExternalAgentElicitationRequestEvent =>
    ({
      type: "elicitation_request",
      timestamp: new Date(),
      sessionId: "ext-session",
      request: { id, mode: "form", message: "Proceed?", raw: {}, ...overrides },
    }) as ExternalAgentElicitationRequestEvent

  it("carries the agent id the answer must be addressed to", () => {
    const pending = registerExternalElicitation({
      agentId: "agent-a",
      chatSessionId: "chat-1",
      event: elicitation("q1"),
    })
    expect(pending).toEqual({
      chatSessionId: "chat-1",
      agentId: "agent-a",
      request: expect.objectContaining({ id: "q1" }),
    })
  })

  // A question with no id could never be answered — `respondToElicitation`
  // correlates purely by requestId — so surfacing it would pin a dialog the
  // agent can never be told about.
  it("refuses a question with no id", () => {
    expect(
      registerExternalElicitation({
        agentId: "a",
        chatSessionId: "chat-1",
        event: elicitation(""),
      })
    ).toBeNull()
  })

  it("routes by agent alone — no session id travels with the answer", async () => {
    const pending = registerExternalElicitation({
      agentId: "agent-a",
      chatSessionId: "chat-1",
      event: elicitation("q1"),
    })!
    const respond = jest.fn(async () => undefined)
    await resolveExternalElicitation(
      pending,
      { requestId: "q1", action: "accept", content: { ok: true } },
      respond
    )
    expect(respond).toHaveBeenCalledWith("agent-a", {
      requestId: "q1",
      action: "accept",
      content: { ok: true },
    })
  })
})

describe("elicitationCancelResponse", () => {
  // The agent reads `decline` as a deliberate "no" and `cancel` as "the user
  // walked away". A turn that ended with the question still on screen is the
  // second thing; sending decline would put words in the user's mouth.
  it("cancels rather than declines a stranded question", () => {
    expect(
      elicitationCancelResponse({
        chatSessionId: "chat-1",
        agentId: "a",
        request: { id: "q1", mode: "form", message: "?", raw: {} },
      })
    ).toEqual({ requestId: "q1", action: "cancel" })
  })
})
