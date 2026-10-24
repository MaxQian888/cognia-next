/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, render, screen } from "@testing-library/react"
import { A2UIPart, a2uiFenceBody } from "./a2ui-part"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"
import { TranscriptSessionProvider } from "@/components/chat/transcript-session-context"
import {
  __resetA2UIChatBindingsForTesting,
  getA2UIChatBinding,
} from "@/lib/a2ui/chat-action-routing"
import type { A2UIPart as A2UIPartType } from "@/lib/claude/parts-extensions"

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

/** Let the part's queued (microtask) state updates land. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

// Mock A2UI hooks
const mockProcessMessage = jest.fn()
const mockGetSurface = jest.fn()

jest.mock("@/components/a2ui", () => ({
  A2UIInlineSurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid="a2ui-surface" data-surface-id={surfaceId}>
      A2UI Surface
    </div>
  ),
  useA2UIMessageIntegration: () => ({
    processMessage: mockProcessMessage,
    getSurface: mockGetSurface,
  }),
}))

describe("A2UIPart", () => {
  const mockPart: A2UIPartType = {
    type: "a2ui",
    surfaceId: "test-surface-1",
    content: "<a2ui>Test content</a2ui>",
    source: "codeblock",
  }

  const defaultProps = {
    part: mockPart,
    onAction: jest.fn(),
    onDataChange: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    __resetA2UIChatBindingsForTesting()
    mockProcessMessage.mockReturnValue("test-surface-1")
    mockGetSurface.mockReturnValue({ id: "test-surface-1", components: [] })
  })

  it("renders A2UI surface when surface exists", () => {
    render(<A2UIPart {...defaultProps} />)

    expect(screen.getByTestId("a2ui-surface")).toBeInTheDocument()
  })

  it("renders nothing before the payload is processed", () => {
    mockGetSurface.mockReturnValue(null)

    const { container } = render(<A2UIPart {...defaultProps} />)

    expect(container.firstChild).toBeNull()
  })

  it("shows the source with a notice when the payload yields no surface", async () => {
    mockGetSurface.mockReturnValue(null)
    const part = { ...mockPart, content: '```a2ui\n{"components": [oops]}\n```' }

    render(<A2UIPart {...defaultProps} part={part} />)
    await flush()

    expect(screen.getByRole("status")).toHaveTextContent(
      "This interactive UI couldn't be rendered. Showing its source instead."
    )
    expect(screen.getByTestId("code-block")).toHaveTextContent('{"components": [oops]}')
  })

  it("falls back to the source when the store rejects the payload", async () => {
    mockProcessMessage.mockImplementation(() => {
      throw new TypeError("Invalid A2UI dispatch message")
    })
    mockGetSurface.mockReturnValue(null)

    render(<A2UIPart {...defaultProps} />)
    await flush()

    expect(screen.getByTestId("code-block")).toBeInTheDocument()
  })

  it("binds the surface to the explicit session over the chat scope", async () => {
    const { unmount } = render(
      <ChatScopeProvider sessionId="scope-session">
        <A2UIPart {...defaultProps} sessionId="row-session" _messageId="m1" />
      </ChatScopeProvider>
    )
    await flush()

    expect(getA2UIChatBinding("test-surface-1")).toEqual({
      sessionId: "row-session",
      messageId: "m1",
    })
    unmount()
    expect(getA2UIChatBinding("test-surface-1")).toBeUndefined()
  })

  it("binds to the transcript list's session over a row session that fell back to the focused one", async () => {
    render(
      <TranscriptSessionProvider sessionId="split-pane-session">
        <A2UIPart {...defaultProps} sessionId="active-session" _messageId="m1" />
      </TranscriptSessionProvider>
    )
    await flush()

    expect(getA2UIChatBinding("test-surface-1")?.sessionId).toBe("split-pane-session")
  })

  it("falls back to the chat scope's session", async () => {
    render(
      <ChatScopeProvider sessionId="scope-session">
        <A2UIPart {...defaultProps} />
      </ChatScopeProvider>
    )
    await flush()

    expect(getA2UIChatBinding("test-surface-1")?.sessionId).toBe("scope-session")
  })

  it("leaves the surface unbound outside a chat", async () => {
    render(<A2UIPart {...defaultProps} />)
    await flush()

    expect(getA2UIChatBinding("test-surface-1")).toBeUndefined()
  })

  it("calls processMessage with part content", () => {
    render(<A2UIPart {...defaultProps} />)

    expect(mockProcessMessage).toHaveBeenCalledWith(mockPart.content, mockPart.surfaceId)
  })

  it("passes surfaceId to A2UIInlineSurface", () => {
    render(<A2UIPart {...defaultProps} />)

    const surface = screen.getByTestId("a2ui-surface")
    expect(surface).toHaveAttribute("data-surface-id", "test-surface-1")
  })

  it("applies custom className", () => {
    const { container } = render(<A2UIPart {...defaultProps} className="custom-class" />)

    if (container.firstChild) {
      expect(container.firstChild).toHaveClass("custom-class")
    }
  })

  it("still routes content through unified processMessage entry", () => {
    const partWithoutA2UI: A2UIPartType = {
      ...mockPart,
      content: "Regular content without A2UI",
    }

    render(<A2UIPart {...defaultProps} part={partWithoutA2UI} />)

    expect(mockProcessMessage).toHaveBeenCalledWith(
      partWithoutA2UI.content,
      partWithoutA2UI.surfaceId
    )
  })
})

describe("a2uiFenceBody", () => {
  it("strips the fence lines", () => {
    expect(a2uiFenceBody('```a2ui\n{"a":1}\n```')).toBe('{"a":1}')
    expect(a2uiFenceBody("~~~~json\n[1]\n~~~~\n")).toBe("[1]")
  })

  it("returns unfenced content as is", () => {
    expect(a2uiFenceBody(' {"a":1} ')).toBe('{"a":1}')
  })
})
