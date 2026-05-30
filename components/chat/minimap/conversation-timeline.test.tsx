import { createRef } from "react"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import type { UIMessage } from "ai"
import type { Virtualizer } from "@tanstack/react-virtual"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ConversationTimeline } from "./conversation-timeline"

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
})
