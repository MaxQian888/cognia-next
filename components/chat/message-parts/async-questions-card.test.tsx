import { fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import { AsyncQuestionsCard, formatAsyncQuestionAnswer } from "./async-questions-card"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import { resolveExternalQuestion } from "@/lib/ai/agent/external/chat-decision-bridge"
import { useChatStore } from "@/stores/chat"
import { persistMessages } from "@/lib/db/messages"

jest.mock("@/hooks/chat/chat-send-bridge", () => ({
  sendChatMessage: jest.fn(() => true),
}))

jest.mock("@/lib/ai/agent/external/chat-decision-bridge", () => ({
  resolveExternalQuestion: jest.fn(() => Promise.resolve(true)),
}))

jest.mock("@/lib/db/messages", () => ({
  persistMessages: jest.fn(() => Promise.resolve()),
}))

// The card only needs the intro prose rendered — the real renderer pulls in
// Shiki/async highlighting that adds noise without covering anything here.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="question-prose">{content}</div>
  ),
}))

const mockSend = sendChatMessage as jest.Mock
const mockResolve = resolveExternalQuestion as jest.Mock
const mockPersist = persistMessages as jest.Mock

function makePart(data: Record<string, unknown>): UIMessage["parts"][number] {
  return { type: "data-async-questions", data } as unknown as UIMessage["parts"][number]
}

function seedMessage(sessionId: string, messageId: string, part: UIMessage["parts"][number]) {
  const message = {
    id: messageId,
    role: "assistant",
    parts: [part],
  } as unknown as UIMessage
  useChatStore.getState().setSessionMessages(sessionId, [message])
}

describe("formatAsyncQuestionAnswer", () => {
  it("quotes the question above the answer so the agent can associate it", () => {
    expect(formatAsyncQuestionAnswer("Which file?", "a.ts")).toBe("> Which file?\n\na.ts")
  })
})

describe("AsyncQuestionsCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSend.mockReturnValue(true)
    mockResolve.mockResolvedValue(true)
    useChatStore.getState().setSessionMessages("s-1", [])
  })

  it("renders each question with its suggested options", () => {
    render(
      <AsyncQuestionsCard
        part={makePart({
          itemId: "item-1",
          sessionId: "s-1",
          questions: [
            { title: "Which file?", options: ["a.ts", "b.ts"] },
            { title: "Any constraints?" },
          ],
        })}
        messageId="m-1"
      />
    )
    expect(screen.getByText("Which file?")).toBeInTheDocument()
    expect(screen.getByText("Any constraints?")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "a.ts" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "b.ts" })).toBeInTheDocument()
  })

  it("sends an option answer as a quoted user message and marks it answered", () => {
    const part = makePart({
      itemId: "item-1",
      sessionId: "s-1",
      questions: [{ title: "Which file?", options: ["a.ts", "b.ts"] }],
    })
    seedMessage("s-1", "m-1", part)
    render(<AsyncQuestionsCard part={part} messageId="m-1" />)

    fireEvent.click(screen.getByRole("button", { name: "b.ts" }))

    expect(mockSend).toHaveBeenCalledWith("s-1", "> Which file?\n\nb.ts")
    expect(screen.getByText(/b\.ts/)).toBeInTheDocument()
    // The answer is persisted onto the part so a reload doesn't re-offer it.
    const stored = useChatStore.getState().sessions["s-1"].messages[0]
    const data = (stored.parts[0] as { data: { answers: Record<number, string> } }).data
    expect(data.answers).toEqual({ 0: "b.ts" })
    expect(mockPersist).toHaveBeenCalled()
  })

  it("sends a typed answer on Enter", () => {
    const part = makePart({
      itemId: "item-1",
      sessionId: "s-1",
      questions: [{ title: "Any constraints?" }],
    })
    seedMessage("s-1", "m-1", part)
    render(<AsyncQuestionsCard part={part} messageId="m-1" />)

    const input = screen.getByPlaceholderText("Type an answer…")
    fireEvent.change(input, { target: { value: "keep it small" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(mockSend).toHaveBeenCalledWith("s-1", "> Any constraints?\n\nkeep it small")
  })

  it("targets the session stamped on the part, not the focused one", () => {
    const part = makePart({
      itemId: "item-1",
      sessionId: "s-1",
      questions: [{ title: "Q", options: ["yes"] }],
    })
    seedMessage("s-1", "m-1", part)
    render(<AsyncQuestionsCard part={part} messageId="m-1" sessionId="other-pane" />)

    fireEvent.click(screen.getByRole("button", { name: "yes" }))
    expect(mockSend).toHaveBeenCalledWith("s-1", expect.any(String))
  })

  it("falls back to the renderer-provided session id when the part has none", () => {
    const part = makePart({ questions: [{ title: "Q", options: ["yes"] }] })
    seedMessage("pane-2", "m-1", part)
    render(<AsyncQuestionsCard part={part} messageId="m-1" sessionId="pane-2" />)

    fireEvent.click(screen.getByRole("button", { name: "yes" }))
    expect(mockSend).toHaveBeenCalledWith("pane-2", expect.any(String))
  })

  it("keeps the question answerable when the send bridge is unavailable", () => {
    mockSend.mockReturnValue(false)
    const part = makePart({
      sessionId: "s-1",
      questions: [{ title: "Q", options: ["yes"] }],
    })
    seedMessage("s-1", "m-1", part)
    render(<AsyncQuestionsCard part={part} messageId="m-1" />)

    fireEvent.click(screen.getByRole("button", { name: "yes" }))
    // Not marked answered — the answer never left.
    expect(screen.queryByText(/Answered:/)).not.toBeInTheDocument()
    const stored = useChatStore.getState().sessions["s-1"].messages[0]
    expect(
      (stored.parts[0] as { data: { answers?: Record<number, string> } }).data.answers
    ).toBeUndefined()
  })

  it("renders persisted answers as settled on a reloaded transcript", () => {
    render(
      <AsyncQuestionsCard
        part={makePart({
          sessionId: "s-1",
          questions: [{ title: "Q", options: ["yes", "no"] }],
          answers: { 0: "yes" },
        })}
        messageId="m-1"
      />
    )
    expect(screen.getByText(/yes/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "no" })).not.toBeInTheDocument()
  })

  it("renders the unstreamed question prose above the questions", () => {
    render(
      <AsyncQuestionsCard
        part={makePart({
          sessionId: "s-1",
          text: "Two things before I continue:",
          questions: [{ title: "Q" }],
        })}
        messageId="m-1"
      />
    )
    expect(screen.getByTestId("question-prose")).toHaveTextContent("Two things before I continue:")
  })

  it("returns null for a part without questions", () => {
    const { container } = render(
      <AsyncQuestionsCard part={makePart({ sessionId: "s-1" })} messageId="m-1" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("resolves the pending RPC instead of sending a user message on requestId cards", async () => {
    const part = makePart({
      sessionId: "s-1",
      requestId: "external-agent:ext-1:q-item",
      responseRequestId: "q-item",
      questions: [
        { id: "q1", title: "Region?", options: ["us-east", "eu-west"] },
        { id: "q2", title: "Notes?" },
      ],
    })
    seedMessage("s-1", "m-1", part)
    render(<AsyncQuestionsCard part={part} messageId="m-1" />)

    // Type a second answer first — the single wire reply folds in every draft.
    const inputs = screen.getAllByPlaceholderText("Type an answer…")
    fireEvent.change(inputs[1], { target: { value: "keep it small" } })
    fireEvent.click(screen.getByRole("button", { name: "eu-west" }))

    await screen.findByText(/eu-west/)
    expect(mockResolve).toHaveBeenCalledWith("external-agent:ext-1:q-item", {
      q1: ["eu-west"],
      q2: ["keep it small"],
    })
    expect(mockSend).not.toHaveBeenCalled()
    // One resolve settles the whole request — q2's draft rode the same reply,
    // so it shows as answered too.
    expect(screen.getByText(/keep it small/)).toBeInTheDocument()
  })

  it("closes the card without an error toast when the request was already settled", async () => {
    mockResolve.mockResolvedValue(false)
    const part = makePart({
      sessionId: "s-1",
      requestId: "external-agent:ext-1:q-item",
      questions: [{ id: "q1", title: "Region?", options: ["yes"] }],
    })
    render(<AsyncQuestionsCard part={part} messageId="m-1" />)

    fireEvent.click(screen.getByRole("button", { name: "yes" }))
    expect(await screen.findByText("Closed without an answer")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument()
  })

  it("masks a secret answer in state and persistence instead of storing it raw", async () => {
    const part = makePart({
      sessionId: "s-1",
      requestId: "external-agent:ext-1:q-item",
      questions: [{ id: "q1", title: "Token?", secret: true }],
    })
    seedMessage("s-1", "m-1", part)
    render(<AsyncQuestionsCard part={part} messageId="m-1" />)

    const input = screen.getByPlaceholderText("Type an answer…")
    expect(input).toHaveAttribute("type", "password")
    fireEvent.change(input, { target: { value: "s3cret" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await screen.findByText(/••••/)
    expect(mockResolve).toHaveBeenCalledWith("external-agent:ext-1:q-item", { q1: ["s3cret"] })
    const stored = useChatStore.getState().sessions["s-1"].messages[0]
    const data = (stored.parts[0] as { data: { answers: Record<number, string> } }).data
    expect(data.answers[0]).not.toContain("s3cret")
  })

  it("renders a resolved-elsewhere card as closed, not answerable", () => {
    render(
      <AsyncQuestionsCard
        part={makePart({
          sessionId: "s-1",
          requestId: "external-agent:ext-1:q-item",
          closed: true,
          questions: [{ id: "q1", title: "Region?", options: ["yes"] }],
        })}
        messageId="m-1"
      />
    )
    expect(screen.getByText("Closed without an answer")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument()
  })
})
