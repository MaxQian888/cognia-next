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
// Stub it to a bare label so message-list's `thinkingMode` assertions stay
// isolated from its timers and motion wiring. The stub echoes `compact` so the
// tests below can tell the two modes apart.
jest.mock("./thinking-indicator", () => ({
  ChatThinkingIndicator: ({ compact }: { compact?: boolean }) =>
    ReactForMocks.createElement(
      "span",
      { "data-test": "thinking-phase" },
      compact ? "Claude is working…" : "Claude is thinking…"
    ),
}))

// jsdom has no layout engine so useVirtualizer always returns empty items.
// Mock it to render every item so message-level assertions work in tests.
// We also capture the call args so the streaming-row measure-skip assertions
// below can verify the `estimateSize` projection is wired up.
const useVirtualizerCalls: Array<{ count: number; estimateSize: (i: number) => number }> = []
const measureSpy = jest.fn()
const scrollToIndexSpy = jest.fn()
const messageRendererProps: Array<Record<string, unknown>> = []
const messageActionSheetProps: Array<Record<string, unknown>> = []
// One identity for the lifetime of the suite, mutated in place. The real
// `useVirtualizer` hands back a stable instance; a fresh object per render would
// re-run every effect that lists the virtualizer as a dependency, and the
// cleanup of the finalise re-pin effect would cancel its own rAF before the
// frame ever arrived — i.e. the mock would hide the behaviour under test.
const virtualizerMock = {
  count: 0,
  getVirtualItems: () =>
    Array.from({ length: virtualizerMock.count }, (_, i) => ({
      index: i,
      key: String(i),
      start: i * 120,
      size: 120,
      lane: 0,
    })),
  getTotalSize: () => virtualizerMock.count * 120,
  measureElement: () => {},
  measure: measureSpy,
  scrollToIndex: scrollToIndexSpy,
  // Read by the timeline scroll-sync that `ActiveTurnPublisher` runs, to
  // place off-screen turns from the virtualizer's own cache.
  options: { count: 0 },
  measurementsCache: [] as unknown[],
}
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getScrollElement,
    measureElement,
  }: {
    count: number
    estimateSize: (i: number) => number
    getScrollElement: () => Element | null
    measureElement: (el: Element | undefined) => number
  }) => {
    useVirtualizerCalls.push({ count, estimateSize })
    virtualizerMock.count = count
    virtualizerMock.options.count = count
    // The real virtualizer calls these; a mock that only stores them would
    // leave the list's own scroll-element resolution and pixel-rounding
    // untested purely as an artefact of being mocked.
    getScrollElement()
    measureElement(undefined)
    return virtualizerMock
  },
}))

// The timeline minimap has its own test suite; stub it here so the
// message-list logic tests stay isolated from its scroll-sync/store wiring.
// A jest.fn stub (vs a plain () => null) lets the signature-pinning test
// below assert on the `messages` prop identity across renders.
jest.mock("./minimap/conversation-timeline", () => ({
  ConversationTimeline: jest.fn(() => null),
}))

// Capture the shortcut registration instead of driving the real dispatcher.
jest.mock("@/hooks/shortcuts/use-app-shortcut", () => ({
  useAppShortcut: jest.fn(),
}))

jest.mock("./message-renderer", () => {
  return {
    MessageRenderer: (props: {
      message: { id: string; parts: { text?: string }[] }
      projectRoot?: string
      messageDisplay?: unknown
    }) => {
      messageRendererProps.push(props)
      return ReactForMocks.createElement(
        "div",
        { "data-test": `msg-${props.message.id}`, "data-project-root": props.projectRoot },
        props.message.parts.map((p, i) =>
          ReactForMocks.createElement("span", { key: i }, p.text ?? "")
        )
      )
    },
  }
})

jest.mock("@/hooks/use-platform", () => ({
  usePlatform: jest.fn(() => "desktop"),
}))

// The timeline gate measures the PANE, not the viewport. jsdom reports every
// `getBoundingClientRect().width` as 0 and `jest.setup.ts` installs a no-op
// ResizeObserver, so the real hook would pin `paneWidth` at 0 forever and no
// test could ever mount the minimap.
let mockPaneWidth = 1200
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => mockPaneWidth,
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
  MessageActionSheet: (props: {
    message: unknown
    onRegenerate?: () => void
    onDelete?: (m: unknown) => void
    onEditResend?: (m: unknown, newText: string) => void
    onOpenChange?: (next: boolean) => void
    messageMotion?: string
  }) => {
    messageActionSheetProps.push(props)
    return ReactForMocks.createElement(
      "div",
      {
        "data-test": "action-sheet",
        "data-message": props.message ? "open" : "closed",
        "data-can-regenerate": String(Boolean(props.onRegenerate)),
        "data-can-edit": String(Boolean(props.onEditResend)),
      },
      [
        props.message && props.onDelete
          ? ReactForMocks.createElement("button", {
              key: "delete",
              "data-test": "sheet-delete",
              onClick: () => props.onDelete?.(props.message),
            })
          : null,
        ReactForMocks.createElement("button", {
          key: "dismiss",
          "data-test": "sheet-dismiss",
          onClick: () => props.onOpenChange?.(false),
        }),
        props.message && props.onEditResend
          ? ReactForMocks.createElement("button", {
              key: "edit",
              "data-test": "sheet-edit",
              onClick: () => props.onEditResend?.(props.message, "edited text"),
            })
          : null,
      ]
    )
  },
}))

const dbDeleteMock = jest.fn(async (_id: string) => undefined)
jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  deleteStoredMessage: (id: string) => dbDeleteMock(id),
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
import { MessageList, TIMELINE_THRESHOLD, VIRTUALIZE_THRESHOLD } from "./message-list"
import { TIMELINE_MIN_PANE_PX } from "./minimap/timeline-visibility"
import { FALLBACK_ROW_PX } from "@/lib/chat/row-height-estimate"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
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
  messageRendererProps.length = 0
  messageActionSheetProps.length = 0
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

  it("keeps conversation turns inside a centered reading column", () => {
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" />
      </Wrapper>
    )

    const readingColumn = container.querySelector('[data-slot="conversation-reading-column"]')
    expect(readingColumn).toHaveClass("mx-auto", "max-w-[52rem]")
  })

  it("passes the bound conversation root to each message renderer", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello")]} status="idle" projectRoot="/repo" />
      </Wrapper>
    )
    expect(document.querySelector("[data-test='msg-m1']")).toHaveAttribute(
      "data-project-root",
      "/repo"
    )
  })

  // ADR-0127 regression: only the mobile `LongPress` branch forwarded
  // `directCharacter`, so on desktop a 1:1 session's bound voice never reached
  // `ReadAloudButton` (`speaker ?? directCharacter` resolved to null).
  it("forwards directCharacter to MessageRenderer on the desktop branch too", () => {
    const character = { id: "char-1", name: "Nova" } as unknown as NonNullable<
      ReactForMocks.ComponentProps<typeof MessageList>["directCharacter"]
    >
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList
          messages={[userMsg("m1", "hello")]}
          status="idle"
          directCharacter={character}
        />
      </Wrapper>
    )
    expect(messageRendererProps.at(-1)?.directCharacter).toBe(character)
  })

  it("resolves a session presentation override for rows and mobile actions", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList
          messages={[userMsg("m1", "hello")]}
          status="idle"
          messageDisplayOverride={{ preset: "inspector", overrides: { motion: "off" } }}
        />
      </Wrapper>
    )

    expect(messageRendererProps.at(-1)?.messageDisplay).toMatchObject({
      preset: "inspector",
      motion: "off",
    })
    expect(messageActionSheetProps.at(-1)?.messageMotion).toBe("off")
    expect(measureSpy).toHaveBeenCalled()
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
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

  // ADR-0127 §3: a short transcript made of huge messages must virtualize too.
  it("virtualizes a short list whose total text crosses the bytes trigger", () => {
    const Wrapper = withAdapter(makeAdapter())
    // 3 messages × 100 KB = 300 KB > 256 KB, far under the 40-row count trigger.
    const heavy = Array.from({ length: 3 }, (_, i) => userMsg(`hv-${i}`, "x".repeat(100 * 1024)))
    const { container } = render(
      <Wrapper>
        <MessageList messages={heavy} status="idle" />
      </Wrapper>
    )
    expect(container.querySelectorAll("[data-index]")).toHaveLength(3)
  })

  it("keeps a short, light list on the document-flow path (no virtual rows)", () => {
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={manyMsgs(5)} status="idle" />
      </Wrapper>
    )
    expect(container.querySelectorAll("[data-index]")).toHaveLength(0)
    expect(document.querySelector(`[data-test="msg-vm-4"]`)).toBeTruthy()
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

  describe("the live tail (ADR-0138)", () => {
    const assistantStreaming = (id: string, text: string): UIMessage => ({
      id,
      role: "assistant",
      parts: [{ type: "text", text }],
    })

    it("keeps the streaming row and the thinking row out of the virtual list", () => {
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
      // Only settled messages are windowed — the live tail is a real DOM row
      // below the virtual container, not row `count` inside it.
      expect(container.querySelectorAll("[data-index]")).toHaveLength(fillers.length)
      expect(useVirtualizerCalls.at(-1)!.count).toBe(fillers.length)

      const tail = container.querySelector('[data-slot="conversation-live-tail"]')!
      expect(tail).toBeInTheDocument()
      expect(tail.textContent).toContain("partial")
      expect(tail.textContent).toContain("Claude is working…")
      // The tail row is still anchorable, so a search hit on the streaming
      // reply resolves through the DOM path.
      expect(tail.querySelector('[data-msg-id="a1"]')).toBeInTheDocument()
    })

    it("hands the row back to the virtual list when the turn seals", () => {
      const Wrapper = withAdapter(makeAdapter())
      const fillers = manyMsgs(VIRTUALIZE_THRESHOLD)
      const { container, rerender } = render(
        <Wrapper>
          <MessageList
            messages={[...fillers, assistantStreaming("a1", "partial…")]}
            status="streaming"
          />
        </Wrapper>
      )
      expect(useVirtualizerCalls.at(-1)!.count).toBe(fillers.length)

      rerender(
        <Wrapper>
          <MessageList messages={[...fillers, assistantStreaming("a1", "done")]} status="idle" />
        </Wrapper>
      )
      expect(useVirtualizerCalls.at(-1)!.count).toBe(fillers.length + 1)
      const tail = container.querySelector('[data-slot="conversation-live-tail"]')!
      expect(tail.textContent).toBe("")
    })

    it("does not blanket-remeasure every row when the turn seals", () => {
      // The old finalise path threw away every row's measurement to reconcile
      // ONE row's projection. The live tail has no projection: it rejoins
      // carrying measureElement and is measured in that same commit.
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
      expect(measureSpy).not.toHaveBeenCalled()
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
      // Flow path → no [data-index]; the streaming text still renders in place
      // (only the virtualized branch lifts it into the tail region).
      expect(container.querySelectorAll("[data-index]")).toHaveLength(0)
      expect(document.querySelector(`[data-test="msg-a1"]`)?.textContent).toContain("partial")
      const tail = container.querySelector('[data-slot="conversation-live-tail"]')!
      expect(tail.textContent).toContain("Claude is working…")
      expect(tail.querySelector('[data-msg-id="a1"]')).not.toBeInTheDocument()
    })

    it("estimates a row the same way whether or not it is the one streaming", () => {
      const Wrapper = withAdapter(makeAdapter())
      const text = "X".repeat(1000)
      const messages = [userMsg("u1", "hi"), assistantStreaming("a1", text)]
      const { rerender } = render(
        <Wrapper>
          <MessageList messages={messages} status="streaming" />
        </Wrapper>
      )
      const whileStreaming = useVirtualizerCalls.at(-1)!.estimateSize(1)
      rerender(
        <Wrapper>
          <MessageList messages={messages} status="idle" />
        </Wrapper>
      )
      expect(useVirtualizerCalls.at(-1)!.estimateSize(1)).toBe(whileStreaming)
      // Nowhere near the deleted `220 + chars × 0.55` projection (= 770 here):
      // there is no streaming special case left to diverge.
      expect(whileStreaming).toBeLessThan(700)
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
    // Scroll up in session 1 → the jump pill appears.
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    expect(screen.getByTestId("conversation-jump-pill")).toBeInTheDocument()

    // Switching sessions must reset to the latest message and re-arm
    // stick-to-bottom (isAtBottom), not inherit the old scroll state.
    await act(async () => {
      useChatStore.getState().setActiveSession("ses_2")
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(scrollTop).toBe(1000)
    expect(screen.queryByTestId("conversation-jump-pill")).not.toBeInTheDocument()
    act(() => {
      useChatStore.getState().setActiveSession("ses_1")
    })
  })

  it("re-pins to the bottom on finalise when the user is parked at the bottom", async () => {
    // Exercises the estimate→actual reconciliation on the status→idle flip: the
    // just-finalised streaming row is re-measured and, since the user is at the
    // bottom, the view is re-pinned on the next frame.
    const Wrapper = withAdapter(makeAdapter())
    const streaming: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "..." }],
    }
    const { container, rerender } = render(
      <Wrapper>
        <MessageList messages={[userMsg("u1", "hi"), streaming]} status="streaming" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    Object.defineProperty(scrollEl, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(scrollEl, "clientHeight", { value: 200, configurable: true })
    const box = { scrollTop: 0 }
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => box.scrollTop,
      set: (v: number) => {
        box.scrollTop = v
      },
    })
    const done: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] }
    await act(async () => {
      rerender(
        <Wrapper>
          <MessageList messages={[userMsg("u1", "hi"), done]} status="idle" />
        </Wrapper>
      )
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(box.scrollTop).toBe(1000)
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
    const btn = screen.getByTestId("conversation-jump-pill")
    // The pill must live OUTSIDE the scroll container. As a child of the
    // scroller it is part of the scrollable content, so it is positioned
    // against the unscrolled box and scrolls away with the messages — i.e. it
    // vanishes exactly when `!isAtBottom` makes it render. jsdom has no layout,
    // so this containment check is the only unit-level guard; the e2e spec
    // pins the visual result.
    expect(scrollEl.contains(btn)).toBe(false)
    fireEvent.click(btn)
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

describe("thinkingMode", () => {
  const renderList = (
    messages: UIMessage[],
    status: "idle" | "streaming" | "awaiting_approval"
  ) => {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <MessageList messages={messages} status={status} />
      </Wrapper>
    )
  }
  /** The stub renders exactly one of these; neither ⇒ indicator hidden. */
  const full = () => screen.queryByText("Claude is thinking…")
  const compact = () => screen.queryByText("Claude is working…")

  it("shows the full indicator when streaming and last message is from user", () => {
    renderList([userMsg("u1", "hi")], "streaming")
    expect(full()).toBeInTheDocument()
    expect(compact()).toBeNull()
  })

  it("shows the full indicator when streaming with no messages yet", () => {
    renderList([], "streaming")
    expect(full()).toBeInTheDocument()
  })

  it("shows the full indicator when the assistant part is only whitespace", () => {
    const msg: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "   " }] }
    renderList([msg], "streaming")
    expect(full()).toBeInTheDocument()
  })

  it("hides the indicator when status is idle", () => {
    renderList([], "idle")
    expect(full()).toBeNull()
    expect(compact()).toBeNull()
  })

  it("hides the indicator during awaiting_approval (the dialog is the feedback)", () => {
    renderList([userMsg("u1", "hi")], "awaiting_approval")
    expect(full()).toBeNull()
    expect(compact()).toBeNull()
  })

  // The regression this whole mode split exists for: an agentic turn is mostly
  // tool calls, and the indicator used to vanish at the first one — leaving
  // minutes of a live run with no sign of life.
  it("keeps a compact indicator while a tool call is on screen and the turn runs", () => {
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-invocation" } as unknown as UIMessage["parts"][number]],
    }
    renderList([msg], "streaming")
    expect(compact()).toBeInTheDocument()
    expect(full()).toBeNull()
  })

  it("keeps a compact indicator once the assistant has streamed text", () => {
    const msg: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] }
    renderList([msg], "streaming")
    expect(compact()).toBeInTheDocument()
    expect(full()).toBeNull()
  })

  it("keeps a compact indicator once the assistant has reasoning text", () => {
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "I am reasoning…" } as unknown as UIMessage["parts"][number],
      ],
    }
    renderList([msg], "streaming")
    expect(compact()).toBeInTheDocument()
  })

  it("keeps a compact indicator once the assistant has a file part", () => {
    const msg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "file" } as unknown as UIMessage["parts"][number]],
    }
    renderList([msg], "streaming")
    expect(compact()).toBeInTheDocument()
  })

  it("drops the indicator entirely once the turn settles to idle", () => {
    const msg: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] }
    renderList([msg], "idle")
    expect(full()).toBeNull()
    expect(compact()).toBeNull()
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

  it("skips the finalise re-pin when autoScrollOnStream is off", async () => {
    useSettingsStore.setState({
      settings: { composerBehavior: { autoScrollOnStream: false } } as never,
    })
    const Wrapper = withAdapter(makeAdapter())
    const streaming: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "..." }],
    }
    const { rerender } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi"), streaming]} status="streaming" />
      </Wrapper>
    )
    const done: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] }
    await act(async () => {
      rerender(
        <Wrapper>
          <MessageList messages={[userMsg("m1", "hi"), done]} status="idle" />
        </Wrapper>
      )
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    // The finalise effect's `!enabled` guard short-circuits (no throw / pin).
    expect(screen.getByText("done")).toBeInTheDocument()
  })
})

describe("MessageList — content-resize follow (deferred markdown growth)", () => {
  const RealResizeObserver = globalThis.ResizeObserver
  let observers: { cb: ResizeObserverCallback; target: Element | null }[]

  beforeEach(() => {
    observers = []
    class CapturingResizeObserver {
      private entry: { cb: ResizeObserverCallback; target: Element | null }
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, target: null }
        observers.push(this.entry)
      }
      observe(el: Element) {
        this.entry.target = el
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = RealResizeObserver
    useSettingsStore.setState({ settings: undefined as never })
  })

  // scrollHeight is stable; scrollTop is a closure-backed getter/setter so the
  // component's programmatic pin is observable. clientHeight decides isAtBottom.
  function primeScroll(el: Element): { get scrollTop(): number } {
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(el, "clientHeight", { value: 200, configurable: true })
    let top = 0
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v
      },
    })
    return {
      get scrollTop() {
        return top
      },
    }
  }

  // The content observer watches the inner content box; the viewport observer
  // watches the scroll container (role="log"). Fire them separately so a test
  // can model deferred content growth vs a viewport resize (dock toggle / drag
  // / window resize) independently.
  const isViewport = (el: Element | null) =>
    el instanceof Element && el.getAttribute("role") === "log"
  const fireResize = () =>
    act(() => {
      observers.filter((o) => !isViewport(o.target)).forEach((o) => o.cb([], {} as ResizeObserver))
    })
  const fireViewportResize = () =>
    act(() => {
      observers.filter((o) => isViewport(o.target)).forEach((o) => o.cb([], {} as ResizeObserver))
    })

  it("re-pins to the bottom when the content box grows after a streamed commit", () => {
    // Reproduces the deferred-markdown gap: `messages` did NOT change (so the
    // messages-effect never re-fires), but the visible DOM grew — the observer
    // must still follow the bottom.
    useSettingsStore.setState({ settings: {} as never })
    const Wrapper = withAdapter(makeAdapter())
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
    }
    const { container } = render(
      <Wrapper>
        <MessageList messages={[assistant]} status="streaming" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const scroll = primeScroll(scrollEl)
    expect(observers.length).toBeGreaterThan(0)
    // Default isAtBottom = true → the observer pins to scrollHeight.
    fireResize()
    expect(scroll.scrollTop).toBe(1000)
  })

  it("does not follow on resize once the user has scrolled up", async () => {
    useSettingsStore.setState({ settings: {} as never })
    const Wrapper = withAdapter(makeAdapter())
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
    }
    const { container } = render(
      <Wrapper>
        <MessageList messages={[assistant]} status="streaming" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const scroll = primeScroll(scrollEl)
    // scrollHeight(1000) - scrollTop(0) - clientHeight(200) = 800 ≥ 32 → not at bottom.
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    // The jump pill proves isAtBottom flipped to false.
    expect(screen.getByTestId("conversation-jump-pill")).toBeInTheDocument()
    fireResize()
    expect(scroll.scrollTop).toBe(0)
  })

  it("does not follow on resize when autoScrollOnStream is disabled", () => {
    useSettingsStore.setState({
      settings: { composerBehavior: { autoScrollOnStream: false } } as never,
    })
    const Wrapper = withAdapter(makeAdapter())
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
    }
    const { container } = render(
      <Wrapper>
        <MessageList messages={[assistant]} status="streaming" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const scroll = primeScroll(scrollEl)
    fireResize()
    expect(scroll.scrollTop).toBe(0)
  })

  it("does not follow on resize when idle (no active turn)", () => {
    useSettingsStore.setState({ settings: {} as never })
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const scroll = primeScroll(scrollEl)
    fireResize()
    expect(scroll.scrollTop).toBe(0)
  })

  it("re-pins to the bottom on a viewport resize while idle (dock toggle / drag / window resize)", () => {
    // B fix: resizing the scroll viewport — dragging the artifact dock divider,
    // toggling it with Cmd/Ctrl+J, or resizing the window — rewraps text taller,
    // so a user parked at the bottom drifts up. The viewport observer re-pins
    // even when idle, dropping the `active` gate the content observer keeps.
    useSettingsStore.setState({ settings: {} as never })
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const scroll = primeScroll(scrollEl)
    fireViewportResize()
    expect(scroll.scrollTop).toBe(1000)
  })

  it("does not re-pin on a viewport resize once the user has scrolled up", async () => {
    useSettingsStore.setState({ settings: {} as never })
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const scroll = primeScroll(scrollEl)
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    fireViewportResize()
    expect(scroll.scrollTop).toBe(0)
  })

  it("does not re-pin on a viewport resize when autoScrollOnStream is disabled", () => {
    useSettingsStore.setState({
      settings: { composerBehavior: { autoScrollOnStream: false } } as never,
    })
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const scroll = primeScroll(scrollEl)
    fireViewportResize()
    expect(scroll.scrollTop).toBe(0)
  })
})

describe("MessageList — find-in-conversation wiring", () => {
  const searchShortcut = () => {
    const call = (useAppShortcut as jest.Mock).mock.calls.findLast(
      (c) => c[0] === "chat.search.toggle"
    )
    return call?.[1] as ((event: KeyboardEvent) => void) | undefined
  }

  const renderWith = (messages: UIMessage[]) => {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <MessageList messages={messages} status="idle" />
      </Wrapper>
    )
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: {} as never })
    ;(useAppShortcut as jest.Mock).mockClear()
  })

  it("registers the search toggle against a real catalog id", () => {
    renderWith(manyMsgs(3))
    expect(searchShortcut()).toBeDefined()
    expect(getAppShortcutDescriptor("chat.search.toggle")).toBeDefined()
  })

  it("an unfocused split pane does not register the chat shortcuts", () => {
    // Shortcut ids are global and the runtime keeps only the last registration
    // per id — so a second, unfocused MessageList would silently swallow Ctrl+F
    // from the focused pane.
    useChatStore.getState().setActiveSession("ses_1")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={manyMsgs(3)} status="idle" paneSessionId="ses_other" />
      </Wrapper>
    )
    const opts = (useAppShortcut as jest.Mock).mock.calls.findLast(
      (c) => c[0] === "chat.search.toggle"
    )?.[2]
    expect(opts).toMatchObject({ enabled: false })
  })

  it("the focused pane owns the chat shortcuts", () => {
    useChatStore.getState().setActiveSession("ses_1")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={manyMsgs(3)} status="idle" paneSessionId="ses_1" />
      </Wrapper>
    )
    const opts = (useAppShortcut as jest.Mock).mock.calls.findLast(
      (c) => c[0] === "chat.search.toggle"
    )?.[2]
    expect(opts).toMatchObject({ enabled: true })
  })

  it("the shortcut opens the bar, and firing it again closes it", () => {
    renderWith(manyMsgs(3))
    expect(screen.queryByTestId("message-search-bar")).not.toBeInTheDocument()

    act(() => searchShortcut()!(new KeyboardEvent("keydown")))
    expect(screen.getByTestId("message-search-bar")).toBeInTheDocument()

    act(() => searchShortcut()!(new KeyboardEvent("keydown")))
    expect(screen.queryByTestId("message-search-bar")).not.toBeInTheDocument()
  })

  it("rings the matched row and moves the ring on to the next hit", () => {
    // Document-flow path (3 messages ≤ VIRTUALIZE_THRESHOLD), so the rows are
    // real DOM nodes carrying data-msg-id.
    const { container } = renderWith([
      userMsg("vm-0", "deploy the worker"),
      userMsg("vm-1", "unrelated"),
      userMsg("vm-2", "deploy again"),
    ])
    act(() => searchShortcut()!(new KeyboardEvent("keydown")))
    fireEvent.change(screen.getByTestId("message-search-bar").querySelector("input")!, {
      target: { value: "deploy" },
    })
    expect(container.querySelector("[data-search-hit]")).toHaveAttribute("data-msg-id", "vm-0")

    fireEvent.keyDown(screen.getByTestId("message-search-bar").querySelector("input")!, {
      key: "Enter",
    })
    expect(container.querySelectorAll("[data-search-hit]")).toHaveLength(1)
    expect(container.querySelector("[data-search-hit]")).toHaveAttribute("data-msg-id", "vm-2")
  })

  it("losing pane focus closes the bar and drops the ring", () => {
    // Without the effect this guards, an unfocused split pane would keep a find
    // bar open behind the user's back — and mounting already-false would hide it.
    useChatStore.getState().setActiveSession("ses_1")
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList
          messages={[userMsg("vm-0", "deploy the worker")]}
          status="idle"
          paneSessionId="ses_1"
        />
      </Wrapper>
    )
    act(() => searchShortcut()!(new KeyboardEvent("keydown")))
    fireEvent.change(screen.getByTestId("message-search-bar").querySelector("input")!, {
      target: { value: "deploy" },
    })
    expect(container.querySelector("[data-search-hit]")).not.toBeNull()

    act(() => useChatStore.getState().setActiveSession("ses_2"))
    expect(screen.queryByTestId("message-search-bar")).not.toBeInTheDocument()
    expect(container.querySelector("[data-search-hit]")).toBeNull()
  })

  it("jumps via the virtualizer on a long conversation", () => {
    // The virtualized branch of jumpToHit: past VIRTUALIZE_THRESHOLD most rows
    // have no DOM node, so a querySelector jump would silently no-op.
    scrollToIndexSpy.mockClear()
    renderWith(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    act(() => searchShortcut()!(new KeyboardEvent("keydown")))
    fireEvent.change(screen.getByTestId("message-search-bar").querySelector("input")!, {
      target: { value: "Msg 3" },
    })
    // "Msg 3" also prefixes "Msg 30".."Msg 39"; the first hit is index 3.
    expect(scrollToIndexSpy).toHaveBeenCalledWith(3, { align: "center" })
  })

  it("closing the bar drops the ring", () => {
    const { container } = renderWith([userMsg("vm-0", "deploy the worker")])
    act(() => searchShortcut()!(new KeyboardEvent("keydown")))
    fireEvent.change(screen.getByTestId("message-search-bar").querySelector("input")!, {
      target: { value: "deploy" },
    })
    expect(container.querySelector("[data-search-hit]")).not.toBeNull()

    act(() => searchShortcut()!(new KeyboardEvent("keydown")))
    expect(container.querySelector("[data-search-hit]")).toBeNull()
  })
})

describe("MessageList — timeline mount gating", () => {
  const timelineMock = () =>
    jest.requireMock("./minimap/conversation-timeline").ConversationTimeline as jest.Mock

  const renderWith = (n: number) => {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <MessageList messages={manyMsgs(n)} status="idle" />
      </Wrapper>
    )
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: {} as never })
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
    mockPaneWidth = 1200
    timelineMock().mockClear()
  })

  // These cases drive the gates off shared module state (settings store +
  // platform mock), so hand them back at the defaults the later suites assume.
  afterEach(() => {
    act(() => {
      useSettingsStore.setState({ settings: {} as never })
    })
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
    mockPaneWidth = 1200
  })

  it("stays unmounted at or below TIMELINE_THRESHOLD", () => {
    renderWith(TIMELINE_THRESHOLD)
    expect(timelineMock()).not.toHaveBeenCalled()
  })

  it("mounts one message past TIMELINE_THRESHOLD", () => {
    renderWith(TIMELINE_THRESHOLD + 1)
    expect(timelineMock()).toHaveBeenCalled()
  })

  it("stays unmounted on mobile regardless of length", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    renderWith(TIMELINE_THRESHOLD + 20)
    expect(timelineMock()).not.toHaveBeenCalled()
  })

  // The Inbox detail pane is 56% of the window (40% at its floor), so a wide
  // window is no evidence the pane can host a 256px panel.
  it("stays unmounted when the pane is narrower than TIMELINE_MIN_PANE_PX", () => {
    mockPaneWidth = TIMELINE_MIN_PANE_PX - 1
    renderWith(TIMELINE_THRESHOLD + 20)
    expect(timelineMock()).not.toHaveBeenCalled()
  })

  it("mounts once the pane reaches TIMELINE_MIN_PANE_PX", () => {
    mockPaneWidth = TIMELINE_MIN_PANE_PX
    renderWith(TIMELINE_THRESHOLD + 20)
    expect(timelineMock()).toHaveBeenCalled()
  })

  it("stays unmounted while the pane is still unmeasured", () => {
    mockPaneWidth = 0
    renderWith(TIMELINE_THRESHOLD + 20)
    expect(timelineMock()).not.toHaveBeenCalled()
  })

  it("stays unmounted when disabled in settings", () => {
    useSettingsStore.setState({
      settings: { conversationTimeline: { enabled: false } } as never,
    })
    renderWith(TIMELINE_THRESHOLD + 20)
    expect(timelineMock()).not.toHaveBeenCalled()
  })

  it("hands the timeline its shortcut ownership", () => {
    // The unfocused split pane's timeline must not register the anchor chords —
    // shortcut ids are global and last-registration-wins.
    useChatStore.getState().setActiveSession("ses_1")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList
          messages={manyMsgs(TIMELINE_THRESHOLD + 1)}
          status="idle"
          paneSessionId="ses_other"
        />
      </Wrapper>
    )
    expect(timelineMock().mock.calls.at(-1)![0]).toMatchObject({ shortcutsEnabled: false })
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

describe("MessageList — the published jumpToMessage contract", () => {
  const jump = () => useChatViewportStore.getState().jumpToMessage!

  const renderMessages = (messages: UIMessage[]) => {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <MessageList messages={messages} status="idle" />
      </Wrapper>
    )
  }

  beforeEach(() => {
    scrollToIndexSpy.mockClear()
  })

  it("tags virtualized rows with data-msg-id, not just data-index", () => {
    // The DOM anchor used to exist on the document-flow branch only, so every
    // id-based jump went silent the moment a conversation crossed the
    // virtualization threshold.
    const { container } = renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    const rows = container.querySelectorAll("[data-index][data-msg-id]")
    expect(rows.length).toBeGreaterThan(0)
    expect(container.querySelector('[data-msg-id="vm-3"]')).not.toBeNull()
  })

  it("passes the caller's align through to the virtualizer", () => {
    renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    // A timeline anchor is the user's own question: it must land at the top so
    // the reply reads downwards from it.
    act(() => {
      expect(jump()("vm-5", 5, { align: "start" })).toBe(true)
    })
    expect(scrollToIndexSpy).toHaveBeenCalledWith(5, { align: "start" })
  })

  it("defaults to centring when the caller states no intent", () => {
    renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    act(() => {
      jump()("vm-5", 5)
    })
    expect(scrollToIndexSpy).toHaveBeenCalledWith(5, { align: "center" })
  })

  it("resolves the row index by id when the caller has none", () => {
    renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    act(() => {
      expect(jump()("vm-7")).toBe(true)
    })
    expect(scrollToIndexSpy).toHaveBeenCalledWith(7, { align: "center" })
  })

  it("reports failure for a message that is not in this conversation", () => {
    // Compacted away, or owned by another session. This was a silent no-op, so
    // "go to source" looked broken rather than inapplicable.
    renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    act(() => {
      expect(jump()("no-such-message")).toBe(false)
    })
    expect(scrollToIndexSpy).not.toHaveBeenCalled()
  })

  it("scrolls the real node on a document-flow list", () => {
    const { container } = renderMessages([userMsg("vm-0", "a"), userMsg("vm-1", "b")])
    const node = container.querySelector<HTMLElement>('[data-msg-id="vm-1"]')!
    const scrollIntoView = jest.fn()
    node.scrollIntoView = scrollIntoView

    act(() => {
      expect(jump()("vm-1", undefined, { align: "start" })).toBe(true)
    })
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
    // Short lists never virtualize, so the virtualizer must stay out of it.
    expect(scrollToIndexSpy).not.toHaveBeenCalled()
  })

  it("reports failure on a document-flow list when the id is unknown", () => {
    renderMessages([userMsg("vm-0", "a")])
    act(() => {
      expect(jump()("ghost")).toBe(false)
    })
  })

  it("marks the row it landed on", () => {
    // Scrolling with no landing mark is indistinguishable from scrolling to the
    // wrong place, which is the failure mode a long, repetitive conversation
    // makes most likely.
    const { container } = renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    expect(container.querySelector('[data-testid="jump-flash"]')).toBeNull()

    act(() => {
      jump()("vm-5", 5, { align: "start" })
    })
    const row = container.querySelector('[data-msg-id="vm-5"]')!
    expect(row.querySelector('[data-testid="jump-flash"]')).not.toBeNull()
    // Exactly one row is ever marked.
    expect(container.querySelectorAll('[data-testid="jump-flash"]')).toHaveLength(1)
  })

  it("moves the mark when a second jump lands elsewhere", () => {
    const { container } = renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    act(() => {
      jump()("vm-5", 5)
    })
    act(() => {
      jump()("vm-9", 9)
    })
    expect(
      container.querySelector('[data-msg-id="vm-5"]')!.querySelector('[data-testid="jump-flash"]')
    ).toBeNull()
    expect(
      container.querySelector('[data-msg-id="vm-9"]')!.querySelector('[data-testid="jump-flash"]')
    ).not.toBeNull()
  })

  it("does not mark anything when the jump failed", () => {
    const { container } = renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    act(() => {
      jump()("no-such-message")
    })
    expect(container.querySelector('[data-testid="jump-flash"]')).toBeNull()
  })

  it("re-marks the same row on a repeat jump", () => {
    const { container } = renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    act(() => {
      jump()("vm-5", 5)
    })
    const first = container
      .querySelector('[data-testid="jump-flash"]')!
      .getAttribute("data-jump-flash-nonce")

    act(() => {
      jump()("vm-5", 5)
    })
    // Same id, so only the nonce can tell the second jump apart — and without
    // it the repeat (which is what a user does when unsure it worked) is silent.
    expect(
      container.querySelector('[data-testid="jump-flash"]')!.getAttribute("data-jump-flash-nonce")
    ).not.toBe(first)
  })
})

describe("MessageList — the floating jump offer", () => {
  /** Give the scroll container measurable geometry jsdom otherwise lacks. */
  function primeScroller(el: Element, opts: { scrollHeight?: number; clientHeight?: number } = {}) {
    Object.defineProperty(el, "scrollHeight", {
      value: opts.scrollHeight ?? 1000,
      configurable: true,
    })
    Object.defineProperty(el, "clientHeight", {
      value: opts.clientHeight ?? 200,
      configurable: true,
    })
    const box = { top: 0 }
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => box.top,
      set: (v: number) => {
        box.top = v
      },
    })
    const scrollTo = jest.fn((arg: { top: number }) => {
      box.top = arg.top
    })
    ;(el as HTMLElement).scrollTo = scrollTo as unknown as HTMLElement["scrollTo"]
    return { box, scrollTo }
  }

  const renderMessages = (messages: UIMessage[]) => {
    const Wrapper = withAdapter(makeAdapter())
    const view = render(
      <Wrapper>
        <MessageList messages={messages} status="idle" />
      </Wrapper>
    )
    return { ...view, Wrapper }
  }

  const mode = () => screen.queryByTestId("conversation-jump-pill")?.getAttribute("data-mode")

  it("offers the way back after a jump, and returns to the exact offset", async () => {
    const { container } = renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
    const scrollEl = container.querySelector('[role="log"]')!
    const { box, scrollTo } = primeScroller(scrollEl)

    // The user is reading at 640px in.
    box.top = 640
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    expect(mode()).toBe("toBottom")

    act(() => {
      useChatViewportStore.getState().jumpToMessage!("vm-2", 2, { align: "start" })
    })
    expect(mode()).toBe("return")

    fireEvent.click(screen.getByTestId("conversation-jump-pill"))
    expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: "smooth" })
    // Single-use: having gone back, there is nothing left to go back to.
    expect(mode()).not.toBe("return")
  })

  it("withdraws the return offer once the user scrolls under their own steam", async () => {
    // Choosing a new place to be is a decision; the old place stops mattering.
    const nowSpy = jest.spyOn(Date, "now")
    try {
      nowSpy.mockReturnValue(1_000_000)
      const { container } = renderMessages(manyMsgs(VIRTUALIZE_THRESHOLD + 2))
      const scrollEl = container.querySelector('[role="log"]')!
      const { box } = primeScroller(scrollEl)
      box.top = 500
      await act(async () => {
        fireEvent.scroll(scrollEl)
      })

      act(() => {
        useChatViewportStore.getState().jumpToMessage!("vm-2", 2)
      })
      expect(mode()).toBe("return")

      // The jump's own smooth scroll and the virtualizer's re-target passes
      // emit scroll events too, so they are fenced off by time.
      await act(async () => {
        fireEvent.scroll(scrollEl)
      })
      expect(mode()).toBe("return")

      nowSpy.mockReturnValue(1_000_000 + 5000)
      await act(async () => {
        fireEvent.scroll(scrollEl)
      })
      expect(mode()).toBe("toBottom")
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("counts replies that landed while the user was reading further up", async () => {
    const initial = manyMsgs(VIRTUALIZE_THRESHOLD + 2)
    const Wrapper = withAdapter(makeAdapter())
    const { container, rerender } = render(
      <Wrapper>
        <MessageList messages={initial} status="idle" />
      </Wrapper>
    )
    const scrollEl = container.querySelector('[role="log"]')!
    const { box } = primeScroller(scrollEl)

    box.top = 300
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    expect(mode()).toBe("toBottom")

    const grown = [...initial, userMsg("vm-new-1", "one"), userMsg("vm-new-2", "two")]
    await act(async () => {
      rerender(
        <Wrapper>
          <MessageList messages={grown} status="idle" />
        </Wrapper>
      )
    })
    expect(mode()).toBe("newMessages")
    // Real next-intl in this suite, so this also pins the ICU plural.
    expect(screen.getByTestId("conversation-jump-pill")).toHaveAttribute(
      "aria-label",
      "2 new messages"
    )

    // Returning to the bottom means they have been seen.
    box.top = 800
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    expect(mode()).toBeUndefined()
  })

  it("does not count messages that arrived before the user scrolled up", async () => {
    // The baseline is taken when they leave the bottom, not at mount — the
    // whole backlog is not "new".
    const initial = manyMsgs(VIRTUALIZE_THRESHOLD + 2)
    const { container } = renderMessages(initial)
    const scrollEl = container.querySelector('[role="log"]')!
    const { box } = primeScroller(scrollEl)

    box.top = 300
    await act(async () => {
      fireEvent.scroll(scrollEl)
    })
    expect(mode()).toBe("toBottom")
  })
})

describe("MessageList — best-effort paths that must not surface as failures", () => {
  const msgs = [userMsg("m1", "hello"), userMsg("m2", "world")]

  const renderMobile = () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const Wrapper = withAdapter(makeAdapter())
    act(() => {
      useChatStore.getState().setSessionMessages("ses_1", msgs)
    })
    return render(
      <Wrapper>
        <MessageList messages={msgs} status="idle" />
      </Wrapper>
    )
  }

  afterEach(() => {
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })

  it("still removes the message when the local Dexie mirror rejects", async () => {
    // The row may never have been persisted. The store removal above it has
    // already updated what the user sees, so a mirror miss is not a failure.
    dbDeleteMock.mockRejectedValueOnce(new Error("no such row"))
    desktopDeleteMock.mockClear()
    renderMobile()

    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    fireEvent.click(document.querySelector("[data-test='sheet-delete']")!)
    await act(async () => {})

    expect(useChatStore.getState().sessions["ses_1"]!.messages.map((m) => m.id)).toEqual(["m2"])
    // The desktop leg still runs — one failing leg must not short-circuit the fan-out.
    expect(desktopDeleteMock).toHaveBeenCalledWith("ses_1", "m1")
  })

  it("still removes the message when the desktop is unreachable", async () => {
    // Standalone mode / offline phone. Sync-down reconciles the missed delete
    // later; blocking the local removal on it would strand the user.
    desktopDeleteMock.mockRejectedValueOnce(new Error("no desktop"))
    renderMobile()

    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    fireEvent.click(document.querySelector("[data-test='sheet-delete']")!)
    await act(async () => {})

    expect(useChatStore.getState().sessions["ses_1"]!.messages.map((m) => m.id)).toEqual(["m2"])
  })

  it("disarms the action sheet when it is dismissed", () => {
    renderMobile()
    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-message",
      "open"
    )

    fireEvent.click(document.querySelector("[data-test='sheet-dismiss']")!)
    expect(document.querySelector("[data-test='action-sheet']")).toHaveAttribute(
      "data-message",
      "closed"
    )
  })
})

describe("MessageList — closing the find bar from the bar itself", () => {
  const toggleSearch = () =>
    (useAppShortcut as jest.Mock).mock.calls.findLast((c) => c[0] === "chat.search.toggle")?.[1] as
      ((event: KeyboardEvent) => void) | undefined

  it("drops the ring when the bar closes itself", () => {
    // The chord path toggles; this is the bar's own close button, which is a
    // separate callback and the one a mouse user actually reaches.
    const Wrapper = withAdapter(makeAdapter())
    const { container } = render(
      <Wrapper>
        <MessageList messages={[userMsg("vm-0", "deploy the worker")]} status="idle" />
      </Wrapper>
    )
    act(() => toggleSearch()!(new KeyboardEvent("keydown")))
    fireEvent.change(screen.getByTestId("message-search-bar").querySelector("input")!, {
      target: { value: "deploy" },
    })
    expect(container.querySelector("[data-search-hit]")).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Close search" }))
    expect(screen.queryByTestId("message-search-bar")).not.toBeInTheDocument()
    expect(container.querySelector("[data-search-hit]")).toBeNull()
  })
})

describe("MessageList — system rows render as markers, not as messages", () => {
  const systemRow = (id: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ id, role: "system", parts: [{ type, ...extra }] }) as unknown as UIMessage

  const renderRows = (messages: UIMessage[]) => {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <MessageList messages={messages} status="idle" />
      </Wrapper>
    )
  }

  it("renders a compaction boundary as its own marker", () => {
    // These carry no author and no body; putting them through MessageRenderer
    // would draw an empty avatarised bubble.
    const { container } = renderRows([
      userMsg("m1", "before"),
      systemRow("cb1", "compact-boundary", { at: 1_700_000_000_000 }),
      userMsg("m2", "after"),
    ])
    expect(container.querySelector("[data-test='msg-cb1']")).toBeNull()
    expect(container.querySelector("[data-test='msg-m1']")).not.toBeNull()
  })

  it("renders a session notice as its own marker", () => {
    const { container } = renderRows([
      systemRow("sn1", "session-notice", { kind: "resumed" }),
      userMsg("m1", "after"),
    ])
    expect(container.querySelector("[data-test='msg-sn1']")).toBeNull()
    expect(container.querySelector("[data-test='msg-m1']")).not.toBeNull()
  })
})

describe("MessageList — the live tail carries real height, not a projection", () => {
  const streamingWith = (parts: unknown[]): UIMessage =>
    ({ id: "a-stream", role: "assistant", parts }) as unknown as UIMessage

  it("keeps a reasoning-heavy streaming row out of the virtualizer entirely", () => {
    // A long reasoning block is real height on screen. It used to be fed into a
    // `220 + chars × 0.55` projection because the row carried no measureElement
    // ref; now the row renders in document flow and the browser owns its height,
    // so the virtualizer is never asked about it at all.
    const Wrapper = withAdapter(makeAdapter())
    const fillers = manyMsgs(VIRTUALIZE_THRESHOLD)
    const { container } = render(
      <Wrapper>
        <MessageList
          messages={[...fillers, streamingWith([{ type: "reasoning", text: "r".repeat(1000) }])]}
          status="streaming"
        />
      </Wrapper>
    )

    expect(useVirtualizerCalls.at(-1)!.count).toBe(fillers.length)
    const tail = container.querySelector('[data-slot="conversation-live-tail"]')!
    expect(tail.querySelector('[data-msg-id="a-stream"]')).toBeInTheDocument()
  })

  it("changes no estimate the virtualizer is given as the streamed text grows", () => {
    // This is the property the whole live-tail split exists to guarantee: the
    // windowed geometry — and therefore `getTotalSize()`, and therefore the
    // `scrollHeight` the auto-scroll pins against — is a function of settled
    // messages only, so it cannot breathe with every token.
    const Wrapper = withAdapter(makeAdapter())
    const fillers = manyMsgs(VIRTUALIZE_THRESHOLD)
    const { rerender } = render(
      <Wrapper>
        <MessageList
          messages={[...fillers, streamingWith([{ type: "text", text: "x".repeat(100) }])]}
          status="streaming"
        />
      </Wrapper>
    )
    const before = useVirtualizerCalls.at(-1)!
    const beforeSizes = fillers.map((_, index) => before.estimateSize(index))

    rerender(
      <Wrapper>
        <MessageList
          messages={[...fillers, streamingWith([{ type: "text", text: "x".repeat(5000) }])]}
          status="streaming"
        />
      </Wrapper>
    )
    const after = useVirtualizerCalls.at(-1)!
    expect(after.count).toBe(fillers.length)
    expect(fillers.map((_, index) => after.estimateSize(index))).toEqual(beforeSizes)
  })

  it("falls back rather than throwing for an index with no message behind it", () => {
    const Wrapper = withAdapter(makeAdapter())
    const fillers = manyMsgs(VIRTUALIZE_THRESHOLD + 1)
    render(
      <Wrapper>
        <MessageList messages={fillers} status="idle" />
      </Wrapper>
    )
    expect(useVirtualizerCalls.at(-1)!.estimateSize(fillers.length + 5)).toBe(FALLBACK_ROW_PX)
  })

  it("still estimates settled rows from their content", () => {
    const Wrapper = withAdapter(makeAdapter())
    const fillers = manyMsgs(VIRTUALIZE_THRESHOLD + 1)
    render(
      <Wrapper>
        <MessageList messages={fillers} status="idle" />
      </Wrapper>
    )
    expect(useVirtualizerCalls.at(-1)!.count).toBe(fillers.length)
    expect(useVirtualizerCalls.at(-1)!.estimateSize(0)).toBe(200)
  })
})

describe("MessageList — edit & resend from the touch action sheet", () => {
  it("unwraps the sheet's message into the id-based callback the parent expects", () => {
    // The pencil in the hover footer is unreachable on touch, so this sheet
    // entry is the only edit path on a phone.
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    const onEditResend = jest.fn()
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList
          messages={[userMsg("m1", "hello")]}
          status="idle"
          onEditResend={onEditResend}
        />
      </Wrapper>
    )

    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    fireEvent.click(document.querySelector("[data-test='sheet-edit']")!)
    expect(onEditResend).toHaveBeenCalledWith("m1", "edited text")
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })
})

describe("MessageList — deleting a message that belongs to another session", () => {
  it("routes the delete by the message's own sessionId, not the focused pane's", async () => {
    // Messages carry their owning session in metadata. A background session can
    // be visible (split view, the dock's per-resource pane), and routing its
    // delete to the focused session would remove the wrong row and leave the
    // real one on disk.
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    dbDeleteMock.mockClear()
    desktopDeleteMock.mockClear()

    const owned = {
      id: "bg1",
      role: "user",
      parts: [{ type: "text", text: "from the background thread" }],
      metadata: { sessionId: "ses_bg" },
    } as unknown as UIMessage
    act(() => {
      useChatStore.getState().setActiveSession("ses_1")
      useChatStore.getState().setSessionMessages("ses_bg", [owned, userMsg("bg2", "keep me")])
    })

    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[owned]} status="idle" />
      </Wrapper>
    )
    fireEvent.click(document.querySelector("[data-test='long-press']")!)
    fireEvent.click(document.querySelector("[data-test='sheet-delete']")!)
    await act(async () => {})

    expect(useChatStore.getState().sessions["ses_bg"]!.messages.map((m) => m.id)).toEqual(["bg2"])
    expect(desktopDeleteMock).toHaveBeenCalledWith("ses_bg", "bg1")
    ;(usePlatform as jest.Mock).mockReturnValue("desktop")
  })
})

describe("MessageList — a paused turn is still the streaming row", () => {
  it("treats awaiting_approval as live so the row keeps its streaming treatment", () => {
    // The turn is paused on a permission prompt, not finished. Dropping the
    // streaming flag there would re-measure and re-render the row mid-turn.
    const Wrapper = withAdapter(makeAdapter())
    const fillers = manyMsgs(VIRTUALIZE_THRESHOLD)
    const assistant = {
      id: "a-paused",
      role: "assistant",
      parts: [{ type: "text", text: "waiting on you" }],
    } as unknown as UIMessage
    const { container } = render(
      <Wrapper>
        <MessageList messages={[...fillers, assistant]} status="awaiting_approval" />
      </Wrapper>
    )
    // Rendered through the virtualized branch, and still anchored.
    expect(container.querySelector('[data-msg-id="a-paused"]')).not.toBeNull()
  })
})
