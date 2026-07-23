import { createRef } from "react"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import type { UIMessage } from "ai"
import type { Virtualizer } from "@tanstack/react-virtual"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"
import { ConversationTimeline, nearestTurnIndex } from "./conversation-timeline"

/** The handler the component registered for `id`, or undefined if it didn't. */
function shortcutHandler(id: string): ((event: KeyboardEvent) => void) | undefined {
  const call = (useAppShortcut as jest.Mock).mock.calls.findLast((c) => c[0] === id)
  return call?.[1]
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

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
    fireEvent.mouseMove(rail, { clientY: 200 })
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
    fireEvent.mouseMove(rail, { clientY: 0 })
    const card = screen.getByTestId("timeline-scrub-card")
    // u1 carries a 2023 createdAt → cross-year date prefix is shown.
    expect(card).toHaveTextContent("First question about the build")
    expect(card).toHaveTextContent("2023")
  })

  it("leaving the rail clears the scrub card; a zero-size rail shows none", () => {
    renderTimeline()
    const rail = mockRailRect()
    fireEvent.mouseMove(rail, { clientY: 100 })
    expect(screen.getByTestId("timeline-scrub-card")).toBeInTheDocument()
    fireEvent.mouseLeave(rail)
    expect(screen.queryByTestId("timeline-scrub-card")).not.toBeInTheDocument()
    // A zero-height rail (un-laid-out) → handler bails, no card.
    rail.getBoundingClientRect = (() => ({ top: 0, height: 0 })) as never
    fireEvent.mouseMove(rail, { clientY: 100 })
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
    fireEvent.mouseMove(rail, { clientY: 200 })
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
    fireEvent.mouseMove(rail, { clientY: 0 })
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
