/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

// The composer module pulls in the whole chat stack; only the append bridge
// matters here.
const dispatchComposerAppendMock = jest.fn()
jest.mock("@/components/chat/composer", () => ({
  __esModule: true,
  dispatchComposerAppend: (detail: unknown) => dispatchComposerAppendMock(detail),
}))

jest.mock("@/lib/execution/chat-lease", () => ({
  isChatTurnQueued: jest.fn(() => false),
  cancelQueuedChatTurn: jest.fn(() => true),
}))

jest.mock("@/hooks/chat/chat-send-bridge", () => ({
  retryChatTurn: jest.fn(() => true),
}))

import { TurnAdmissionBadge } from "./turn-admission-badge"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"
import { cancelQueuedChatTurn, isChatTurnQueued } from "@/lib/execution/chat-lease"
import { retryChatTurn } from "@/hooks/chat/chat-send-bridge"
import type { TurnAdmissionMeta } from "@/lib/chat/turn-admission"

const isQueuedMock = isChatTurnQueued as jest.Mock
const cancelMock = cancelQueuedChatTurn as jest.Mock
const retryMock = retryChatTurn as jest.Mock

const SID = "s1"

function userMessage(id: string, turnAdmission?: TurnAdmissionMeta, text = "run the tests") {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    ...(turnAdmission ? { metadata: { turnAdmission } } : {}),
  } as unknown as UIMessage
}

function seed(messages: UIMessage[], slice: Partial<SessionChatSlice> = {}) {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: { [SID]: { ...makeSessionSlice(), messages, ...slice } },
  })
}

const queued: TurnAdmissionMeta = {
  state: "queued",
  waitingFor: { reason: "slot", holderKind: "workflow-step", holderLabel: "Ship the refactor" },
  since: 1,
}
const failed: TurnAdmissionMeta = {
  state: "failed",
  code: "initializationFailed",
  detail: "Pi process exited (code 1) before the Cognia extension was ready",
  at: 2,
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: {} })
  dispatchComposerAppendMock.mockClear()
  isQueuedMock.mockReset().mockReturnValue(false)
  cancelMock.mockClear()
  retryMock.mockClear()
})

describe("TurnAdmissionBadge", () => {
  it("renders nothing for a turn that ran normally", () => {
    const plain = userMessage("u1")
    seed([plain])
    const { container } = render(<TurnAdmissionBadge message={plain} sessionId={SID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a waiting turn as queued and names what holds the working copy", () => {
    isQueuedMock.mockReturnValue(true)
    const message = userMessage("u1", queued)
    seed([message])
    render(<TurnAdmissionBadge message={message} sessionId={SID} />)
    expect(screen.getByTestId("turn-admission-badge")).toHaveAttribute("data-state", "queued")
    expect(screen.getByTestId("turn-admission-text")).toHaveTextContent(
      "Queued — waiting for a plan or workflow step “Ship the refactor” to finish in this working copy"
    )
    // No retry for a turn that is still going to run.
    expect(screen.queryByTestId("turn-admission-retry")).not.toBeInTheDocument()
  })

  it("withdraws a queued turn, putting the text back in the composer first", () => {
    isQueuedMock.mockReturnValue(true)
    const message = userMessage("u1", queued, "refactor the parser")
    seed([message])
    render(<TurnAdmissionBadge message={message} sessionId={SID} />)
    fireEvent.click(screen.getByTestId("turn-admission-cancel"))
    expect(dispatchComposerAppendMock).toHaveBeenCalledWith({
      text: "refactor the parser",
      sessionId: SID,
    })
    expect(cancelMock).toHaveBeenCalledWith(SID)
    expect(dispatchComposerAppendMock.mock.invocationCallOrder[0]).toBeLessThan(
      cancelMock.mock.invocationCallOrder[0]
    )
  })

  it("says a wait the app did not survive never ran, and offers a retry", () => {
    const message = userMessage("u1", queued)
    seed([message])
    render(<TurnAdmissionBadge message={message} sessionId={SID} />)
    expect(screen.getByTestId("turn-admission-badge")).toHaveAttribute("data-state", "interrupted")
    expect(screen.getByTestId("turn-admission-text")).toHaveTextContent(
      "Not sent — the app closed while this message was waiting"
    )
    fireEvent.click(screen.getByTestId("turn-admission-retry"))
    expect(retryMock).toHaveBeenCalledWith(SID)
  })

  it("marks a turn that failed to start with the localized reason, hint and raw detail", () => {
    const message = userMessage("u1", failed)
    seed([message])
    render(<TurnAdmissionBadge message={message} sessionId={SID} />)
    const text = screen.getByTestId("turn-admission-text")
    expect(text).toHaveTextContent("Didn't run — Agent failed to start")
    expect(text.getAttribute("title")).toContain("never completed its handshake")
    expect(text.getAttribute("title")).toContain(
      "Details: Pi process exited (code 1) before the Cognia extension was ready"
    )
    expect(screen.getByTestId("turn-admission-retry")).toBeInTheDocument()
  })

  it("names a held agent process as a conflict, not a start-up fault", () => {
    const message = userMessage("u1", { ...failed, code: "agentProcessBusy" })
    seed([message])
    render(<TurnAdmissionBadge message={message} sessionId={SID} />)
    expect(screen.getByTestId("turn-admission-text")).toHaveTextContent(
      "Didn't run — Agent already running"
    )
  })

  it("only offers Retry on the last user turn while the session is idle", () => {
    const older = userMessage("u1", failed)
    const newer = userMessage("u2")
    seed([older, newer])
    const { unmount } = render(<TurnAdmissionBadge message={older} sessionId={SID} />)
    expect(screen.queryByTestId("turn-admission-retry")).not.toBeInTheDocument()
    unmount()
    seed([older], { status: "streaming" })
    render(<TurnAdmissionBadge message={older} sessionId={SID} />)
    expect(screen.queryByTestId("turn-admission-retry")).not.toBeInTheDocument()
  })
})
