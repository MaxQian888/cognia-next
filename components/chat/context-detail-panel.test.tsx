/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { ContextDetailPanel, GROUP_LABEL_KEY } from "./context-detail-panel"
import type { ContextBreakdown } from "@/lib/claude/context-breakdown"
import enChat from "@/i18n/messages/en/chat.json"
import zhChat from "@/i18n/messages/zh-CN/chat.json"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const breakdown = (over: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  usedTokens: 60_000,
  maxTokens: 100_000,
  source: "live",
  denominator: "window",
  groups: [
    {
      id: "messages",
      key: "messages",
      tokens: 40_000,
      fraction: 0.4,
      deferred: false,
      items: [],
      itemCount: 0,
    },
    {
      id: "mcp",
      key: "mcp",
      tokens: 20_000,
      fraction: 0.2,
      deferred: false,
      itemCount: 2,
      items: [
        { label: "wiki_write", hint: "wiki", tokens: 12_000 },
        { label: "wiki_read", hint: "wiki", tokens: 8_000 },
      ],
    },
  ],
  free: {
    id: "free",
    key: "free",
    tokens: 40_000,
    fraction: 0.4,
    deferred: false,
    items: [],
    itemCount: 0,
  },
  ...over,
})

function Panel({
  data = breakdown(),
  open = true,
  expanded = [] as string[],
  onOpenChange = jest.fn(),
  onExpandedChange = jest.fn(),
}) {
  return (
    <ContextDetailPanel
      breakdown={data}
      open={open}
      onOpenChange={onOpenChange}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />
  )
}

describe("ContextDetailPanel", () => {
  it("renders one row per occupied group plus the free remainder", () => {
    render(<Panel />)
    expect(screen.getByTestId("context-group-messages")).toBeInTheDocument()
    expect(screen.getByTestId("context-group-mcp")).toBeInTheDocument()
    expect(screen.getByTestId("context-group-free")).toBeInTheDocument()
  })

  it("shows each group's token count and share of the window", () => {
    render(<Panel />)
    const row = screen.getByTestId("context-group-messages")
    expect(row.textContent).toContain("40K")
    expect(row.textContent).toContain("40%")
  })

  it("draws a stacked segment for every occupied group but not for free space", () => {
    render(<Panel />)
    const bar = screen.getByTestId("context-segment-bar")
    expect(bar.querySelectorAll("[data-group]")).toHaveLength(2)
    expect(bar.querySelector('[data-group="free"]')).toBeNull()
  })

  it("lists a deferred group but keeps it out of the occupancy bar", () => {
    const withDeferred = breakdown()
    withDeferred.groups.push({
      id: "mcp",
      key: "mcp:deferred",
      tokens: 26_000,
      fraction: 0.26,
      deferred: true,
      items: [],
      itemCount: 0,
    })
    render(<Panel data={withDeferred} />)
    // Drawn, it would push the bar past the occupancy the header reports.
    expect(screen.getByTestId("context-group-mcp:deferred")).toBeInTheDocument()
    expect(
      screen.getByTestId("context-segment-bar").querySelector('[data-group="mcp:deferred"]')
    ).toBeNull()
  })

  it("keeps sub-percent slices readable instead of rounding them to 0%", () => {
    const tiny = breakdown({
      groups: [
        {
          id: "commands",
          key: "commands",
          tokens: 40,
          fraction: 0.0004,
          deferred: false,
          items: [],
          itemCount: 12,
        },
      ],
      free: null,
    })
    render(<Panel data={tiny} />)
    expect(screen.getByTestId("context-group-commands").textContent).toContain("<0.1%")
    // Groups that report a count without an item list still show the count.
    expect(screen.getByTestId("context-group-commands").textContent).toContain("12")
  })

  it("expands a group's items on click and reports the toggle upward", () => {
    const onExpandedChange = jest.fn()
    const { rerender } = render(<Panel onExpandedChange={onExpandedChange} />)
    expect(screen.queryByTestId("context-items-mcp")).toBeNull()
    fireEvent.click(screen.getByTestId("context-group-mcp").querySelector("button")!)
    expect(onExpandedChange).toHaveBeenCalledWith(["mcp"])
    rerender(<Panel expanded={["mcp"]} onExpandedChange={onExpandedChange} />)
    const items = screen.getByTestId("context-items-mcp")
    expect(items.textContent).toContain("wiki_write")
    expect(items.textContent).toContain("12K")
  })

  it("collapses an already-expanded group", () => {
    const onExpandedChange = jest.fn()
    render(<Panel expanded={["mcp"]} onExpandedChange={onExpandedChange} />)
    fireEvent.click(screen.getByTestId("context-group-mcp").querySelector("button")!)
    expect(onExpandedChange).toHaveBeenCalledWith([])
  })

  it("summarises the tail of a long item list instead of overflowing the card", () => {
    const many = breakdown({
      groups: [
        {
          id: "mcp",
          key: "mcp",
          tokens: 20_000,
          fraction: 0.2,
          deferred: false,
          itemCount: 20,
          items: Array.from({ length: 20 }, (_, i) => ({ label: `tool_${i}`, tokens: 100 })),
        },
      ],
      free: null,
    })
    render(<Panel data={many} expanded={["mcp"]} />)
    const items = screen.getByTestId("context-items-mcp")
    expect(items.querySelectorAll("li")).toHaveLength(9) // 8 rows + the summary
    expect(items.textContent).toContain('breakdownMoreItems:{"count":12}')
  })

  it("marks a deferred group and leaves it unexpandable", () => {
    const deferred = breakdown({
      groups: [
        {
          id: "mcp",
          key: "mcp:deferred",
          tokens: 5_000,
          fraction: 0.05,
          deferred: true,
          items: [],
          itemCount: 0,
        },
      ],
      free: null,
    })
    render(<Panel data={deferred} />)
    const row = screen.getByTestId("context-group-mcp:deferred")
    expect(row.textContent).toContain('breakdownDeferred:{"label":"breakdownMcp"}')
    expect(row.querySelector("button")).toBeDisabled()
  })

  it("names an unknown upstream category instead of dropping it", () => {
    const unknown = breakdown({
      groups: [
        {
          id: "other",
          key: "other",
          tokens: 500,
          fraction: 0.005,
          deferred: false,
          rawName: "Quantum widgets",
          items: [],
          itemCount: 0,
        },
      ],
      free: null,
    })
    render(<Panel data={unknown} />)
    expect(screen.getByText("Quantum widgets")).toBeInTheDocument()
  })

  it("names the denominator when the shares are not of the whole window", () => {
    const { rerender } = render(<Panel />)
    expect(screen.queryByTestId("context-detail-note")).toBeNull()
    rerender(<Panel data={breakdown({ source: "estimate", denominator: "attributed" })} />)
    expect(screen.getByTestId("context-detail-note")).toHaveTextContent("detailsOfTranscript")
  })

  it("says whether the numbers are live or estimated", () => {
    const { rerender } = render(<Panel />)
    expect(screen.getByTestId("context-detail-source")).toHaveTextContent("detailsLive")
    rerender(<Panel data={breakdown({ source: "estimate" })} />)
    expect(screen.getByTestId("context-detail-source")).toHaveTextContent("detailsEstimated")
  })

  it("hides its body while collapsed and reports the disclosure upward", () => {
    const onOpenChange = jest.fn()
    render(<Panel open={false} onOpenChange={onOpenChange} />)
    expect(screen.queryByTestId("context-segment-bar")).toBeNull()
    fireEvent.click(screen.getByText("detailsToggle"))
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it("renders nothing when there is nothing to break down", () => {
    const { container } = render(<Panel data={breakdown({ groups: [], free: null })} />)
    expect(container.firstChild).toBeNull()
  })
})

describe("group label catalogue", () => {
  // `t()` is called with a computed key here, which `lint:i18n` cannot see —
  // this is the guard that keeps the table and the message files in step.
  const toolbar = (bundle: Record<string, unknown>) =>
    ((bundle.composer as Record<string, unknown>).toolbar as Record<string, string>) ?? {}

  it.each(Object.entries(GROUP_LABEL_KEY))("%s → %s exists in both locales", (_id, key) => {
    expect(toolbar(enChat as never)[key]).toBeTruthy()
    expect(toolbar(zhChat as never)[key]).toBeTruthy()
  })
})
