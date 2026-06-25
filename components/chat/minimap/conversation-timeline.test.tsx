import { createRef } from "react"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import type { UIMessage } from "ai"
import type { Virtualizer } from "@tanstack/react-virtual"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ConversationTimeline, nearestTurnIndex } from "./conversation-timeline"

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
}) {
  const messages = opts?.messages ?? [
    msg("u1", "user", "First question about the build", { createdAt: 1_700_000_000_000 }),
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
            msg("u1", "user", "first", { createdAt: 1_700_000_000_000 }),
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
})
