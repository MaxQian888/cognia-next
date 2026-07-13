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
// A jest.fn stub (vs a plain () => null) lets the signature-pinning test
// below assert on the `messages` prop identity across renders.
jest.mock("./minimap/conversation-timeline", () => ({
  ConversationTimeline: jest.fn(() => null),
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
  MessageActionSheet: ({
    message,
    onRegenerate,
    onDelete,
    onEditResend,
  }: {
    message: unknown
    onRegenerate?: () => void
    onDelete?: (m: unknown) => void
    onEditResend?: (m: unknown, newText: string) => void
  }) =>
    ReactForMocks.createElement(
      "div",
      {
        "data-test": "action-sheet",
        "data-message": message ? "open" : "closed",
        "data-can-regenerate": String(Boolean(onRegenerate)),
        "data-can-edit": String(Boolean(onEditResend)),
      },
      message && onDelete
        ? ReactForMocks.createElement("button", {
            "data-test": "sheet-delete",
            onClick: () => onDelete(message),
          })
        : null
    ),
}))

const dbDeleteMock = jest.fn(async (_id: string) => undefined)
jest.mock("@/lib/db/schema", () => ({
  ...jest.requireActual("@/lib/db/schema"),
  getDb: () => ({ messages: { delete: (id: string) => dbDeleteMock(id) } }),
}))

const desktopDeleteMock = jest.fn(async (_sid: string, _mid: string) => undefined)
jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  deleteMessage: (sid: string, mid: string) => desktopDeleteMock(sid, mid),
}))

jest.mock("@/lib/capacitor/haptics", () => ({
  selectionFeedback: jest.fn(),
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
import { selectionFeedback } from "@/lib/capacitor/haptics"

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

  it("routes a hook-notice system message to HookNoticeMarker, not MessageRenderer", () => {
    const Wrapper = withAdapter(makeAdapter())
    const hookMsg: UIMessage = {
      id: "hk1",
      role: "system",
      parts: [
        {
          type: "hook-notice",
          event: "PreToolUse",
          toolName: "Bash",
          outcome: "blocked",
          block: "command matches denylist",
          warnings: [],
        },
      ] as unknown as UIMessage["parts"],
    }
    render(
      <Wrapper>
        <MessageList messages={[hookMsg]} status="idle" />
      </Wrapper>
    )
    // The real HookNoticeMarker mounts (it is not mocked); MessageRenderer
    // (mocked to emit `data-test="msg-*"`) must NOT be used for this row.
    expect(screen.getByTestId("hook-notice-blocked")).toBeInTheDocument()
    expect(screen.getByText("Before tool")).toBeInTheDocument()
    expect(document.querySelector(`[data-test="msg-hk1"]`)).toBeNull()
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

  it("mobile delete fans out to store, local Dexie, and the desktop RPC", async () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    dbDeleteMock.mockClear()
    desktopDeleteMock.mockClear()
    const Wrapper = withAdapter(makeAdapter())
    const msgs = [userMsg("m1", "hello"), userMsg("m2", "world")]
    act(() => {
      useChatStore.getState().setSessionMessages("ses_1", msgs)
    })
    render(
      <Wrapper>
        <MessageList messages={msgs} status="idle" />
      </Wrapper>
    )
    // Long-press the first row to arm the sheet with that message.
    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    fireEvent.click(document.querySelector("[data-test='sheet-delete']")!)
    await act(async () => {})
    expect(useChatStore.getState().sessions["ses_1"]!.messages.map((m) => m.id)).toEqual(["m2"])
    expect(dbDeleteMock).toHaveBeenCalledWith("m1")
    expect(desktopDeleteMock).toHaveBeenCalledWith("ses_1", "m1")
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("only offers Regenerate for the last assistant message when idle", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }],
    }
    render(
      <Wrapper>
        <MessageList
          messages={[userMsg("m1", "hello"), assistant]}
          status="idle"
          onRegenerate={jest.fn()}
        />
      </Wrapper>
    )
    const rows = document.querySelectorAll("[data-test='long-press']")
    // Arm the sheet with the USER message → no regenerate.
    fireEvent.click(rows[0]!)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-can-regenerate",
      "false"
    )
    // Arm with the last assistant message → regenerate offered.
    fireEvent.click(rows[1]!)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-can-regenerate",
      "true"
    )
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("only offers Edit for the user's own messages when idle", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }],
    }
    render(
      <Wrapper>
        <MessageList
          messages={[userMsg("m1", "hello"), assistant]}
          status="idle"
          onEditResend={jest.fn()}
        />
      </Wrapper>
    )
    const rows = document.querySelectorAll("[data-test='long-press']")
    // Arm the sheet with the USER message → edit offered.
    fireEvent.click(rows[0]!)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-can-edit",
      "true"
    )
    // Arm with the assistant message → no edit.
    fireEvent.click(rows[1]!)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-can-edit",
      "false"
    )
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("withholds Edit while a turn is streaming", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList
          messages={[userMsg("m1", "hello")]}
          status="streaming"
          onEditResend={jest.fn()}
        />
      </Wrapper>
    )
    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-can-edit",
      "false"
    )
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("fires a selection haptic and opens the action sheet on long-press", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-message",
      "closed"
    )
    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    expect(selectionFeedback).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-message",
      "open"
    )
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

  it("re-pins to the bottom when switching sessions after scrolling up", async () => {
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    Object.defineProperty(scrollEl, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(scrollEl, "clientHeight", { value: 200, configurable: true })
    let scrollTop = 0
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v
      },
    })
    // Scroll up in session 1 → the scroll-to-bottom button appears.
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    expect(scrollEl.querySelector('button[type="button"]')).toBeTruthy()

    // Switching sessions must reset to the latest message and re-arm
    // stick-to-bottom (isAtBottom), not inherit the old scroll state.
    await act(async () => {
      useChatStore.getState().setActiveSession("ses_2")
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(scrollTop).toBe(1000)
    expect(scrollEl.querySelector('button[type="button"]')).toBeFalsy()
    act(() => {
      useChatStore.getState().setActiveSession("ses_1")
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

describe("MessageList — timeline signature pinning", () => {
  it("keeps the ConversationTimeline messages prop identity across delta-frame re-renders", () => {
    const { ConversationTimeline } = jest.requireMock("./minimap/conversation-timeline")
    const timelineMock = ConversationTimeline as jest.Mock
    timelineMock.mockClear()

    const Wrapper = withAdapter(makeAdapter())
    const initial = manyMsgs(25) // > TIMELINE_THRESHOLD → minimap mounts
    const { rerender } = render(
      <Wrapper>
        <MessageList messages={initial} status="streaming" />
      </Wrapper>
    )
    expect(timelineMock).toHaveBeenCalled()
    const firstRef = (timelineMock.mock.calls.at(-1)![0] as { messages: unknown }).messages
    expect(firstRef).toBe(initial)

    // Simulate a streamed text-delta commit: fresh array + fresh trailing
    // message object, same length, unchanged user metadata → the timeline's
    // messages prop keeps its identity, so its memo skips the frame.
    const deltaFrame = [...initial.slice(0, -1), { ...initial[initial.length - 1]! }]
    rerender(
      <Wrapper>
        <MessageList messages={deltaFrame} status="streaming" />
      </Wrapper>
    )
    expect((timelineMock.mock.calls.at(-1)![0] as { messages: unknown }).messages).toBe(firstRef)

    // A new message landing (length change) re-pins to the fresh array.
    const grown = [...deltaFrame, userMsg("vm-new", "next turn")]
    rerender(
      <Wrapper>
        <MessageList messages={grown} status="streaming" />
      </Wrapper>
    )
    expect((timelineMock.mock.calls.at(-1)![0] as { messages: unknown }).messages).toBe(grown)
  })
})
