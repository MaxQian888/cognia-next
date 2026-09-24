/** @jest-environment jsdom */

import type { PendingApproval } from "@cognia/agent-config-types"

import type { ExternalAgentEvent, ExternalAgentSession } from "@/types/agent/external-agent"
import type { ExternalAgentLifecycleEvent } from "@/lib/ai/agent/external/manager"
import type { PendingExternalElicitation } from "@/stores/agent/external-elicitation-store"

/* -- Manager + store seams ------------------------------------------------- */

const eventListeners = new Map<string, (event: ExternalAgentEvent) => void>()
let lifecycleListener: ((event: ExternalAgentLifecycleEvent) => void) | undefined

const managerMock = {
  addEventListener: jest.fn((agentId: string, listener: (event: ExternalAgentEvent) => void) => {
    eventListeners.set(agentId, listener)
    return () => {
      eventListeners.delete(agentId)
    }
  }),
  addLifecycleListener: jest.fn((listener: (event: ExternalAgentLifecycleEvent) => void) => {
    lifecycleListener = listener
    return () => {
      lifecycleListener = undefined
    }
  }),
  liveSessions: jest.fn((_agentId: string): ExternalAgentSession[] => []),
  getSession: jest.fn(
    (_agentId: string, _sessionId: string): ExternalAgentSession | undefined => undefined
  ),
  respondToPermission: jest.fn(async () => {}),
  respondToElicitation: jest.fn(async () => {}),
  cancel: jest.fn(async () => {}),
  executeStreaming: jest.fn(),
}

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => managerMock,
}))

const mockAgentsState: { agents: Record<string, Record<string, unknown>> } = { agents: {} }
const agentStoreSubs = new Set<() => void>()

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: {
    getState: () => mockAgentsState,
    subscribe: (listener: () => void) => {
      agentStoreSubs.add(listener)
      return () => {
        agentStoreSubs.delete(listener)
      }
    },
  },
}))

const mockChatState: {
  sessions: Record<string, { pendingApprovals: PendingApproval[] }>
  pendingApprovals: PendingApproval[]
  clearApproval: jest.Mock
  setActiveSession: jest.Mock
} = {
  sessions: {},
  pendingApprovals: [],
  clearApproval: jest.fn(),
  setActiveSession: jest.fn(),
}

jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => mockChatState },
}))

const elicitationStoreSubs = new Set<() => void>()
const mockElicitationState: {
  bySession: Record<string, PendingExternalElicitation[]>
  remove: jest.Mock
} = {
  bySession: {},
  remove: jest.fn((chatSessionId: string, requestId: string) => {
    const current = mockElicitationState.bySession[chatSessionId]
    if (current) {
      mockElicitationState.bySession[chatSessionId] = current.filter(
        (entry) => entry.request.id !== requestId && entry.request.elicitationId !== requestId
      )
    }
    elicitationStoreSubs.forEach((listener) => listener())
  }),
}

jest.mock("@/stores/agent/external-elicitation-store", () => ({
  useExternalElicitationStore: {
    getState: () => mockElicitationState,
    subscribe: (listener: () => void) => {
      elicitationStoreSubs.add(listener)
      return () => {
        elicitationStoreSubs.delete(listener)
      }
    },
  },
}))

const mockResolveRemotePermission = jest.fn(async (..._args: unknown[]) => ({
  resolved: true as const,
}))
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-run-client", () => ({
  resolveRemotePermission: (...args: unknown[]) => mockResolveRemotePermission(...args),
  resolveRemoteElicitation: jest.fn(async () => ({ resolved: true })),
}))

const mockRecordChatToolApprovalDecision = jest.fn(async (..._args: unknown[]) => {})
jest.mock("@/lib/policy/action-review/chat-tool-channel", () => ({
  recordChatToolApprovalDecision: (...args: unknown[]) =>
    mockRecordChatToolApprovalDecision(...args),
}))

import {
  __resetExternalApprovalsForTests,
  registerExternalApproval,
} from "@/lib/ai/agent/external/session/chat-decision-bridge"
import { CANONICAL_SESSION_LINGER_MS } from "./canonical-projection"
import { acpSessionOwnerFacts } from "./acp-session-registry"
import {
  acpFleetAgentOf,
  acpFleetProjection,
  interruptAcpFleetSession,
  rejectAcpFleetQuestion,
  respondAcpFleetPermission,
  respondAcpFleetQuestion,
  sendAcpFleetMessage,
} from "./acp-fleet-projection"

/* -- Fixtures --------------------------------------------------------------- */

function agentConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent-1",
    name: "Devin",
    protocol: "acp",
    enabled: true,
    metadata: { preset: "devin" },
    process: { command: "devin" },
    ...over,
  }
}

function externalSession(over: Partial<ExternalAgentSession> = {}): ExternalAgentSession {
  return {
    id: "s1",
    agentId: "agent-1",
    status: "active",
    createdAt: new Date(1_000),
    lastActivityAt: new Date(2_000),
    ...over,
  }
}

function ev(
  type: string,
  fields: Record<string, unknown> = {},
  sessionId = "s1"
): ExternalAgentEvent {
  return { type, sessionId, timestamp: new Date(0), ...fields } as unknown as ExternalAgentEvent
}

function emit(agentId: string, event: ExternalAgentEvent): void {
  eventListeners.get(agentId)?.(event)
}

async function attach(): Promise<void> {
  acpFleetProjection.attach()
  // `attach` resolves the manager behind a dynamic import, then seeds.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const AGENT = "agent-1"

beforeEach(() => {
  acpFleetProjection.resetForTests()
  __resetExternalApprovalsForTests()
  eventListeners.clear()
  lifecycleListener = undefined
  agentStoreSubs.clear()
  mockAgentsState.agents = {}
  mockChatState.sessions = {}
  mockChatState.pendingApprovals = []
  mockChatState.clearApproval.mockReset()
  mockChatState.setActiveSession.mockReset()
  mockElicitationState.bySession = {}
  // `mockClear` keeps the implementation: `remove` must still fire subscribers.
  mockElicitationState.remove.mockClear()
  elicitationStoreSubs.clear()
  jest.clearAllMocks()
  // `clearAllMocks` keeps implementations — reset the ones tests mutate.
  managerMock.liveSessions.mockReset().mockReturnValue([])
  managerMock.getSession.mockReset().mockReturnValue(undefined)
  managerMock.respondToPermission.mockReset().mockResolvedValue(undefined)
  managerMock.respondToElicitation.mockReset().mockResolvedValue(undefined)
  managerMock.cancel.mockReset().mockResolvedValue(undefined)
  managerMock.executeStreaming.mockReset()
})

afterEach(() => {
  acpFleetProjection.resetForTests()
})

/* -- Identity --------------------------------------------------------------- */

describe("acpFleetAgentOf", () => {
  it("maps the devin preset and a hand-pointed devin binary to the devin identity", () => {
    expect(acpFleetAgentOf({ metadata: { preset: "devin" } })).toBe("devin")
    expect(acpFleetAgentOf({ process: { command: "/usr/local/bin/devin" } })).toBe("devin")
    expect(acpFleetAgentOf({ process: { command: "devin.exe" } })).toBe("devin")
  })

  it("folds the named presets onto their hook-observed identities", () => {
    expect(acpFleetAgentOf({ metadata: { preset: "claude-code" } })).toBe("claude-code")
    expect(acpFleetAgentOf({ metadata: { preset: "codex" } })).toBe("codex")
    expect(acpFleetAgentOf({ metadata: { preset: "codex-acp" } })).toBe("codex")
    expect(acpFleetAgentOf({ metadata: { preset: "opencode-acp" } })).toBe("opencode")
  })

  it("falls back to the generic acp identity for everything else", () => {
    expect(acpFleetAgentOf({ metadata: { preset: "kiro" } })).toBe("acp")
    expect(acpFleetAgentOf({})).toBe("acp")
  })
})

/* -- Attach + projection ----------------------------------------------------- */

describe("acpFleetProjection", () => {
  it("seeds live sessions with owner facts and the configured label", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    managerMock.liveSessions.mockReturnValue([
      externalSession({
        id: "s1",
        status: "executing",
        metadata: { cwd: "/repo/app", cogniaSessionId: "chat-9" },
      }),
    ])

    await attach()

    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row).toMatchObject({
      agent: "devin",
      status: "working",
      sessionId: "s1",
      externalAgentId: AGENT,
      agentLabel: "Devin",
      chatSessionId: "chat-9",
      cwd: "/repo/app",
      projectName: "app",
    })
    expect(acpSessionOwnerFacts("s1")).toMatchObject({
      agent: "devin",
      agentId: AGENT,
      chatSessionId: "chat-9",
    })
  })

  it("attaches newly configured ACP agents while ignoring non-ACP ones", async () => {
    await attach()
    expect(managerMock.addEventListener).not.toHaveBeenCalled()

    mockAgentsState.agents = {
      [AGENT]: agentConfig(),
      other: agentConfig({ id: "other", protocol: "a2a", name: "A2A" }),
      off: agentConfig({ id: "off", enabled: false, name: "Off" }),
    }
    agentStoreSubs.forEach((listener) => listener())

    expect(managerMock.addEventListener).toHaveBeenCalledTimes(1)
    expect(managerMock.addEventListener).toHaveBeenCalledWith(AGENT, expect.any(Function))
  })

  it("folds the event stream into status, counters and liveness", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()

    emit(AGENT, ev("session_start"))
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).toBe("working")

    emit(AGENT, ev("message_start", { role: "user" }))
    emit(AGENT, ev("tool_use_start", { toolUseId: "t1", toolName: "Bash" }))
    const working = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(working).toMatchObject({
      status: "working",
      turnCount: 1,
      toolUseCount: 1,
      activity: { toolName: "Bash", detail: null },
    })

    emit(AGENT, ev("done"))
    expect(acpFleetProjection.getSnapshot().get("devin:s1")).toMatchObject({
      status: "idle",
      activity: null,
    })
  })

  it("ends every row for an agent whose adapter dropped", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(AGENT, ev("session_start"))
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).toBe("working")

    lifecycleListener?.({
      agentId: AGENT,
      connectionStatus: "disconnected",
      status: "idle",
      timestamp: new Date(0),
    } as ExternalAgentLifecycleEvent)

    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).toBe("ended")
  })

  it("lingers an ended session, then sweeps it", async () => {
    jest.useFakeTimers()
    try {
      mockAgentsState.agents = { [AGENT]: agentConfig() }
      await attach()
      emit(AGENT, ev("session_start"))
      emit(AGENT, ev("session_end", { reason: "completed" }))

      expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).toBe("ended")
      jest.advanceTimersByTime(CANONICAL_SESSION_LINGER_MS + 200)
      expect(acpFleetProjection.getSnapshot().get("devin:s1")).toBeUndefined()
      expect(acpSessionOwnerFacts("s1")).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it("detaches an agent whose config is removed and ends its rows", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(AGENT, ev("session_start"))
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).toBe("working")

    mockAgentsState.agents = {}
    agentStoreSubs.forEach((listener) => listener())

    expect(eventListeners.has(AGENT)).toBe(false)
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).toBe("ended")
  })

  it.each(["permission_response", "elicitation_complete", "session_end"])(
    "does not create a phantom row for a %s event on an unknown session",
    async (type) => {
      mockAgentsState.agents = { [AGENT]: agentConfig() }
      await attach()
      emit(
        AGENT,
        ev(type, {
          elicitationId: "e9",
          response: { requestId: "r9", granted: true },
          reason: "completed",
        })
      )
      expect(acpFleetProjection.getSnapshot().get("devin:s1")).toBeUndefined()
    }
  )
})

/* -- Permissions -------------------------------------------------------------- */

describe("respondAcpFleetPermission", () => {
  async function attachedWithPermission(): Promise<string> {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(
      AGENT,
      ev("permission_request", {
        request: {
          id: "r1",
          requestId: "r1",
          sessionId: "s1",
          toolCallId: "t1",
          toolInfo: { name: "Bash" },
          title: "Run ls",
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow" },
            { optionId: "reject_once", kind: "reject_once", name: "Reject" },
          ],
        },
      })
    )
    return "external-agent:agent-1:r1"
  }

  it("exposes the ask on the row and routes the answer through the bridge", async () => {
    const requestId = await attachedWithPermission()
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.status).toBe("waiting-permission")
    expect(row?.pendingPermission).toMatchObject({ requestId, toolName: "Bash" })

    expect(await respondAcpFleetPermission(requestId, "allow")).toBe(true)
    expect(managerMock.respondToPermission).toHaveBeenCalledWith(
      AGENT,
      "s1",
      expect.objectContaining({ requestId: "r1", granted: true, optionId: "allow_once" })
    )
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.pendingPermission).toBeNull()
  })

  it("clears the chat approval through the chat channel when a card exists", async () => {
    const requestId = await attachedWithPermission()
    registerExternalApproval({
      agentId: AGENT,
      chatSessionId: "chat-9",
      event: ev("permission_request", {
        sessionId: "s1",
        request: {
          id: "r1",
          requestId: "r1",
          sessionId: "s1",
          toolCallId: "t1",
          toolInfo: { name: "Bash" },
          options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow" }],
        },
      }) as Parameters<typeof registerExternalApproval>[0]["event"],
    })
    const approval = {
      sessionId: "chat-9",
      requestId,
      toolUseID: "t1",
      toolName: "Bash",
      input: {},
      status: "pending",
    } as PendingApproval
    mockChatState.pendingApprovals = [approval]

    expect(await respondAcpFleetPermission(requestId, "deny")).toBe(true)
    expect(managerMock.respondToPermission).toHaveBeenCalledWith(
      AGENT,
      "s1",
      expect.objectContaining({ requestId: "r1", granted: false })
    )
    expect(mockRecordChatToolApprovalDecision).toHaveBeenCalledWith(approval, "deny")
    expect(mockChatState.clearApproval).toHaveBeenCalledWith(requestId, "chat-9")
  })

  it("resolves a host-side decision remotely rather than through the local adapter", async () => {
    const requestId = await attachedWithPermission()
    registerExternalApproval({
      agentId: AGENT,
      chatSessionId: "chat-9",
      remoteDecisionId: "remote-7",
      event: ev("permission_request", {
        sessionId: "s1",
        request: {
          id: "r1",
          requestId: "r1",
          sessionId: "s1",
          toolCallId: "t1",
          toolInfo: { name: "Bash" },
        },
      }) as Parameters<typeof registerExternalApproval>[0]["event"],
    })

    expect(await respondAcpFleetPermission(requestId, "allow")).toBe(true)
    expect(mockResolveRemotePermission).toHaveBeenCalledWith("remote-7", "allow")
    expect(managerMock.respondToPermission).not.toHaveBeenCalled()
  })

  it("refuses an unknown or non-permission request id", async () => {
    expect(await respondAcpFleetPermission("external-agent:agent-1:nope", "allow")).toBe(false)
  })
})

/* -- Questions --------------------------------------------------------------- */

describe("respondAcpFleetQuestion / rejectAcpFleetQuestion", () => {
  async function attachWithForm(): Promise<string> {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(
      AGENT,
      ev("elicitation_request", {
        request: {
          id: "e1",
          mode: "form",
          message: "Pick a lane",
          sessionId: "s1",
          requestedSchema: {
            properties: {
              lane: {
                type: "string",
                title: "Lane",
                oneOf: [
                  { const: "fast", title: "Fast" },
                  { const: "safe", title: "Safe" },
                ],
              },
            },
            required: ["lane"],
          },
          raw: {},
        },
      })
    )
    return "external-elicitation:agent-1:e1"
  }

  it("maps a schema-bound elicitation into the options-only question model", async () => {
    const requestId = await attachWithForm()
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.status).toBe("waiting-input")
    expect(row?.pendingQuestionRequest?.requestId).toBe(requestId)
    // Single-field form: the agent's message becomes the question, the
    // property title becomes the header.
    expect(row?.pendingQuestions).toEqual([
      { question: "Pick a lane", header: "Lane", options: ["Fast", "Safe"], multiSelect: false },
    ])
  })

  it("answers an elicitation with content keyed by the schema property", async () => {
    const requestId = await attachWithForm()
    expect(await respondAcpFleetQuestion(requestId, [[1]])).toBe(true)
    expect(managerMock.respondToElicitation).toHaveBeenCalledWith(AGENT, {
      requestId: "e1",
      action: "accept",
      content: { lane: "safe" },
    })
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).not.toBe("waiting-input")
  })

  it("declines an elicitation on the question-reject path", async () => {
    const requestId = await attachWithForm()
    expect(await rejectAcpFleetQuestion(requestId)).toBe(true)
    expect(managerMock.respondToElicitation).toHaveBeenCalledWith(AGENT, {
      requestId: "e1",
      action: "decline",
    })
  })

  it("refuses an answer that skips a required property", async () => {
    const requestId = await attachWithForm()
    expect(await respondAcpFleetQuestion(requestId, [[]])).toBe(false)
    expect(managerMock.respondToElicitation).not.toHaveBeenCalled()
  })

  it("blocks the row without answer controls for an elicitation it cannot map", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(
      AGENT,
      ev("elicitation_request", {
        request: { id: "e2", mode: "url", message: "Open https://x", sessionId: "s1", raw: {} },
      })
    )
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.status).toBe("waiting-input")
    // No answerable handle: the projection renders decideInMain, not a dead control.
    expect(row?.pendingQuestionRequest).toBeNull()
    expect(row?.pendingQuestions).toEqual([
      { question: "Open https://x", options: [], multiSelect: false },
    ])
  })

  it("answers a blocking async question with the wire answers map", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(AGENT, ev("session_start"))
    emit(
      AGENT,
      ev("async_questions", {
        requestId: "aq1",
        questions: [{ id: "q1", title: "Which?", options: ["x", "y"] }],
      })
    )
    const requestId = "external-agent:agent-1:aq1"
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.pendingQuestionRequest?.requestId).toBe(requestId)
    // Async questions ride the turn instead of blocking it.
    expect(row?.status).toBe("working")

    expect(await respondAcpFleetQuestion(requestId, [[1]])).toBe(true)
    expect(managerMock.respondToPermission).toHaveBeenCalledWith(AGENT, "s1", {
      requestId: "aq1",
      granted: true,
      answers: { q1: ["y"] },
    })
  })

  it("drops a question the agent withdraws before anyone answers", async () => {
    const requestId = await attachWithForm()
    emit(AGENT, ev("elicitation_complete", { elicitationId: "e1" }))
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.pendingQuestionRequest).toBeNull()
    expect(row?.pendingQuestions).toEqual([])
    expect(await respondAcpFleetQuestion(requestId, [[0]])).toBe(false)
  })

  it("clears an unmappable elicitation when it completes elsewhere", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(
      AGENT,
      ev("elicitation_request", {
        request: {
          id: "e2",
          elicitationId: "wire-e2",
          mode: "url",
          message: "Open https://x",
          sessionId: "s1",
          raw: {},
        },
      })
    )
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.status).toBe("waiting-input")

    // The user finished the flow on the agent's own surface; the wire id is
    // all `elicitation_complete` carries.
    emit(AGENT, ev("elicitation_complete", { elicitationId: "wire-e2" }))
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.status).not.toBe("waiting-input")
    expect(row?.pendingQuestions).toEqual([])
  })

  it("clears a form elicitation the chat pane answered", async () => {
    const requestId = await attachWithForm()
    mockElicitationState.bySession = {
      "chat-9": [
        {
          chatSessionId: "chat-9",
          agentId: AGENT,
          request: {
            id: "e1",
            mode: "form",
            message: "Pick a lane",
            sessionId: "s1",
            raw: {},
          },
        },
      ],
    }
    // The chat session registered the entry when the request arrived (the
    // real store's push fires subscribers, marking the id as seen).
    elicitationStoreSubs.forEach((listener) => listener())
    // The pane answered the dialog — its store entry disappears and the row
    // must follow, because the adapter emits nothing for a settled form.
    mockElicitationState.remove("chat-9", "e1")

    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.status).not.toBe("waiting-input")
    expect(row?.pendingQuestionRequest).toBeNull()
    expect(await respondAcpFleetQuestion(requestId, [[0]])).toBe(false)
  })

  it("maps a blocking requestUserInput ask to questions, not approve/deny", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(AGENT, ev("session_start"))
    emit(
      AGENT,
      ev("permission_request", {
        request: {
          id: "u1",
          requestId: "u1",
          sessionId: "s1",
          title: "Pick a region",
          toolInfo: { name: "request_user_input" },
          metadata: {
            codexUserInput: {
              requestId: "u1",
              questions: [
                {
                  id: "region",
                  header: "Region",
                  question: "Which region?",
                  options: [{ label: "us" }, { label: "eu" }],
                },
              ],
            },
          },
        },
      })
    )
    const requestId = "external-agent:agent-1:u1"
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.status).toBe("waiting-input")
    expect(row?.pendingPermission).toBeNull()
    expect(row?.pendingQuestionRequest?.requestId).toBe(requestId)
    expect(row?.pendingQuestions).toEqual([
      { question: "Region", options: ["us", "eu"], multiSelect: false },
    ])

    expect(await respondAcpFleetQuestion(requestId, [[1]])).toBe(true)
    expect(managerMock.respondToPermission).toHaveBeenCalledWith(AGENT, "s1", {
      requestId: "u1",
      granted: true,
      answers: { region: ["eu"] },
    })
  })

  it("clears a question settled through the adapter's own response event", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(AGENT, ev("session_start"))
    emit(
      AGENT,
      ev("async_questions", {
        requestId: "aq1",
        questions: [{ id: "q1", title: "Which?", options: ["x", "y"] }],
      })
    )
    const requestId = "external-agent:agent-1:aq1"
    expect(
      acpFleetProjection.getSnapshot().get("devin:s1")?.pendingQuestionRequest?.requestId
    ).toBe(requestId)

    // Answered on another surface — the adapter resolves the waiter and emits
    // the response, which must retire the row's controls too.
    emit(
      AGENT,
      ev("permission_response", {
        response: { requestId: "aq1", granted: true },
      })
    )
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(row?.pendingQuestionRequest).toBeNull()
    expect(row?.pendingQuestions).toEqual([])
    expect(await respondAcpFleetQuestion(requestId, [[0]])).toBe(false)
  })

  it("shows an unanswerable user-input ask and settles it on the response event", async () => {
    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    emit(
      AGENT,
      ev("permission_request", {
        request: {
          id: "u2",
          requestId: "u2",
          sessionId: "s1",
          title: "Describe the goal",
          toolInfo: { name: "request_user_input" },
          metadata: {
            codexUserInput: {
              requestId: "u2",
              questions: [{ id: "goal", question: "Describe the goal" }],
            },
          },
        },
      })
    )
    const row = acpFleetProjection.getSnapshot().get("devin:s1")
    // Free text has no options-only mapping: blocked, no dead controls.
    expect(row?.status).toBe("waiting-input")
    expect(row?.pendingPermission).toBeNull()
    expect(row?.pendingQuestionRequest).toBeNull()
    expect(row?.pendingQuestions).toEqual([
      { question: "Describe the goal", options: [], multiSelect: false },
    ])

    emit(
      AGENT,
      ev("permission_response", {
        response: { requestId: "u2", granted: true },
      })
    )
    const settled = acpFleetProjection.getSnapshot().get("devin:s1")
    expect(settled?.status).not.toBe("waiting-input")
    expect(settled?.pendingQuestions).toEqual([])
  })
})

/* -- Interrupt + send ---------------------------------------------------------- */

describe("interruptAcpFleetSession / sendAcpFleetMessage", () => {
  it("interrupts through the manager's cancel", async () => {
    await attach()
    expect(await interruptAcpFleetSession(AGENT, "s1")).toEqual({ ok: true })
    expect(managerMock.cancel).toHaveBeenCalledWith(AGENT, "s1")

    managerMock.cancel.mockRejectedValueOnce(new Error("gone"))
    expect(await interruptAcpFleetSession(AGENT, "s1")).toEqual({
      ok: false,
      reason: "callFailed",
    })
  })

  it("drives a turn on the existing session and drains it in the background", async () => {
    const seen: unknown[] = []
    managerMock.executeStreaming.mockImplementation(async function* () {
      yield ev("session_start")
      seen.push("first")
      yield ev("done")
      seen.push("second")
    })

    mockAgentsState.agents = { [AGENT]: agentConfig() }
    await attach()
    expect(await sendAcpFleetMessage(AGENT, "s1", "  keep going  ")).toBe(true)
    expect(managerMock.executeStreaming).toHaveBeenCalledWith(AGENT, "  keep going  ", {
      sessionId: "s1",
    })
    // The sent text becomes the row's prompt for the hover detail.
    expect(acpFleetProjection.getSnapshot().get("devin:s1")?.lastPrompt).toBe("keep going")
    // The remainder of the generator is consumed so manager listeners keep firing.
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(["first", "second"])
  })

  it("reports failure when the prompt cannot be opened", async () => {
    managerMock.executeStreaming.mockImplementation(async function* () {
      throw new Error("refused")
    })
    expect(await sendAcpFleetMessage(AGENT, "s1", "hi")).toBe(false)
  })
})
