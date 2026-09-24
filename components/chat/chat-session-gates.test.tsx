import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useChatStore } from "@/stores/chat"
import { useExternalElicitationStore } from "@/stores/agent/external-elicitation-store"
import { ChatSessionGates } from "./chat-session-gates"

const deliver = jest.fn<Promise<void>, unknown[]>(async () => undefined)
const hostApproval = jest.fn(async () => undefined)
const companionApproval = jest.fn(async () => undefined)
const companionShell = jest.fn(() => false)
const mockCancelSubagent = jest.fn<Promise<void>, unknown[]>(async () => undefined)
let mockApprovalResponse: (decision: string) => void
let mockElicitationResponse: (response: unknown) => Promise<void>
jest.mock("@/lib/claude/agents/cancel-subagent", () => ({
  cancelSubagentRun: (...args: unknown[]) => mockCancelSubagent(...args),
}))
jest.mock("@/lib/chat/room/runner-host", () => ({
  getHostRoomRunner: () => ({ respondToApproval: hostApproval }),
  getCompanionRoomProjector: () => ({ runner: { respondToApproval: companionApproval } }),
}))
jest.mock("@/lib/chat/room/shell", () => ({ isCompanionShell: () => companionShell() }))
jest.mock("@/lib/ai/agent/external/session/chat-decision-bridge", () => ({
  deliverExternalElicitation: (...args: unknown[]) => deliver(...args),
}))
jest.mock("./tool-approval-dialog", () => ({
  ToolApprovalDialog: ({
    approval,
    onRespond,
    onDismiss,
    onCancelRun,
  }: {
    approval: { toolName: string; status?: string } | null
    onRespond: (decision: string) => void
    onDismiss: () => void
    onCancelRun: (runId: string) => void
  }) => {
    mockApprovalResponse = onRespond
    return (
      approval && (
        <div role="dialog" aria-label={approval.toolName}>
          <button onClick={() => onCancelRun("run-1")}>Cancel run</button>
          {approval.status === "interrupted" ? (
            <button onClick={onDismiss}>Dismiss</button>
          ) : (
            <button onClick={() => onRespond("allow")}>Allow</button>
          )}
        </div>
      )
    )
  },
}))
jest.mock("@/components/agent/external-agent/elicitation-dialog", () => ({
  ExternalAgentElicitationDialog: ({
    request,
    onRespond,
  }: {
    request: { id: string; message: string } | null
    onRespond: (answer: unknown) => Promise<void>
  }) => {
    mockElicitationResponse = onRespond
    return (
      request && (
        <button
          onClick={() => {
            void onRespond({
              requestId: request.id,
              action: "accept",
              content: { ok: true },
            }).catch(() => undefined)
          }}
        >
          {request.message}
        </button>
      )
    )
  },
}))

beforeEach(() => {
  useChatStore.getState().clear()
  useExternalElicitationStore.setState({ bySession: {} })
  jest.clearAllMocks()
  companionShell.mockReturnValue(false)
  deliver.mockResolvedValue(undefined)
})

it("answers only the bound session's live tool request, ahead of interrupted requests", async () => {
  const respondToApproval = jest.fn(async () => undefined)
  useChatStore.getState().pushApproval({
    sessionId: "a",
    requestId: "old",
    toolUseID: "old-tool",
    toolName: "Old",
    input: {},
    status: "interrupted",
  })
  const ask = {
    sessionId: "a",
    requestId: "new",
    toolUseID: "new-tool",
    toolName: "Write",
    input: {},
  }
  useChatStore.getState().pushApproval(ask)
  useChatStore.getState().pushApproval({
    sessionId: "b",
    requestId: "other",
    toolUseID: "other-tool",
    toolName: "Delete",
    input: {},
  })
  render(<ChatSessionGates sessionId="a" respondToApproval={respondToApproval} />)
  expect(screen.getByRole("dialog", { name: "Write" })).toBeInTheDocument()
  expect(screen.queryByRole("dialog", { name: "Delete" })).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow" })))
  expect(respondToApproval).toHaveBeenCalledWith(expect.objectContaining(ask), "allow")
})

it("dismisses an interrupted request without answering it", () => {
  const respondToApproval = jest.fn()
  useChatStore.getState().pushApproval({
    sessionId: "a",
    requestId: "old",
    toolUseID: "old-tool",
    toolName: "Old",
    input: {},
    status: "interrupted",
  })
  render(<ChatSessionGates sessionId="a" respondToApproval={respondToApproval} />)
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(respondToApproval).not.toHaveBeenCalled()
})

it("delivers an elicitation strictly to the asking agent before removing it", async () => {
  const pending = {
    chatSessionId: "a",
    agentId: "agent-z",
    request: { id: "q1", mode: "form" as const, message: "Choose a value", raw: {} },
  }
  useExternalElicitationStore.getState().push(pending)
  render(<ChatSessionGates sessionId="a" respondToApproval={jest.fn()} />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose a value" })))
  expect(deliver).toHaveBeenCalledWith(
    pending,
    { requestId: "q1", action: "accept", content: { ok: true } },
    { strict: true }
  )
  expect(screen.queryByRole("button", { name: "Choose a value" })).toBeNull()
})

it("keeps an elicitation pending during delivery and after failure, then clears only after retry succeeds", async () => {
  const pending = {
    chatSessionId: "a",
    agentId: "agent-z",
    request: { id: "q1", mode: "form" as const, message: "Choose a value", raw: {} },
  }
  let fail!: (reason: unknown) => void
  deliver.mockReturnValueOnce(
    new Promise((_, reject) => {
      fail = reject
    })
  )
  useExternalElicitationStore.getState().push(pending)
  render(<ChatSessionGates sessionId="a" respondToApproval={jest.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: "Choose a value" }))
  await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  expect(useExternalElicitationStore.getState().bySession.a).toEqual([pending])
  await act(async () => fail(new Error("offline")))
  expect(screen.getByRole("button", { name: "Choose a value" })).toBeInTheDocument()
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose a value" })))
  expect(deliver).toHaveBeenCalledTimes(2)
  expect(useExternalElicitationStore.getState().bySession.a).toBeUndefined()
})

it.each([false, true])(
  "routes a team member sub-session approval through the room runner on companion=%s",
  async (companion) => {
    companionShell.mockReturnValue(companion)
    const respondToApproval = jest.fn(async () => undefined)
    const approval = {
      sessionId: "team::char::member::turn",
      requestId: "team-request",
      toolUseID: "team-tool",
      toolName: "Write",
      input: {},
    }
    useChatStore.getState().pushApproval(approval)
    render(<ChatSessionGates sessionId="team" respondToApproval={respondToApproval} />)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow" })))
    expect(companion ? companionApproval : hostApproval).toHaveBeenCalledWith(
      expect.objectContaining(approval),
      "allow"
    )
    expect(companion ? hostApproval : companionApproval).not.toHaveBeenCalled()
    expect(respondToApproval).not.toHaveBeenCalled()
  }
)

it("cancels the selected run through the shared cancellation path", async () => {
  useChatStore.getState().pushApproval({
    sessionId: "a",
    requestId: "r",
    toolUseID: "r-tool",
    toolName: "Write",
    input: {},
  })
  render(<ChatSessionGates sessionId="a" respondToApproval={jest.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: "Cancel run" }))
  await waitFor(() => expect(mockCancelSubagent).toHaveBeenCalledWith("run-1"))
})

it("ignores response callbacks when their request is no longer present", async () => {
  const response = jest.fn()
  render(<ChatSessionGates sessionId="empty" respondToApproval={response} />)
  await act(async () => {
    mockApprovalResponse("allow")
    await mockElicitationResponse({ requestId: "gone", action: "cancel" })
  })
  expect(response).not.toHaveBeenCalled()
  expect(deliver).not.toHaveBeenCalled()
})
