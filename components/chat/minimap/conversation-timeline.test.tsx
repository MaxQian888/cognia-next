import { createRef } from "react"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import type { UIMessage } from "ai"
import type { Virtualizer } from "@tanstack/react-virtual"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { ConversationTimeline, nearestTurnIndex, scrollTopForThumb } from "./conversation-timeline"

/**
 * Move the pointer over `el`. jsdom implements no `PointerEvent`, so
 * `fireEvent.pointerMove` falls back to a bare `Event` and silently drops
 * `clientY` — the one field the rail reads. A `MouseEvent` carrying the right
 * type gives React's `onPointerMove` everything it needs. (Leave events need no
 * coordinates, so those still go through `fireEvent` directly.)
 */
function firePointer(el: Element, clientY: number) {
  fireEvent(el, new MouseEvent("pointermove", { clientY, bubbles: true }))
}

/** The handler the component registered for `id`, or undefined if it didn't. */
function shortcutHandler(id: string): ((event: KeyboardEvent) => void) | undefined {
  const call = (useAppShortcut as jest.Mock).mock.calls.findLast((c) => c[0] === id)
  return call?.[1]
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

let mockSettings: Record<string, unknown> | null
const mockSave = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))

// Capture the shortcut registrations instead of driving the real dispatcher —
// the chord→handler routing has its own suite; what matters here is which id
// gets which handler.
jest.mock("@/hooks/shortcuts/use-app-shortcut", () => ({
  useAppShortcut: jest.fn(),
}))

let mockBookmarkedIds: string[] = []
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ bookmarkedIds: mockBookmarkedIds }),
}))

function msg(id: string, role: UIMessage["role"], text: string, extra?: Record<string, unknown>) {
  return { id, role, parts: [{ type: "text", text }], ...extra } as unknown as UIMessage
}

function makeVirtualizer(scrollToIndex = jest.fn()) {
  return {
    scrollToIndex,
    getTotalSize: () => 1000,
    measurementsCache: [],
    getOffsetForIndex: () => [0],
    options: { count: 4 },
  } as unknown as Virtualizer<HTMLDivElement, Element>
}

function renderTimeline(opts?: {
  messages?: UIMessage[]
  virtualize?: boolean
  virtualizer?: Virtualizer<HTMLDivElement, Element>
  shortcutsEnabled?: boolean
}) {
  const messages = opts?.messages ?? [
    msg("u1", "user", "First question about the build", {
      metadata: { createdAt: 1_700_000_000_000 },
    }),
    msg("a1", "assistant", "answer one"),
    msg("u2", "user", "Second follow up"),
    msg("a2", "assistant", "answer two"),
  ]
  const scrollRef = createRef<HTMLDivElement>()
  const virtualizer = opts?.virtualizer ?? makeVirtualizer()
  render(
    <TooltipProvider>
      <ConversationTimeline
        messages={messages}
        scrollRef={scrollRef}
        virtualizer={virtualizer}
        virtualize={opts?.virtualize ?? false}
        {...(opts?.shortcutsEnabled !== undefined
          ? { shortcutsEnabled: opts.shortcutsEnabled }
          : {})}
      />
    </TooltipProvider>
  )
  return { virtualizer }
}

/** Give the collapsed rail a real layout box so pointer math resolves a turn. */
function mockRailRect(top = 0, height = 200) {
  const rail = screen.getByTestId("timeline-rail")
  rail.getBoundingClientRect = () =>
    ({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 16,
      width: 16,
      x: 0,
      y: top,
      toJSON() {},
    }) as DOMRect
  return rail
}

beforeEach(() => {
  mockSave.mockClear()
  jest.requireMock("sonner").toast.error.mockClear()
  mockSettings = { conversationTimeline: { expanded: false } }
  mockBookmarkedIds = []
})

afterEach(() => cleanup())

describe("ConversationTimeline", () => {
  it("renders nothing when there are no user turns", () => {
    renderTimeline({ messages: [msg("a1", "assistant", "no user here")] })
    expect(screen.queryByTestId("conversation-timeline")).not.toBeInTheDocument()
  })

  it("renders the collapsed rail with an expand affordance by default", () => {
    renderTimeline()
    expect(screen.getByTestId("conversation-timeline")).toBeInTheDocument()
    expect(screen.getByLabelText("expand")).toBeInTheDocument()
    // Expanded panel chrome is absent while collapsed.
    expect(screen.queryByLabelText("collapse")).not.toBeInTheDocument()
  })

  // The collapsed rail used to be `absolute right-0`, which parked it directly
  // on top of the message list's native scrollbar — so on any platform with
  // classic (non-overlay) scrollbars it swallowed every scrollbar drag. It now
  // takes its own 16px lane, which costs the reading column almost nothing.
  it("gives the collapsed rail its own lane instead of overlaying the scrollbar", () => {
    renderTimeline()
    const root = screen.getByTestId("conversation-timeline")
    expect(root).toHaveClass("relative", "shrink-0", "w-4", "@4xl/message-list:flex")
    expect(root).not.toHaveClass("absolute")
  })

  // The expanded panel is 256px. Overlaid, it simply covered the message text
  // in any pane under ~1344px — which is every Inbox detail pane.
  it("puts the expanded panel in flow so the reading column shrinks around it", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    renderTimeline()
    const root = screen.getByTestId("conversation-timeline")
    expect(root).toHaveClass("relative", "shrink-0", "@4xl/message-list:flex")
    expect(root).not.toHaveClass("absolute")
  })

  it("keeps the collapsed rail DOM bounded for a very long conversation", () => {
    renderTimeline({
      messages: Array.from({ length: 2_000 }, (_, index) =>
        msg(`u${index}`, "user", `Question ${index}`)
      ),
    })

    const rail = screen.getByTestId("timeline-rail")
    // One viewport slider plus at most 128 density markers.
    expect(rail.querySelectorAll("span").length).toBeLessThanOrEqual(129)
  })

  it("clicking the rail pins the timeline open (persists expanded=true)", () => {
    renderTimeline()
    fireEvent.click(screen.getByLabelText("expand"))
    expect(mockSave).toHaveBeenCalledWith({
      conversationTimeline: expect.objectContaining({ expanded: true }),
    })
  })

  it("renders the expanded vertical timeline when pinned, with one entry per user turn", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    renderTimeline()
    expect(screen.getByText("First question about the build")).toBeInTheDocument()
    expect(screen.getByText("Second follow up")).toBeInTheDocument()
    // Two user turns → two jump buttons.
    expect(screen.getAllByRole("button", { name: /^jumpTo:/ })).toHaveLength(2)
  })

  it("keeps the expanded panel DOM bounded for a very long conversation", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    renderTimeline({
      messages: Array.from({ length: 2_000 }, (_, index) =>
        msg(`u${index}`, "user", `Question ${index}`)
      ),
    })

    const jumpButtons = screen.getAllByRole("button", { name: /^jumpTo:/ })
    expect(jumpButtons.length).toBeGreaterThan(0)
    expect(jumpButtons.length).toBeLessThanOrEqual(30)
  })

  it("collapse button unpins the timeline (persists expanded=false)", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    renderTimeline()
    fireEvent.click(screen.getByLabelText("collapse"))
    expect(mockSave).toHaveBeenCalledWith({
      conversationTimeline: expect.objectContaining({ expanded: false }),
    })
  })

  it("jumpTo uses the virtualizer when virtualized", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    const scrollToIndex = jest.fn()
    renderTimeline({ virtualize: true, virtualizer: makeVirtualizer(scrollToIndex) })
    fireEvent.click(screen.getAllByRole("button", { name: /^jumpTo:/ })[1])
    // Second user turn is at message index 2.
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "start" })
  })

  it("jumpTo falls back to DOM scrollIntoView in document-flow mode", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    const scrollIntoView = jest.fn()
    // The component queries scrollRef.current for the target node; stub it.
    const node = document.createElement("div")
    node.scrollIntoView = scrollIntoView
    const container = document.createElement("div")
    container.querySelector = jest.fn().mockReturnValue(node) as never
    const scrollRef = { current: container } as React.RefObject<HTMLDivElement | null>
    render(
      <TooltipProvider>
        <ConversationTimeline
          messages={[msg("u1", "user", "only turn")]}
          scrollRef={scrollRef}
          virtualizer={makeVirtualizer()}
          virtualize={false}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /^jumpTo:/ }))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
  })

  it("hovering the collapsed rail shows a scrub card for the nearest turn without expanding", () => {
    renderTimeline()
    const rail = mockRailRect()
    // Bottom of the rail → nearest the second user turn.
    firePointer(rail, 200)
    const card = screen.getByTestId("timeline-scrub-card")
    expect(card).toHaveTextContent("Second follow up")
    // Still collapsed: no expanded chrome, no jump buttons.
    expect(screen.queryByLabelText("collapse")).not.toBeInTheDocument()
    expect(screen.queryAllByRole("button", { name: /^jumpTo:/ })).toHaveLength(0)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("scrub card resolves the top turn (with its time) near the rail top", () => {
    renderTimeline()
    const rail = mockRailRect()
    firePointer(rail, 0)
    const card = screen.getByTestId("timeline-scrub-card")
    // u1 carries a 2023 createdAt → cross-year date prefix is shown.
    expect(card).toHaveTextContent("First question about the build")
    expect(card).toHaveTextContent("2023")
  })

  it("leaving the rail clears the scrub card; a zero-size rail shows none", () => {
    renderTimeline()
    const rail = mockRailRect()
    firePointer(rail, 100)
    expect(screen.getByTestId("timeline-scrub-card")).toBeInTheDocument()
    fireEvent.pointerLeave(rail)
    expect(screen.queryByTestId("timeline-scrub-card")).not.toBeInTheDocument()
    // A zero-height rail (un-laid-out) → handler bails, no card.
    rail.getBoundingClientRect = (() => ({ top: 0, height: 0 })) as never
    firePointer(rail, 100)
    expect(screen.queryByTestId("timeline-scrub-card")).not.toBeInTheDocument()
  })

  it("filters the panel to bookmarked turns and back", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    mockBookmarkedIds = ["u2"]
    renderTimeline()
    expect(screen.getAllByRole("button", { name: /^jumpTo:/ })).toHaveLength(2)

    fireEvent.click(screen.getByTestId("timeline-filter-bookmarked"))
    const filtered = screen.getAllByRole("button", { name: /^jumpTo:/ })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toHaveAccessibleName(/Second follow up/)

    fireEvent.click(screen.getByTestId("timeline-filter-bookmarked"))
    expect(screen.getAllByRole("button", { name: /^jumpTo:/ })).toHaveLength(2)
  })

  it("a starred assistant reply keeps its own turn in the filter", () => {
    // Turns are keyed on the user message; matching bookmarks on turn.id alone
    // would make a starred assistant reply vanish from the filtered rail.
    mockSettings = { conversationTimeline: { expanded: true } }
    mockBookmarkedIds = ["a1"] // the reply to u1, not u1 itself
    renderTimeline()
    fireEvent.click(screen.getByTestId("timeline-filter-bookmarked"))
    const filtered = screen.getAllByRole("button", { name: /^jumpTo:/ })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toHaveAccessibleName(/First question about the build/)
  })

  it("honours shortcutsEnabled=false for an unfocused split pane", () => {
    renderTimeline({ shortcutsEnabled: false })
    for (const id of ["chat.timeline.prevAnchor", "chat.timeline.nextAnchor"]) {
      const opts = (useAppShortcut as jest.Mock).mock.calls.findLast((c) => c[0] === id)?.[2]
      expect(opts).toMatchObject({ enabled: false })
    }
  })

  it("keeps the filter toggle reachable when nothing matches", () => {
    // Gating the whole component on the FILTERED turns would unmount the only
    // control that can clear the filter — stranding the user at an empty panel.
    mockSettings = { conversationTimeline: { expanded: true } }
    mockBookmarkedIds = []
    renderTimeline()
    fireEvent.click(screen.getByTestId("timeline-filter-bookmarked"))
    expect(screen.queryAllByRole("button", { name: /^jumpTo:/ })).toHaveLength(0)
    expect(screen.getByText("noBookmarks")).toBeInTheDocument()
    // Still there, and still able to undo the filter.
    fireEvent.click(screen.getByTestId("timeline-filter-bookmarked"))
    expect(screen.getAllByRole("button", { name: /^jumpTo:/ })).toHaveLength(2)
  })

  it("collapsing drops an active bookmark filter", () => {
    mockSettings = { conversationTimeline: { expanded: true } }
    mockBookmarkedIds = []
    renderTimeline()
    fireEvent.click(screen.getByTestId("timeline-filter-bookmarked"))
    expect(screen.getByText("noBookmarks")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "collapse" }))
    // The panel is settings-driven, so re-render it as collapsed→expanded and
    // confirm the filter did not survive.
    cleanup()
    mockSettings = { conversationTimeline: { expanded: true } }
    renderTimeline()
    expect(screen.getAllByRole("button", { name: /^jumpTo:/ })).toHaveLength(2)
  })

  it("registers both anchor shortcuts against real catalog ids", () => {
    // A typo'd id registers a handler no chord can ever reach — the shortcut
    // would look wired and be dead. Pin the ids against the catalog.
    renderTimeline()
    for (const id of ["chat.timeline.prevAnchor", "chat.timeline.nextAnchor"]) {
      expect(shortcutHandler(id)).toBeDefined()
      expect(getAppShortcutDescriptor(id)).toBeDefined()
    }
  })

  it("registers the anchor shortcuts so they fire while the composer has focus", () => {
    // Chat's normal posture is focus-in-composer; without allowInEditable the
    // shortcut would never fire in practice.
    renderTimeline()
    const opts = (useAppShortcut as jest.Mock).mock.calls.findLast(
      (c) => c[0] === "chat.timeline.nextAnchor"
    )?.[2]
    expect(opts).toMatchObject({ allowInEditable: true, preventDefault: true })
  })

  it("next-anchor shortcut jumps forward one user turn", () => {
    const scrollToIndex = jest.fn()
    renderTimeline({ virtualize: true, virtualizer: makeVirtualizer(scrollToIndex) })
    shortcutHandler("chat.timeline.nextAnchor")!(new KeyboardEvent("keydown"))
    // Second user turn sits at message index 2.
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "start" })
  })

  it("prev-anchor shortcut clamps at the first turn instead of wrapping", () => {
    const scrollToIndex = jest.fn()
    renderTimeline({ virtualize: true, virtualizer: makeVirtualizer(scrollToIndex) })
    shortcutHandler("chat.timeline.prevAnchor")!(new KeyboardEvent("keydown"))
    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "start" })
  })

  it("anchor shortcuts are inert when there are no user turns", () => {
    const scrollToIndex = jest.fn()
    renderTimeline({
      messages: [msg("a1", "assistant", "no user turns here")],
      virtualize: true,
      virtualizer: makeVirtualizer(scrollToIndex),
    })
    shortcutHandler("chat.timeline.nextAnchor")?.(new KeyboardEvent("keydown"))
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it("clicking the collapsed rail jumps to the scrubbed turn (virtualized)", () => {
    const scrollToIndex = jest.fn()
    renderTimeline({ virtualize: true, virtualizer: makeVirtualizer(scrollToIndex) })
    const rail = mockRailRect()
    firePointer(rail, 200)
    fireEvent.click(rail)
    // Second user turn is at message index 2.
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "start" })
  })

  it("clicking the collapsed rail jumps via scrollIntoView (document-flow)", () => {
    const scrollIntoView = jest.fn()
    const node = document.createElement("div")
    node.scrollIntoView = scrollIntoView
    const container = document.createElement("div")
    container.querySelector = jest.fn().mockReturnValue(node) as never
    const scrollRef = { current: container } as React.RefObject<HTMLDivElement | null>
    render(
      <TooltipProvider>
        <ConversationTimeline
          messages={[
            msg("u1", "user", "first", { metadata: { createdAt: 1_700_000_000_000 } }),
            msg("u2", "user", "second"),
          ]}
          scrollRef={scrollRef}
          virtualizer={makeVirtualizer()}
          virtualize={false}
        />
      </TooltipProvider>
    )
    const rail = mockRailRect()
    firePointer(rail, 0)
    fireEvent.click(rail)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
  })

  it("clicking the rail with no active scrub does nothing", () => {
    const scrollToIndex = jest.fn()
    renderTimeline({ virtualize: true, virtualizer: makeVirtualizer(scrollToIndex) })
    fireEvent.click(screen.getByTestId("timeline-rail"))
    expect(scrollToIndex).not.toHaveBeenCalled()
  })
})

describe("nearestTurnIndex", () => {
  it("returns -1 when there are no turns", () => {
    expect(nearestTurnIndex(0.5, [], 0)).toBe(-1)
  })

  it("always resolves the only turn", () => {
    expect(nearestTurnIndex(0, [], 1)).toBe(0)
    expect(nearestTurnIndex(0.9, [0], 1)).toBe(0)
  })

  it("picks the closest measured position when geometry is available", () => {
    const positions = [0, 0.5, 1]
    expect(nearestTurnIndex(0, positions, 3)).toBe(0)
    expect(nearestTurnIndex(0.4, positions, 3)).toBe(1)
    expect(nearestTurnIndex(0.9, positions, 3)).toBe(2)
  })

  it("falls back to even distribution when positions don't cover the turns", () => {
    expect(nearestTurnIndex(0, [], 4)).toBe(0)
    expect(nearestTurnIndex(0.5, [], 4)).toBe(2)
    expect(nearestTurnIndex(1, [], 4)).toBe(3)
  })

  it("clamps out-of-range and non-finite fractions", () => {
    expect(nearestTurnIndex(-3, [], 4)).toBe(0)
    expect(nearestTurnIndex(5, [], 4)).toBe(3)
    expect(nearestTurnIndex(Number.NaN, [0, 0.5, 1], 3)).toBe(0)
  })

  it("finds a dense rail position without scanning every turn", () => {
    let reads = 0
    const source = Array.from({ length: 4_096 }, (_, index) => index / 4_095)
    const positions = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++
        return Reflect.get(target, property, receiver)
      },
    })

    expect(nearestTurnIndex(0.61, positions, positions.length)).toBeCloseTo(2_498, -1)
    expect(reads).toBeLessThan(30)
  })
})

describe("scrollTopForThumb", () => {
  const base = { railHeight: 200, totalSize: 1000, maxScrollTop: 800 }

  it("maps the rail onto the scrollable range, the inverse of how the thumb is placed", () => {
    expect(scrollTopForThumb({ ...base, thumbTop: 0 })).toBe(0)
    expect(scrollTopForThumb({ ...base, thumbTop: 100 })).toBe(500)
  })

  it("clamps to the real scroll ceiling rather than the content height", () => {
    // The last viewport-height of content cannot be scrolled past. Without this
    // the bottom of the rail maps to an offset the container silently refuses
    // and the thumb sticks short of where the pointer is.
    expect(scrollTopForThumb({ ...base, thumbTop: 200 })).toBe(800)
    expect(scrollTopForThumb({ ...base, thumbTop: 5000 })).toBe(800)
  })

  it("clamps a pointer dragged above the rail to the top", () => {
    expect(scrollTopForThumb({ ...base, thumbTop: -50 })).toBe(0)
  })

  it("returns 0 rather than NaN before anything has been laid out", () => {
    expect(scrollTopForThumb({ ...base, thumbTop: 100, railHeight: 0 })).toBe(0)
    expect(scrollTopForThumb({ ...base, thumbTop: 100, totalSize: 0 })).toBe(0)
  })

  it("never returns a negative offset even with a nonsense ceiling", () => {
    expect(scrollTopForThumb({ ...base, thumbTop: 100, maxScrollTop: -10 })).toBe(0)
  })
})

describe("ConversationTimeline — dragging the viewport thumb", () => {
  /** A real scroll container so the drag has something to move. */
  function renderWithScroller(opts?: { virtualize?: boolean }) {
    const scroller = document.createElement("div")
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true })
    let top = 0
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v
      },
    })
    document.body.append(scroller)

    render(
      <TooltipProvider>
        <ConversationTimeline
          messages={[
            msg("u1", "user", "First question"),
            msg("a1", "assistant", "answer one"),
            msg("u2", "user", "Second follow up"),
            msg("a2", "assistant", "answer two"),
          ]}
          scrollRef={{ current: scroller as HTMLDivElement }}
          virtualizer={makeVirtualizer()}
          virtualize={opts?.virtualize ?? false}
        />
      </TooltipProvider>
    )
    return {
      scroller,
      get scrollTop() {
        return top
      },
    }
  }

  function grabThumb(clientY: number) {
    const thumb = screen.getByTestId("timeline-viewport-thumb")
    thumb.getBoundingClientRect = (() => ({
      top: 0,
      height: 40,
      bottom: 40,
      left: 0,
      right: 16,
      width: 16,
      x: 0,
      y: 0,
      toJSON() {},
    })) as () => DOMRect
    fireEvent(thumb, new MouseEvent("pointerdown", { clientY, bubbles: true }))
    return thumb
  }

  const dragTo = (thumb: Element, clientY: number) =>
    fireEvent(thumb, new MouseEvent("pointermove", { clientY, bubbles: true }))

  it("scrolls the conversation as the thumb is dragged", () => {
    const view = renderWithScroller()
    mockRailRect(0, 200)
    const thumb = grabThumb(0)

    dragTo(thumb, 100)
    // Half way down a 200px rail over 1000px of content.
    expect(view.scrollTop).toBe(500)

    dragTo(thumb, 40)
    expect(view.scrollTop).toBe(200)
  })

  it("keeps the grab point under the pointer instead of snapping the thumb", () => {
    // Grabbing 30px into the thumb and moving to y=130 should put the thumb TOP
    // at 100, not 130 — otherwise the content lurches on mousedown.
    const view = renderWithScroller()
    mockRailRect(0, 200)
    const thumb = grabThumb(30)

    dragTo(thumb, 130)
    expect(view.scrollTop).toBe(500)
  })

  it("ignores pointer movement when the thumb was never grabbed", () => {
    const view = renderWithScroller()
    mockRailRect(0, 200)
    const thumb = screen.getByTestId("timeline-viewport-thumb")
    dragTo(thumb, 100)
    expect(view.scrollTop).toBe(0)
  })

  it("stops scrolling once the pointer is released", () => {
    const view = renderWithScroller()
    mockRailRect(0, 200)
    const thumb = grabThumb(0)
    dragTo(thumb, 100)
    fireEvent(thumb, new MouseEvent("pointerup", { clientY: 100, bubbles: true }))

    dragTo(thumb, 20)
    expect(view.scrollTop).toBe(500)
  })

  it("suppresses the scrub card while dragging", () => {
    // The card would otherwise chase the pointer on top of the drag it is
    // sitting on.
    renderWithScroller()
    const rail = mockRailRect(0, 200)
    const thumb = grabThumb(0)
    dragTo(thumb, 100)

    firePointer(rail, 100)
    expect(screen.queryByTestId("timeline-scrub-card")).not.toBeInTheDocument()
  })

  it("does not jump to a turn on the click that ends a drag", () => {
    // A drag finishes with a click on the rail; treating it as click-to-jump
    // would undo the drag the user just performed.
    const virtualizer = makeVirtualizer()
    const scroller = document.createElement("div")
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true })
    document.body.append(scroller)
    render(
      <TooltipProvider>
        <ConversationTimeline
          messages={[msg("u1", "user", "First"), msg("u2", "user", "Second")]}
          scrollRef={{ current: scroller as HTMLDivElement }}
          virtualizer={virtualizer}
          virtualize
        />
      </TooltipProvider>
    )
    const rail = mockRailRect(0, 200)
    const thumb = grabThumb(0)
    dragTo(thumb, 100)
    fireEvent.click(rail)

    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
  })
})

describe("ConversationTimeline — the expanded panel", () => {
  /** A real scroll container, so the scroll-sync produces a real active turn. */
  function renderExpanded(messages: UIMessage[]) {
    const scroller = document.createElement("div")
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true })
    document.body.append(scroller)
    mockSettings = { conversationTimeline: { expanded: true } }
    render(
      <TooltipProvider>
        <ConversationTimeline
          messages={messages}
          scrollRef={{ current: scroller as HTMLDivElement }}
          virtualizer={makeVirtualizer()}
          virtualize={false}
        />
      </TooltipProvider>
    )
    return scroller
  }

  const dayMs = (day: number, hour = 12) => new Date(2024, 5, day, hour).getTime()

  it("marks where each calendar day starts", () => {
    // A hundred rows of bare clock times say nothing about when anything
    // happened in a conversation resumed across days.
    renderExpanded([
      msg("u1", "user", "Monday morning", { metadata: { createdAt: dayMs(17, 9) } }),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "Monday evening", { metadata: { createdAt: dayMs(17, 20) } }),
      msg("a2", "assistant", "reply"),
      msg("u3", "user", "Tuesday", { metadata: { createdAt: dayMs(18, 9) } }),
    ])
    // Two days → two headers, not one per row.
    expect(screen.getAllByTestId("timeline-date-header")).toHaveLength(2)
  })

  it("renders no headers when nothing carries a timestamp", () => {
    renderExpanded([msg("u1", "user", "no time"), msg("a1", "assistant", "reply")])
    expect(screen.queryAllByTestId("timeline-date-header")).toHaveLength(0)
  })

  it("centres the turn the reader is on instead of opening at turn one", () => {
    // Opening a 200-turn panel at turn 1 is useless: the one thing the reader
    // already knows is where they are, and that is what the panel should show.
    const original = Element.prototype.scrollIntoView
    const scrollIntoView = jest.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      renderExpanded([
        msg("u1", "user", "first"),
        msg("a1", "assistant", "reply"),
        msg("u2", "user", "second"),
        msg("a2", "assistant", "reply"),
      ])
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" })
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it("jumps to the starred reply, not to the question above it", () => {
    // Starring an assistant reply is how you mark an ANSWER worth returning to.
    // The panel only ever jumped to the question that opened the turn, so the
    // one thing you bookmarked was the one thing the bookmark could not reach.
    mockBookmarkedIds = ["a1"]
    const jump = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage: jump })
    try {
      renderExpanded([
        msg("u1", "user", "the question"),
        msg("a1", "assistant", "the answer worth keeping"),
      ])
      fireEvent.click(screen.getByRole("button", { name: /^jumpTo:/ }))
      expect(jump).toHaveBeenCalledWith("a1", undefined, { align: "start" })
    } finally {
      useChatViewportStore.setState({ jumpToMessage: null })
    }
  })

  it("labels the row so the star is explained rather than just coloured", () => {
    mockBookmarkedIds = ["a1"]
    renderExpanded([
      msg("u1", "user", "the question"),
      msg("a1", "assistant", "the answer worth keeping"),
    ])
    expect(screen.getByTestId("timeline-starred-reply")).toBeInTheDocument()
  })

  it("still jumps to the question when the star is on the question itself", () => {
    mockBookmarkedIds = ["u1"]
    const jump = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage: jump })
    try {
      renderExpanded([msg("u1", "user", "the question"), msg("a1", "assistant", "reply")])
      fireEvent.click(screen.getByRole("button", { name: /^jumpTo:/ }))
      // Index fast-path retained: the turn's own anchor knows its row.
      expect(jump).toHaveBeenCalledWith("u1", 0, { align: "start" })
      expect(screen.queryByTestId("timeline-starred-reply")).not.toBeInTheDocument()
    } finally {
      useChatViewportStore.setState({ jumpToMessage: null })
    }
  })

  it("reports a jump that cannot resolve instead of looking inert", () => {
    // `jumpToMessage` returns false for a row it cannot reach, and the store
    // documents that callers must surface it. The starred-reply branch passes
    // `index: undefined` — the case that has to resolve by id and can miss — so
    // swallowing it made the rail look dead on exactly the rows it exists for.
    const { toast } = jest.requireMock("sonner")
    mockBookmarkedIds = ["a1"]
    const jump = jest.fn(() => false)
    useChatViewportStore.setState({ jumpToMessage: jump })
    try {
      renderExpanded([msg("u1", "user", "the question"), msg("a1", "assistant", "the answer")])
      fireEvent.click(screen.getByRole("button", { name: /^jumpTo:/ }))
      expect(toast.error).toHaveBeenCalledWith("notFound")
    } finally {
      useChatViewportStore.setState({ jumpToMessage: null })
    }
  })

  it("stays quiet when the jump lands", () => {
    const { toast } = jest.requireMock("sonner")
    const jump = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage: jump })
    try {
      renderExpanded([msg("u1", "user", "the question"), msg("a1", "assistant", "reply")])
      fireEvent.click(screen.getByRole("button", { name: /^jumpTo:/ }))
      expect(toast.error).not.toHaveBeenCalled()
    } finally {
      useChatViewportStore.setState({ jumpToMessage: null })
    }
  })
})
