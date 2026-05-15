// Tests for ChatPane callback stability and render behavior.
// Focuses on the perf-critical path: stable useCallback refs prevent
// MessageRenderer from re-rendering on every ChatPane re-render.

import * as ReactForMocks from "react"

jest.mock("./composer", () => ({ Composer: () => null }))
jest.mock("./chat-header", () => ({
  ChatHeader: jest.fn(() => null),
}))
jest.mock("./empty-state", () => ({ EmptyChatState: jest.fn(() => null) }))
jest.mock("./inline-error", () => ({ InlineError: () => null }))
jest.mock("./message-list", () => ({
  MessageList: jest.fn(() => null),
}))
jest.mock("@/components/agent/external-agent-session-panel", () => ({
  ExternalAgentSessionPanel: () => null,
}))
jest.mock("next-intl", () => {
  // Stable function reference — prevents useCallback deps from changing across renders
  const t = (k: string) => k
  return { useTranslations: () => t }
})

const storeState = {
  messages: [{ id: "m1", role: "user", parts: [] }] as unknown[],
  status: "idle",
  errorMessage: null as string | null,
}

jest.mock("@/stores/chat", () => ({
  useChatStore: jest.fn((sel: (s: typeof storeState) => unknown) => sel(storeState)),
}))

import { render } from "@testing-library/react"
import { ChatPane } from "./chat-view"
import { MessageList } from "./message-list"
import type { ChatSession, SendContent } from "@/lib/claude/types"

const mockSession = { id: "s1", title: "Test" } as unknown as ChatSession

function makeProps() {
  return {
    activeSession: mockSession,
    onSend: jest.fn(async (_c: SendContent) => {}),
    onStop: jest.fn(async () => {}),
    onRegenerate: jest.fn(async () => {}),
    onEditResend: jest.fn(async (_id: string, _content: SendContent) => {}),
    onCreate: jest.fn(),
    onUseSample: jest.fn(),
    onOpenSettings: jest.fn(),
  }
}

describe("ChatPane", () => {
  it("passes stable onCopy reference across re-renders", () => {
    const MockList = MessageList as jest.Mock
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    const firstOnCopy = MockList.mock.calls[0]?.[0]?.onCopy
    expect(firstOnCopy).toBeDefined()

    MockList.mockClear()
    // Re-render with fresh prop objects — same logical values, new references
    rerender(<ChatPane {...makeProps()} />)
    const secondOnCopy = MockList.mock.calls[0]?.[0]?.onCopy

    // useCallback keeps the same reference when deps haven't changed
    expect(firstOnCopy).toBe(secondOnCopy)
  })

  it("passes stable onRegenerate reference when prop is unchanged", () => {
    // When ChatPane re-renders (e.g. due to store messages update) but the
    // shell-level onRegenerate prop stays the same, handleRegenerate should
    // not change reference so MessageRenderer memo stays effective.
    const MockList = MessageList as jest.Mock
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    const first = MockList.mock.calls[0]?.[0]?.onRegenerate
    MockList.mockClear()
    rerender(<ChatPane {...props} />) // same props — simulates a store update re-render
    const second = MockList.mock.calls[0]?.[0]?.onRegenerate

    expect(first).toBe(second)
  })

  it("passes stable onEditResend reference when prop is unchanged", () => {
    const MockList = MessageList as jest.Mock
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    const first = MockList.mock.calls[0]?.[0]?.onEditResend
    MockList.mockClear()
    rerender(<ChatPane {...props} />)
    const second = MockList.mock.calls[0]?.[0]?.onEditResend

    expect(first).toBe(second)
  })

  it("renders EmptyChatState when activeSession is null", () => {
    const { EmptyChatState } = jest.requireMock("./empty-state") as {
      EmptyChatState: jest.Mock
    }
    EmptyChatState.mockReturnValue(ReactForMocks.createElement("div", { "data-test": "empty" }))
    render(<ChatPane {...makeProps()} activeSession={null} />)
    expect(document.querySelector("[data-test='empty']")).toBeTruthy()
  })

  it("renders EmptyChatState inline when session exists but messages list is empty", () => {
    const savedMessages = storeState.messages
    storeState.messages = []
    const { EmptyChatState } = jest.requireMock("./empty-state") as {
      EmptyChatState: jest.Mock
    }
    EmptyChatState.mockReturnValue(
      ReactForMocks.createElement("div", { "data-test": "empty-inline" })
    )
    render(<ChatPane {...makeProps()} />)
    expect(document.querySelector("[data-test='empty-inline']")).toBeTruthy()
    storeState.messages = savedMessages
  })

  it("onCopy callback invokes handleCopySuccess without throwing", () => {
    const MockList = MessageList as jest.Mock
    MockList.mockClear()
    render(<ChatPane {...makeProps()} />)
    const onCopy = MockList.mock.calls[0]?.[0]?.onCopy as (() => void) | undefined
    expect(onCopy).toBeDefined()
    expect(() => onCopy?.()).not.toThrow()
  })

  it("onRegenerate callback delegates to the prop", async () => {
    const MockList = MessageList as jest.Mock
    MockList.mockClear()
    const props = makeProps()
    render(<ChatPane {...props} />)
    const onRegenerate = MockList.mock.calls[0]?.[0]?.onRegenerate as
      | (() => void | Promise<void>)
      | undefined
    expect(onRegenerate).toBeDefined()
    await onRegenerate?.()
    expect(props.onRegenerate).toHaveBeenCalled()
  })

  it("onEditResend callback delegates to the prop with id and content", async () => {
    const MockList = MessageList as jest.Mock
    MockList.mockClear()
    const props = makeProps()
    render(<ChatPane {...props} />)
    const onEditResend = MockList.mock.calls[0]?.[0]?.onEditResend as
      | ((id: string, content: unknown) => void | Promise<void>)
      | undefined
    expect(onEditResend).toBeDefined()
    await onEditResend?.("msg-1", { text: "edited" })
    expect(props.onEditResend).toHaveBeenCalledWith("msg-1", { text: "edited" })
  })

  describe("showHeader prop", () => {
    it("renders ChatHeader by default", () => {
      const { ChatHeader } = jest.requireMock("./chat-header") as {
        ChatHeader: jest.Mock
      }
      ChatHeader.mockClear()
      render(<ChatPane {...makeProps()} />)
      expect(ChatHeader).toHaveBeenCalled()
    })

    it("omits ChatHeader when showHeader is false", () => {
      const { ChatHeader } = jest.requireMock("./chat-header") as {
        ChatHeader: jest.Mock
      }
      ChatHeader.mockClear()
      render(<ChatPane {...makeProps()} showHeader={false} />)
      expect(ChatHeader).not.toHaveBeenCalled()
    })
  })
})
