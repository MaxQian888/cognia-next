/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

// Identity i18n so assertions read as the key names.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Only the append bridge matters here; a mounted composer claims the event.
const dispatchComposerAppendMock = jest.fn((_detail: unknown) => true)
jest.mock("@/lib/chat/composer-append", () => ({
  __esModule: true,
  dispatchComposerAppend: (detail: unknown) => dispatchComposerAppendMock(detail),
}))

// Attachment originals live in the session asset store (Dexie).
const getSessionAssetMock = jest.fn()
jest.mock("@/lib/db/session-assets", () => ({
  getSessionAsset: (...args: unknown[]) => getSessionAssetMock(...args),
}))

const persistMessagesMock = jest.fn(() => Promise.resolve())
jest.mock("@/lib/db/messages", () => ({
  persistMessages: (...args: unknown[]) => persistMessagesMock(...(args as [])),
}))

import { SteerStatusBadge } from "./steer-status-badge"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"

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
  getSessionAssetMock.mockReset()
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

  it("keeps the pending edit / remove controls reachable without a hover", () => {
    const msg = steerMessage("e1", "queued")
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "use TypeScript" }],
      messages: [msg],
    })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    for (const label of ["ariaEdit", "ariaRemove"]) {
      const control = screen.getByLabelText(label)
      for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.controlBase) {
        expect(control).toHaveClass(variant)
      }
      expect(control).toHaveClass("group-hover/steer:opacity-100", "hover:text-foreground")
      for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
        expect(control).not.toHaveClass(forbidden)
      }
      control.focus()
      expect(control).toHaveFocus()
    }
    fireEvent.click(screen.getByLabelText("ariaRemove"))
    expect(useChatStore.getState().sessions[SID]?.steerQueue).toEqual([])
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

  it("drafts an edit from the typed text, without the context envelope", () => {
    // The user edits their own words. The envelope is machine-written and put
    // back by `editPendingSteer` on commit, so showing it here would invite the
    // user to edit (or delete) a snapshot they never typed.
    const { text } = composeTurnText(
      "typed words",
      [{ kind: "references", text: "SECRET SNAPSHOT" }],
      { nonce: "abcdef0123" }
    )
    const msg = steerMessage("e1", "queued", text)
    seed({ status: "streaming", steerQueue: [{ id: "e1", text }], messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByLabelText("ariaEdit"))
    const input = screen.getByTestId("steer-edit-input") as HTMLTextAreaElement
    expect(input.value).toBe("typed words")
    expect(input.value).not.toContain("SECRET SNAPSHOT")
    expect(input.value).not.toContain("cognia_context_")
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

  it("puts an undelivered steer back in its own composer instead of resending it", async () => {
    const msg = steerMessage("e1", "failed")
    seed({ status: "idle", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByTestId("steer-put-back"))
    // Addressed to this session so a split pane's composer is untouched, and
    // never auto-sent — the run it was meant to steer is over.
    await waitFor(() =>
      expect(dispatchComposerAppendMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: "use TypeScript", sessionId: SID })
      )
    )
    expect(useChatStore.getState().sessions[SID]?.messages).toEqual([])
  })

  it("puts back the files, citations and reply a follow-up carried, not just its words", async () => {
    getSessionAssetMock.mockResolvedValue({
      blob: new Blob(["%PDF"], { type: "application/pdf" }),
      filename: "spec.pdf",
      mediaType: "application/pdf",
    })
    const reply = { messageId: "m0", preview: "earlier answer" }
    const msg = {
      id: "m-e1",
      role: "user",
      parts: [
        {
          type: "file",
          filename: "spec.pdf",
          extractedContent: {
            attachmentId: "a1",
            contentHash: "b".repeat(64),
            status: "ready",
            processor: { id: "t", version: "1" },
            segments: [],
          },
        },
        { type: "file", url: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" },
        { type: "text", text: "compare these" },
      ],
      metadata: {
        steer: { entryId: "e1", state: "failed" },
        mentions: [{ kind: "entity", id: "memory:m1", label: "Deploy notes" }],
        replyTo: reply,
      },
    } as unknown as UIMessage
    seed({ status: "idle", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByTestId("steer-put-back"))
    await waitFor(() => expect(dispatchComposerAppendMock).toHaveBeenCalled())
    const detail = dispatchComposerAppendMock.mock.calls[0]![0] as {
      files: File[]
      citations: unknown[]
      replyTo: unknown
    }
    expect(detail.files.map((file) => file.name)).toEqual(["spec.pdf", "attachment-2.png"])
    expect(detail.citations).toEqual([{ kind: "entity", id: "memory:m1", label: "Deploy notes" }])
    expect(detail.replyTo).toEqual(reply)
    expect(getSessionAssetMock).toHaveBeenCalledWith(SID, "a1")
  })

  it("keeps the bubble when no composer is there to take it", async () => {
    dispatchComposerAppendMock.mockReturnValueOnce(false)
    const msg = steerMessage("e1", "failed")
    seed({ status: "idle", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByTestId("steer-put-back"))
    await waitFor(() => expect(dispatchComposerAppendMock).toHaveBeenCalled())
    expect(useChatStore.getState().sessions[SID]?.messages).toHaveLength(1)
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

  it("strips the model-facing framing when putting a legacy steer back", async () => {
    const msg = steerMessage("e1", "failed", "By the way (steering): use TypeScript")
    seed({ status: "idle", messages: [msg] })
    render(<SteerStatusBadge message={msg} sessionId={SID} />)
    fireEvent.click(screen.getByTestId("steer-put-back"))
    await waitFor(() =>
      expect(dispatchComposerAppendMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: "use TypeScript" })
      )
    )
  })
})
