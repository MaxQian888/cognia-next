/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { UIMessage } from "ai"

// Identity i18n so assertions read as the key names.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The composer module pulls in the whole chat stack (Dexie, stores); only the
// append bridge matters here.
const dispatchComposerAppendMock = jest.fn()
jest.mock("@/components/chat/composer", () => ({
  __esModule: true,
  dispatchComposerAppend: (detail: unknown) => dispatchComposerAppendMock(detail),
}))

const persistMessagesMock = jest.fn(() => Promise.resolve())
jest.mock("@/lib/db/messages", () => ({
  persistMessages: (...args: unknown[]) => persistMessagesMock(...(args as [])),
}))

import { SteerStatusBadge } from "./steer-status-badge"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"

const SID = "s1"

function steerMessage(entryId: string, state: string, text = "use TypeScript"): UIMessage {
  return {
    id: `m-${entryId}`,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { steer: { entryId, state } },
  } as unknown as UIMessage
}

function seed(slice: Partial<SessionChatSlice>) {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: { [SID]: { ...makeSessionSlice(), ...slice } },
  })
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: {} })
  dispatchComposerAppendMock.mockClear()
  persistMessagesMock.mockClear()
})

describe("SteerStatusBadge", () => {
  it("renders nothing for an ordinary message", () => {
    seed({ status: "streaming" })
    const plain = { id: "m0", role: "user", parts: [] } as unknown as UIMessage
    const { container } = render(<SteerStatusBadge message={plain} sessionId={SID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the queued state while the turn is still running", () => {
    const msg = steerMessage("e1", "queued")
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "use TypeScript" }],
      messages: [msg],
    })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    expect(screen.getByTestId("steer-status-badge")).toHaveAttribute("data-state", "queued")
  })

  it("shows the delivered state for a live-accepted steer", () => {
    const msg = steerMessage("e1", "accepted")
    seed({ status: "streaming", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    expect(screen.getByTestId("steer-status-badge")).toHaveAttribute("data-state", "accepted")
  })

  it("renders nothing once the steer is applied — it is just part of the thread", () => {
    const msg = steerMessage("e1", "applied")
    seed({ status: "idle", messages: [msg] })
    const { container } = render(<SteerStatusBadge message={msg} sessionId={SID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("derives 'not delivered' for a queued steer left behind by a finished run", () => {
    // The queue is memory-only, so after a reload nothing remains to deliver it.
    const msg = steerMessage("e1", "queued")
    seed({ status: "idle", steerQueue: [], messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    expect(screen.getByTestId("steer-status-badge")).toHaveAttribute("data-state", "failed")
  })

  it("shows the send position only once a second follow-up is queued", () => {
    seed({ status: "streaming", steerQueue: [{ id: "e1", text: "one" }] })
    const single = render(
      <SteerStatusBadge message={steerMessage("e1", "queued")} sessionId={SID} />
    )
    expect(screen.queryByTestId("steer-queue-position")).not.toBeInTheDocument()
    single.unmount()

    // Two entries drain as one framed turn, so which one goes first is now a
    // real choice the run panel lets the user make — the bubble has to say
    // where this one currently sits, since the transcript keeps arrival order.
    seed({
      status: "streaming",
      steerQueue: [
        { id: "e2", text: "two" },
        { id: "e1", text: "one" },
      ],
    })
    render(<SteerStatusBadge message={steerMessage("e1", "queued")} sessionId={SID} />)
    expect(screen.getByTestId("steer-queue-position")).toBeInTheDocument()
  })

  it("removes both the queue entry and the bubble on discard", () => {
    const msg = steerMessage("e1", "queued")
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "use TypeScript" }],
      messages: [msg],
    })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByLabelText("ariaRemove"))
    const slice = useChatStore.getState().sessions[SID]
    expect(slice?.steerQueue).toEqual([])
    expect(slice?.messages).toEqual([])
  })

  it("edits the queue entry and the bubble together", () => {
    const msg = steerMessage("e1", "queued")
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "use TypeScript" }],
      messages: [msg],
    })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByLabelText("ariaEdit"))
    const input = screen.getByTestId("steer-edit-input")
    fireEvent.change(input, { target: { value: "use Rust" } })
    fireEvent.keyDown(input, { key: "Enter" })
    const slice = useChatStore.getState().sessions[SID]
    // Both move or the transcript starts lying about what was requested.
    expect(slice?.steerQueue[0]?.text).toBe("use Rust")
    expect((slice?.messages[0].parts[0] as { text: string }).text).toBe("use Rust")
  })

  it("Escape abandons an edit without touching the queue", () => {
    const msg = steerMessage("e1", "queued")
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "use TypeScript" }],
      messages: [msg],
    })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByLabelText("ariaEdit"))
    const input = screen.getByTestId("steer-edit-input")
    fireEvent.change(input, { target: { value: "throw this away" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByTestId("steer-edit-input")).not.toBeInTheDocument()
    expect(useChatStore.getState().sessions[SID]?.steerQueue[0]?.text).toBe("use TypeScript")
  })

  it("clearing the editor discards the steer entirely", () => {
    const msg = steerMessage("e1", "queued")
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "use TypeScript" }],
      messages: [msg],
    })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByLabelText("ariaEdit"))
    const input = screen.getByTestId("steer-edit-input")
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(useChatStore.getState().sessions[SID]?.steerQueue).toEqual([])
  })

  it("puts an undelivered steer back in its own composer instead of resending it", () => {
    const msg = steerMessage("e1", "failed")
    seed({ status: "idle", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByTestId("steer-put-back"))
    // Addressed to this session so a split pane's composer is untouched, and
    // never auto-sent — the run it was meant to steer is over.
    expect(dispatchComposerAppendMock).toHaveBeenCalledWith({
      text: "use TypeScript",
      sessionId: SID,
    })
    expect(useChatStore.getState().sessions[SID]?.messages).toEqual([])
  })

  it("discards an undelivered steer outright", () => {
    const msg = steerMessage("e1", "failed")
    seed({ status: "idle", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByLabelText("ariaRemove"))
    expect(useChatStore.getState().sessions[SID]?.messages).toEqual([])
    expect(dispatchComposerAppendMock).not.toHaveBeenCalled()
  })

  it("commits an edit on blur, not just on Enter", () => {
    const msg = steerMessage("e1", "queued")
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "use TypeScript" }],
      messages: [msg],
    })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByLabelText("ariaEdit"))
    const input = screen.getByTestId("steer-edit-input")
    fireEvent.change(input, { target: { value: "use Go" } })
    fireEvent.blur(input)
    expect(useChatStore.getState().sessions[SID]?.steerQueue[0]?.text).toBe("use Go")
  })

  it("strips the model-facing framing when putting a legacy steer back", () => {
    const msg = steerMessage("e1", "failed", "By the way (steering): use TypeScript")
    seed({ status: "idle", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByTestId("steer-put-back"))
    expect(dispatchComposerAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "use TypeScript" })
    )
  })
})
