import { render, screen } from "@testing-library/react"
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
let virtualizerOptions: { count: number; overscan?: number } | null = null

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number; overscan?: number }) => {
    virtualizerOptions = options
    const indexes = visibleIndexes ?? Array.from({ length: options.count }, (_, index) => index)
    return {
      getVirtualItems: () =>
        indexes.map((index) => ({ index, key: index, start: index * 200, size: 200 })),
      getTotalSize: () => options.count * 200,
      measureElement: jest.fn(),
      measure: jest.fn(),
    }
  },
}))

function message(id: string, role: UIMessage["role"], text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] }
}

describe("<TranscriptMessageList />", () => {
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
