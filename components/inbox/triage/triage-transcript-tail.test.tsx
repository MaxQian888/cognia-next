/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

let mockMessages: unknown[] | undefined
const mockQueryFn = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown, deps: unknown[]) => {
    mockQueryFn(fn, deps)
    return mockMessages
  },
}))
jest.mock("@/lib/db/messages", () => ({
  listRecentMessages: jest.fn().mockResolvedValue([]),
}))
jest.mock("@/components/chat/transcript-message-list", () => ({
  TranscriptMessageList: ({
    messages,
    status,
    sessionId,
  }: {
    messages: unknown[]
    status: string
    sessionId: string
  }) => (
    <div
      data-testid="transcript-stub"
      data-count={messages.length}
      data-status={status}
      data-session={sessionId}
    />
  ),
}))

import { listRecentMessages } from "@/lib/db/messages"
import { TRIAGE_TRANSCRIPT_LIMIT, TriageTranscriptTail } from "./triage-transcript-tail"

const msg = (id: string) => ({ id, role: "user", parts: [{ type: "text", text: id }] })

beforeEach(() => {
  mockMessages = undefined
  mockQueryFn.mockReset()
})

describe("TriageTranscriptTail", () => {
  it("reads only the tail of the session, live", async () => {
    render(<TriageTranscriptTail sessionId="s1" layout="fill" onOpenInChat={() => {}} />)
    const [query, deps] = mockQueryFn.mock.calls[0]!
    expect(deps).toEqual(["s1"])
    await query()
    expect(listRecentMessages).toHaveBeenCalledWith("s1", TRIAGE_TRANSCRIPT_LIMIT)
  })

  it("shows a skeleton while loading", () => {
    render(<TriageTranscriptTail sessionId="s1" layout="fill" onOpenInChat={() => {}} />)
    expect(screen.getByTestId("triage-transcript-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("shows an empty line when there are no messages", () => {
    mockMessages = []
    render(<TriageTranscriptTail sessionId="s1" layout="fill" onOpenInChat={() => {}} />)
    expect(screen.getByTestId("triage-transcript-empty")).toHaveTextContent("No messages yet")
  })

  it("renders the messages read-only through the shared transcript lane", () => {
    mockMessages = [msg("a"), msg("b")]
    render(<TriageTranscriptTail sessionId="s1" layout="flow" onOpenInChat={() => {}} />)
    const list = screen.getByTestId("transcript-stub")
    expect(list).toHaveAttribute("data-count", "2")
    expect(list).toHaveAttribute("data-status", "idle")
    expect(screen.getByTestId("triage-transcript")).toHaveAttribute("data-layout", "flow")
  })

  it("notes the cut-off once the tail is full", () => {
    mockMessages = Array.from({ length: TRIAGE_TRANSCRIPT_LIMIT }, (_, i) => msg(`m${i}`))
    render(<TriageTranscriptTail sessionId="s1" layout="fill" onOpenInChat={() => {}} />)
    expect(screen.getByText(`Last ${TRIAGE_TRANSCRIPT_LIMIT}`)).toBeInTheDocument()
  })

  it("does not claim a cut-off for a short conversation", () => {
    mockMessages = [msg("a")]
    render(<TriageTranscriptTail sessionId="s1" layout="fill" onOpenInChat={() => {}} />)
    expect(screen.queryByText(`Last ${TRIAGE_TRANSCRIPT_LIMIT}`)).not.toBeInTheDocument()
  })

  it("opens the full conversation from the footer", () => {
    mockMessages = []
    const onOpenInChat = jest.fn()
    render(<TriageTranscriptTail sessionId="s1" layout="fill" onOpenInChat={onOpenInChat} />)
    fireEvent.click(screen.getByRole("button", { name: "Open full conversation" }))
    expect(onOpenInChat).toHaveBeenCalled()
  })
})
