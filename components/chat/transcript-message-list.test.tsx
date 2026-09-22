import { fireEvent, render, screen } from "@testing-library/react"
import { DEFAULT_MESSAGE_DISPLAY_OPTIONS } from "@/lib/chat/message-display"
import type { UIMessage } from "ai"

import { TranscriptMessageList } from "./transcript-message-list"

const renderedMessageIds: string[] = []
const renderedMessageDisplays: unknown[] = []

jest.mock("./message-renderer", () => ({
  MessageRenderer: ({
    message,
    isStreaming,
    isLastAssistant,
    messageDisplay,
  }: {
    message: UIMessage
    isStreaming?: boolean
    isLastAssistant?: boolean
    messageDisplay?: unknown
  }) => {
    renderedMessageIds.push(message.id)
    renderedMessageDisplays.push(messageDisplay)
    return (
      <div
        tabIndex={0}
        data-testid={`canonical-message-${message.id}`}
        data-streaming={isStreaming ? "true" : "false"}
        data-last-assistant={isLastAssistant ? "true" : "false"}
      >
        {message.parts.map((part) =>
          part.type === "text" ? (part as { text: string }).text : part.type
        )}
      </div>
    )
  },
}))

let visibleIndexes: number[] | null = null
let virtualizerOptions: {
  count: number
  overscan?: number
  getItemKey: (index: number) => string
} | null = null
const virtualizer = {
  getVirtualItems: () => {
    const indexes =
      visibleIndexes ?? Array.from({ length: virtualizerOptions!.count }, (_, index) => index)
    return indexes
      .filter((index) => index < virtualizerOptions!.count)
      .map((index) => ({
        index,
        key: virtualizerOptions!.getItemKey(index),
        start: index * 200,
        size: 200,
      }))
  },
  getTotalSize: () => virtualizerOptions!.count * 200,
  measureElement: jest.fn(),
  measure: jest.fn(),
}

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: NonNullable<typeof virtualizerOptions>) => {
    virtualizerOptions = options
    return virtualizer
  },
}))

function message(id: string, role: UIMessage["role"], text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] }
}

describe("<TranscriptMessageList />", () => {
  it.each(["streaming", "awaiting_approval"] as const)(
    "keeps a growing tail in document flow during %s",
    (status) => {
      visibleIndexes = [48]
      const messages = Array.from({ length: 50 }, (_, i) =>
        message(`m${i}`, i % 2 ? "assistant" : "user", `body ${i}`)
      )
      const { rerender } = render(
        <TranscriptMessageList sessionId="s" messages={messages} status={status} />
      )
      expect(virtualizerOptions?.count).toBe(49)
      const tail = screen.getByTestId("canonical-message-m49").parentElement!
      const focused = screen.getByTestId("canonical-message-m49")
      focused.focus()
      expect(tail).toHaveAttribute("data-index", "-1")
      expect(tail.style.position).toBe("")
      expect(screen.getByTestId("canonical-message-m49")).toHaveAttribute("data-streaming", "true")
      visibleIndexes = [48, 49]
      rerender(<TranscriptMessageList sessionId="s" messages={messages} status="idle" />)
      expect(virtualizerOptions?.count).toBe(50)
      expect(screen.getByTestId("canonical-message-m49").parentElement).toHaveAttribute(
        "data-index",
        "49"
      )
      expect(screen.getAllByTestId("canonical-message-m49")).toHaveLength(1)
      expect(screen.getByTestId("canonical-message-m49")).toBe(focused)
      expect(document.activeElement).toBe(focused)
      // Resuming retains the node but queued measurements must ignore it.
      rerender(<TranscriptMessageList sessionId="s" messages={messages} status={status} />)
      expect(screen.getByTestId("canonical-message-m49")).toBe(focused)
      expect(tail).toHaveAttribute("data-index", "-1")
    }
  )

  it("pins restored history and finalization while respecting a reader who scrolls up", () => {
    const messages = Array.from({ length: 50 }, (_, index) =>
      message(`m${index}`, "assistant", "body")
    )
    const { rerender } = render(
      <TranscriptMessageList sessionId="s" messages={[]} status="loading" />
    )
    const scroll = screen.getByRole("log")
    let height = 10000
    Object.defineProperties(scroll, {
      scrollHeight: { get: () => height, configurable: true },
      clientHeight: { get: () => 500, configurable: true },
    })
    rerender(<TranscriptMessageList sessionId="s" messages={messages} status="idle" />)
    expect(scroll.scrollTop).toBe(10000)
    scroll.scrollTop = 2000
    fireEvent.scroll(scroll)
    height = 11000
    rerender(<TranscriptMessageList sessionId="s" messages={[...messages]} status="streaming" />)
    expect(scroll.scrollTop).toBe(2000)
    rerender(<TranscriptMessageList sessionId="s" messages={[...messages]} status="idle" />)
    expect(scroll.scrollTop).toBe(2000)
    scroll.scrollTop = height - 500
    fireEvent.scroll(scroll)
    rerender(<TranscriptMessageList sessionId="s" messages={[...messages]} status="streaming" />)
    height = 12000
    rerender(<TranscriptMessageList sessionId="s" messages={[...messages]} status="idle" />)
    expect(scroll.scrollTop).toBe(12000)
    scroll.scrollTop = 1000
    fireEvent.scroll(scroll)
    rerender(<TranscriptMessageList sessionId="other" messages={messages} status="idle" />)
    expect(scroll.scrollTop).toBe(12000)
  })

  it("keeps disclosure nodes mounted when the transcript crosses the virtualization threshold", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(`m${index}`, "assistant", "body")
    )
    const { rerender } = render(
      <TranscriptMessageList sessionId="s" messages={messages} status="idle" />
    )
    const first = screen.getByTestId("canonical-message-m0")
    rerender(
      <TranscriptMessageList
        sessionId="s"
        messages={[...messages, message("new", "user", "next")]}
        status="idle"
      />
    )
    expect(screen.getByTestId("canonical-message-m0")).toBe(first)
    rerender(<TranscriptMessageList sessionId="s" messages={messages} status="idle" />)
    expect(screen.getByTestId("canonical-message-m0")).toBe(first)
  })

  it("keys height measurements by session and message across history clipping", () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      message(`m${i}`, "assistant", `body ${i}`)
    )
    const { rerender } = render(
      <TranscriptMessageList sessionId="s" messages={messages} status="idle" />
    )
    const key = virtualizerOptions!.getItemKey(1)
    rerender(<TranscriptMessageList sessionId="s" messages={messages.slice(1)} status="idle" />)
    expect(virtualizerOptions!.getItemKey(0)).toBe(key)
    rerender(<TranscriptMessageList sessionId="other" messages={messages.slice(1)} status="idle" />)
    expect(virtualizerOptions!.getItemKey(0)).not.toBe(key)
  })
  beforeEach(() => {
    renderedMessageIds.length = 0
    renderedMessageDisplays.length = 0
    visibleIndexes = null
    virtualizerOptions = null
  })

  it("renders rich remote messages through the canonical renderer", () => {
    render(
      <TranscriptMessageList
        sessionId="remote-1"
        messages={[
          message("u1", "user", "question"),
          {
            id: "a1",
            role: "assistant",
            parts: [
              { type: "text", text: "**answer**" },
              { type: "tool-shell", toolCallId: "tool-1", state: "input-available", input: {} },
            ],
          } as UIMessage,
        ]}
        status="streaming"
        // Spread from the shipped defaults: the hand-written literal went stale
        // when `ResolvedMessageDisplayOptions` gained `markdown` and `bodyFont`
        // (ADR-0127), and would go stale again on the next field.
        messageDisplay={{
          ...DEFAULT_MESSAGE_DISPLAY_OPTIONS,
          preset: "inspector",
          layout: "hybrid",
          actions: "all",
          agentFlowMode: "detailed",
          reasoning: "expanded",
          tools: "expanded",
          sources: "expanded",
          richControls: "always",
          motion: "restrained",
        }}
      />
    )

    expect(screen.getByRole("log")).toHaveAttribute("data-session-id", "remote-1")
    expect(screen.getByTestId("canonical-message-a1")).toHaveAttribute("data-streaming", "true")
    expect(screen.getByTestId("canonical-message-a1")).toHaveAttribute(
      "data-last-assistant",
      "true"
    )
    expect(renderedMessageIds).toEqual(["u1", "a1"])
    expect(renderedMessageDisplays).toEqual([
      expect.objectContaining({ preset: "inspector" }),
      expect.objectContaining({ preset: "inspector" }),
    ])
  })

  it("mounts only the virtualizer window for a large transcript", () => {
    visibleIndexes = [48, 49]
    const messages = Array.from({ length: 50 }, (_, index) =>
      message(`m${index}`, index % 2 === 0 ? "user" : "assistant", `message ${index}`)
    )

    render(<TranscriptMessageList sessionId="remote-large" messages={messages} status="idle" />)

    expect(virtualizerOptions).toMatchObject({ count: 50, overscan: 5 })
    expect(renderedMessageIds).toEqual(["m48", "m49"])
    expect(screen.queryByTestId("canonical-message-m0")).not.toBeInTheDocument()
  })
})
