/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

// Render the hover card eagerly: Radix's open-on-hover timing is library
// behaviour — what matters here is the rail's own content and wiring.
jest.mock("@/components/ui/hover-card", () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="rail-hover-card">{children}</div>
  ),
}))

import { fireEvent, render, screen } from "@testing-library/react"

import type { KanbanCollapsedContext } from "@/components/board/kanban-board"
import { statusCategoryOf } from "@/types/issues"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { issueCollapsedRail } from "./issue-collapsed-rail"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const status: IssueStatus = over.status ?? "todo"
  const sourceId = over.sourceId ?? `s${seq}`
  return {
    unifiedId: `local:${sourceId}`,
    kind: "local",
    sourceId,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

function ctxOf(over: Partial<KanbanCollapsedContext<IssueStatus, UnifiedIssueItem>> = {}) {
  const items = over.items ?? [item({ priority: "urgent" }), item()]
  const ctx: KanbanCollapsedContext<IssueStatus, UnifiedIssueItem> = {
    columnId: "todo",
    label: "To do",
    count: items.length,
    items,
    isOver: false,
    insertionIndex: null,
    onExpand: jest.fn(),
    expandLabel: "Expand To do",
    onAdd: jest.fn(),
    addLabel: "Add issue",
    testIdPrefix: "k",
    ...over,
  }
  return ctx
}

function renderRail(
  ctx: KanbanCollapsedContext<IssueStatus, UnifiedIssueItem>,
  extras: Parameters<typeof issueCollapsedRail>[1] = {}
) {
  const strip = issueCollapsedRail(ctx, extras)
  return { strip, ...render(<>{strip.content}</>) }
}

beforeEach(() => {
  seq = 0
})

describe("issueCollapsedRail", () => {
  it("renders as an icon-width rail", () => {
    const { strip } = renderRail(ctxOf())
    expect(strip.className).toBe("w-12 items-center py-2")
  })

  it("expands the column from the rail button and shows the count", () => {
    const onExpand = jest.fn()
    renderRail(ctxOf({ onExpand }))
    fireEvent.click(screen.getByTestId("k-column-expand-todo"))
    expect(onExpand).toHaveBeenCalled()
    expect(screen.getByTestId("k-column-todo-count")).toHaveTextContent("2")
  })

  it("sketches each item as a priority-coloured spine dot", () => {
    const { container } = renderRail(
      ctxOf({ items: [item({ priority: "urgent" }), item({ priority: "low" })] })
    )
    expect(container.querySelector(".bg-red-500")).not.toBeNull()
    expect(container.querySelector(".bg-muted-foreground\\/40")).not.toBeNull()
  })

  it("caps the spine at twelve dots so a long column stays a sketch", () => {
    const items = Array.from({ length: 20 }, () => item())
    const { container } = renderRail(ctxOf({ items, count: 20 }))
    expect(container.querySelectorAll(".h-1.w-4")).toHaveLength(12)
  })

  it("flags the rail when an item has a run in flight", () => {
    const items = [item(), item()]
    const { container } = renderRail(ctxOf({ items }), {
      runningIds: new Set([items[1].unifiedId]),
    })
    expect(container.querySelector(".bg-amber-500")).not.toBeNull()
  })

  it("shows no running flag when nothing in the column is running", () => {
    const { container } = renderRail(ctxOf(), { runningIds: new Set() })
    expect(container.querySelector(".bg-amber-500")).toBeNull()
  })

  it("wires quick-add and omits it without a handler", () => {
    const onAdd = jest.fn()
    renderRail(ctxOf({ onAdd }))
    fireEvent.click(screen.getByTestId("k-column-add-todo"))
    expect(onAdd).toHaveBeenCalled()
  })

  it("omits quick-add without a handler", () => {
    renderRail(ctxOf({ onAdd: undefined }))
    expect(screen.queryByTestId("k-column-add-todo")).not.toBeInTheDocument()
  })

  it("shows the drop indicator only while a cross-column drop targets the rail", () => {
    const { unmount } = renderRail(ctxOf({ insertionIndex: null }))
    expect(screen.queryByTestId("k-drop-indicator-todo")).not.toBeInTheDocument()
    unmount()
    renderRail(ctxOf({ insertionIndex: 0 }))
    expect(screen.getByTestId("k-drop-indicator-todo")).toBeInTheDocument()
  })

  it("tints the rail while a dragged card is over it", () => {
    const { container } = renderRail(ctxOf({ isOver: true }))
    expect(container.querySelector(".bg-accent\\/50")).not.toBeNull()
  })

  describe("hover card", () => {
    it("carries the label horizontally plus one clickable row per item", () => {
      const onSelect = jest.fn()
      const items = [item({ priority: "high" }), item()]
      renderRail(ctxOf({ items }), { onSelect })
      const card = screen.getByTestId("rail-hover-card")
      expect(card).toHaveTextContent("To do")
      expect(card).toHaveTextContent("MERC-1")
      expect(card).toHaveTextContent("Issue 2")
      fireEvent.click(screen.getByTestId(`rail-item-${items[0].unifiedId}`))
      expect(onSelect).toHaveBeenCalledWith(items[0].unifiedId)
    })

    it("lists every item up to the scroll bound, then an expand-overflow row", () => {
      const onExpand = jest.fn()
      const items = Array.from({ length: 53 }, () => item())
      renderRail(ctxOf({ items, count: 53, onExpand }))
      expect(screen.getAllByTestId(/^rail-item-/)).toHaveLength(50)
      const overflow = screen.getByTestId("k-column-overflow-todo")
      expect(overflow).toHaveTextContent("+3")
      fireEvent.click(overflow)
      expect(onExpand).toHaveBeenCalled()
    })

    it("marks running items inside the list too", () => {
      const items = [item(), item()]
      const { container } = renderRail(ctxOf({ items }), {
        runningIds: new Set([items[1].unifiedId]),
      })
      const row = screen.getByTestId(`rail-item-${items[1].unifiedId}`)
      expect(row.querySelector(".bg-amber-500")).not.toBeNull()
      expect(container.querySelectorAll(".bg-amber-500")).toHaveLength(2)
    })

    it("shows the empty hint instead of a bare header for an empty column", () => {
      renderRail(ctxOf({ items: [], count: 0 }))
      const card = screen.getByTestId("rail-hover-card")
      expect(card).toHaveTextContent("emptyColumn")
      expect(screen.queryByTestId(/^rail-item-/)).not.toBeInTheDocument()
    })

    it("wraps rows in the shared item menu so right-click works there too", () => {
      const renderItemMenu = jest.fn((item: UnifiedIssueItem, children: React.ReactNode) => (
        <div data-testid={`menu-${item.unifiedId}`}>{children}</div>
      ))
      const items = [item(), item()]
      renderRail(ctxOf({ items }), { renderItemMenu })
      expect(renderItemMenu).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId(`menu-${items[0].unifiedId}`)).toContainElement(
        screen.getByTestId(`rail-item-${items[0].unifiedId}`)
      )
    })
  })
})
