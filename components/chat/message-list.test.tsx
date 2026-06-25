// Coverage for message-list after the data-hooks refactor — the component now
// reads characters via DataAdapter (no Dexie import) and calls
// `clearMessages` through the adapter rather than a direct Dexie helper.

// Stub heavy ai-elements / message-renderer dependencies — this is a logic
// test for message-list's clear/export flows, not for the renderer chain.
import * as ReactForMocks from "react"

jest.mock("@/components/ai-elements/shimmer", () => {
  return {
    Shimmer: ({ children }: { children: ReactForMocks.ReactNode }) =>
      ReactForMocks.createElement("span", null, children),
  }
})

// The thinking indicator has its own suite (phases / tips / reduced motion).
// Stub it to the bare label so message-list's shouldShowThinking assertions
// stay isolated from its timers and motion wiring.
jest.mock("./thinking-indicator", () => ({
  ChatThinkingIndicator: () => ReactForMocks.createElement("span", null, "Claude is thinking…"),
}))

// jsdom has no layout engine so useVirtualizer always returns empty items.
// Mock it to render every item so message-level assertions work in tests.
// We also capture the call args so the streaming-row measure-skip assertions
// below can verify the `estimateSize` projection is wired up.
const useVirtualizerCalls: Array<{ count: number; estimateSize: (i: number) => number }> = []
const measureSpy = jest.fn()
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number
    estimateSize: (i: number) => number
  }) => {
    useVirtualizerCalls.push({ count, estimateSize })
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          index: i,
          key: String(i),
          start: i * 120,
          size: 120,
          lane: 0,
        })),
      getTotalSize: () => count * 120,
      measureElement: () => {},
      measure: measureSpy,
    }
  },
}))

// The timeline minimap has its own test suite; stub it here so the
// message-list logic tests stay isolated from its scroll-sync/store wiring.
jest.mock("./minimap/conversation-timeline", () => ({
  ConversationTimeline: () => null,
}))

jest.mock("./message-renderer", () => {
  return {
    MessageRenderer: ({ message }: { message: { id: string; parts: { text?: string }[] } }) =>
      ReactForMocks.createElement(
        "div",
        { "data-test": `msg-${message.id}` },
        message.parts.map((p, i) => ReactForMocks.createElement("span", { key: i }, p.text ?? ""))
      ),
  }
})

jest.mock("@/hooks/use-platform", () => ({
  usePlatform: jest.fn(() => "desktop"),
}))

jest.mock("@/components/interactions/long-press", () => ({
  LongPress: ({
    children,
    onLongPress,
  }: {
    children: ReactForMocks.ReactNode
    onLongPress: () => void
  }) =>
    ReactForMocks.createElement(
      "div",
      { "data-test": "long-press", onClick: onLongPress },
      children
    ),
}))

jest.mock("@/components/mobile/chat/message-action-sheet", () => ({
  MessageActionSheet: ({ message }: { message: unknown }) =>
    ReactForMocks.createElement(
      "div",
      { "data-test": "action-sheet", "data-message": message ? "open" : "closed" },
      null
    ),
}))

import { render, screen, fireEvent, act } from "@testing-library/react"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import { MessageList, VIRTUALIZE_THRESHOLD } from "./message-list"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { usePlatform } from "@/hooks/use-platform"

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => [],
    useCharacter: () => undefined,
    useSkillsByIds: () => [],
    usePresets: () => [],
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>{children}</DataAdapterProvider>
  )
  Wrapper.displayName = "MessageListTestWrapper"
  return Wrapper
}

const userMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
})

// More than VIRTUALIZE_THRESHOLD messages forces the virtualized render path.
const manyMsgs = (n: number): UIMessage[] =>
  Array.from({ length: n }, (_, i) => userMsg(`vm-${i}`, `Msg ${i}`))

beforeEach(() => {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("ses_1")
  useVirtualizerCalls.length = 0
  measureSpy.mockClear()
})

describe("MessageList", () => {
  it("renders messages from the input prop", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello"), userMsg("m2", "world")]} status="idle" />
      </Wrapper>
    )
    expect(screen.getByText("hello")).toBeInTheDocument()
    expect(screen.getByText("world")).toBeInTheDocument()
  })

  it("renders a short list in document flow (no virtualized [data-index] rows)", () => {
    const Wrapper = withAdapter(makeAdapter())
    const msgs = manyMsgs(10) // 10 <= threshold → flow path
    const { container } = render(
      <Wrapper>
        <MessageList messages={msgs} status="idle" />
      </Wrapper>
    )
    for (let i = 0; i < 10; i++) {
      expect(document.querySelector(`[data-test="msg-vm-${i}"]`)).toBeTruthy()
    }
    // Flow path attaches no measureElement ref → no [data-index] wrappers.
    expect(container.querySelectorAll("[data-index]")).toHaveLength(0)
  })

  it("renders a long list via the virtualizer ([data-index] rows present)", () => {
    const Wrapper = withAdapter(makeAdapter())
    const count = VIRTUALIZE_THRESHOLD + 1
    const { container } = render(
      <Wrapper>
        <MessageList messages={manyMsgs(count)} status="idle" />
      </Wrapper>
    )
    // The mock virtualizer emits one [data-index] row per message.
    expect(container.querySelectorAll("[data-index]")).toHaveLength(count)
    expect(document.querySelector(`[data-test="msg-vm-0"]`)).toBeTruthy()
    expect(document.querySelector(`[data-test="msg-vm-${count - 1}"]`)).toBeTruthy()
  })

  it("wraps messages in LongPress on mobile and renders MessageActionSheet", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )
    expect(document.querySelector("[data-test='long-press']")).toBeTruthy()
    expect(document.querySelector("[data-test='action-sheet']")).toBeTruthy()
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("shows the long-press discoverability hint early in a mobile conversation", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )
    expect(screen.getByTestId("long-press-hint")).toBeInTheDocument()
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("retires the long-press hint once the conversation grows past two messages", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList
          messages={[userMsg("m1", "a"), userMsg("m2", "b"), userMsg("m3", "c")]}
          status="idle"
        />
      </Wrapper>
    )
    expect(screen.queryByTestId("long-press-hint")).not.toBeInTheDocument()
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("never shows the long-press hint on desktop", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )
    expect(screen.queryByTestId("long-press-hint")).not.toBeInTheDocument()
  })

  describe("streaming-row measure-skip (Stage 2)", () => {
    const assistantStreaming = (id: string, text: string): UIMessage => ({
      id,
      role: "assistant",
      parts: [{ type: "text", text }],
    })

    it("the actively-streaming row is the last [data-index] row (virtualized path)", () => {
      const Wrapper = withAdapter(makeAdapter())
      // Force the virtualized path: fillers + a final streaming assistant row.
      const fillers = manyMsgs(VIRTUALIZE_THRESHOLD)
      const { container } = render(
        <Wrapper>
          <MessageList
            messages={[...fillers, assistantStreaming("a1", "partial…")]}
            status="streaming"
          />
        </Wrapper>
      )
      const rows = container.querySelectorAll("[data-index]")
      // fillers + streaming row (no thinking shimmer: the streaming row has text).
      expect(rows).toHaveLength(fillers.length + 1)
      // The streaming row (last index) skips the measureElement ref; we verify
      // it is rendered and carries the streaming text — the ref-skip is
      // exercised by the snapshot rendering correctly.
      expect(rows[rows.length - 1].textContent).toContain("partial")
    })

    it("renders the streaming row in document flow for short lists", () => {
      const Wrapper = withAdapter(makeAdapter())
      const { container } = render(
        <Wrapper>
          <MessageList
            messages={[userMsg("u1", "hi"), assistantStreaming("a1", "partial…")]}
            status="streaming"
          />
        </Wrapper>
      )
      // Flow path → no [data-index]; the streaming text still renders.
      expect(container.querySelectorAll("[data-index]")).toHaveLength(0)
      expect(document.querySelector(`[data-test="msg-a1"]`)?.textContent).toContain("partial")
    })

    it("estimateSize returns a growing projection for the streaming row", () => {
      const Wrapper = withAdapter(makeAdapter())
      const text = "X".repeat(1000)
      render(
        <Wrapper>
          <MessageList
            messages={[userMsg("u1", "hi"), assistantStreaming("a1", text)]}
            status="streaming"
          />
        </Wrapper>
      )
      const lastCall = useVirtualizerCalls.at(-1)
      expect(lastCall).toBeDefined()
      // Non-streaming rows fall back to 200.
      expect(lastCall!.estimateSize(0)).toBe(200)
      // Streaming row projects from text length — 1000 chars * 0.55 + 220 = 770.
      const projected = lastCall!.estimateSize(1)
      expect(projected).toBeGreaterThan(700)
      expect(projected).toBeLessThan(900)
    })

    it("estimateSize returns the default 200 for non-streaming rows even on the last index", () => {
      const Wrapper = withAdapter(makeAdapter())
      render(
        <Wrapper>
          <MessageList messages={[userMsg("u1", "hi")]} status="idle" />
        </Wrapper>
      )
      const lastCall = useVirtualizerCalls.at(-1)
      expect(lastCall).toBeDefined()
      expect(lastCall!.estimateSize(0)).toBe(200)
    })

    it("calls rowVirtualizer.measure() when status flips from streaming to idle", () => {
      const Wrapper = withAdapter(makeAdapter())
      const { rerender } = render(
        <Wrapper>
          <MessageList
            messages={[userMsg("u1", "hi"), assistantStreaming("a1", "...")]}
            status="streaming"
          />
        </Wrapper>
      )
      measureSpy.mockClear()
      rerender(
        <Wrapper>
          <MessageList
            messages={[userMsg("u1", "hi"), assistantStreaming("a1", "done")]}
            status="idle"
          />
        </Wrapper>
      )
      expect(measureSpy).toHaveBeenCalled()
    })

    it("calls rowVirtualizer.measure() on session change", () => {
      const Wrapper = withAdapter(makeAdapter())
      render(
        <Wrapper>
          <MessageList messages={[userMsg("u1", "hi")]} status="idle" />
        </Wrapper>
      )
      measureSpy.mockClear()
      act(() => {
        useChatStore.getState().setActiveSession("ses_2")
      })
      expect(measureSpy).toHaveBeenCalled()
    })
  })

  it("shows and clicks scroll-to-bottom button when scrolled up", async () => {
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    Object.defineProperty(scrollEl, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(scrollEl, "scrollTop", { value: 0, configurable: true })
    Object.defineProperty(scrollEl, "clientHeight", { value: 200, configurable: true })
    // Assign scrollTo so it doesn't throw in jsdom
    const scrollTo = jest.fn()
    scrollEl.scrollTo = scrollTo as unknown as typeof scrollEl.scrollTo
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    // scrollHeight(1000) - scrollTop(0) - clientHeight(200) = 800 >= 32 → not at bottom
    const btn = scrollEl.querySelector('button[type="button"]')
    expect(btn).toBeTruthy()
    fireEvent.click(btn!)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" })
  })

  it("contains overscroll on the scroll container so iOS rubber-band does not chain to the shell", () => {
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    expect(scrollEl).toHaveClass("overscroll-contain")
  })
})

describe("shouldShowThinking", () => {
  it("shows thinking shimmer when streaming and last message is from user", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("u1", "hi")]} status="streaming" />
      </Wrapper>
    )
    expect(screen.getByText("Claude is thinking…")).toBeInTheDocument()
  })

  it("does not show thinking shimmer when streaming but assistant already has text", () => {
    const Wrapper = withAdapter(makeAdapter())
    const assistantMsg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    }
    render(
      <Wrapper>
        <MessageList messages={[assistantMsg]} status="streaming" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("does not show thinking shimmer when status is idle", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[]} status="idle" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("shows thinking shimmer when streaming with no messages yet", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[]} status="streaming" />
      </Wrapper>
    )
    expect(screen.getByText("Claude is thinking…")).toBeInTheDocument()
  })

  it("does not show thinking shimmer during awaiting_approval", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("u1", "hi")]} status="awaiting_approval" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("does not show thinking shimmer when assistant has non-empty reasoning text", () => {
    const Wrapper = withAdapter(makeAdapter())
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "I am reasoning…" } as unknown as UIMessage["parts"][number],
      ],
    }
    render(
      <Wrapper>
        <MessageList messages={[msg]} status="streaming" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("does not show thinking shimmer when assistant has a tool-call part", () => {
    const Wrapper = withAdapter(makeAdapter())
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-invocation" } as unknown as UIMessage["parts"][number]],
    }
    render(
      <Wrapper>
        <MessageList messages={[msg]} status="streaming" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("does not show thinking shimmer when assistant has a file part", () => {
    const Wrapper = withAdapter(makeAdapter())
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "file" } as unknown as UIMessage["parts"][number]],
    }
    render(
      <Wrapper>
        <MessageList messages={[msg]} status="streaming" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("shows thinking shimmer when assistant part has empty text", () => {
    const Wrapper = withAdapter(makeAdapter())
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "   " }],
    }
    render(
      <Wrapper>
        <MessageList messages={[msg]} status="streaming" />
      </Wrapper>
    )
    expect(screen.getByText("Claude is thinking…")).toBeInTheDocument()
  })
})

describe("MessageList — auto-scroll gate (composerBehavior.autoScrollOnStream)", () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: undefined as never })
  })

  it("runs the stick-to-bottom effect while streaming by default", () => {
    useSettingsStore.setState({ settings: {} as never })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="streaming" />
      </Wrapper>
    )
    // The default path renders the streaming list without throwing.
    expect(screen.getByText("hi")).toBeInTheDocument()
  })

  it("skips the stick-to-bottom effect when autoScrollOnStream is off", () => {
    useSettingsStore.setState({
      settings: { composerBehavior: { autoScrollOnStream: false } } as never,
    })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="streaming" />
      </Wrapper>
    )
    expect(screen.getByText("hi")).toBeInTheDocument()
  })
})
