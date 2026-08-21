/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

const droppableCalls: Array<{ id: string; disabled?: boolean }> = []
jest.mock("@dnd-kit/core", () => ({
  useDroppable: (args: { id: string; disabled?: boolean }) => {
    droppableCalls.push(args)
    return { setNodeRef: jest.fn(), isOver: false }
  },
}))
jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: jest.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}))

import { fireEvent, render, screen, within } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { BoardColumn, type BoardColumnProps } from "./board-column"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const sourceId = over.sourceId ?? `s${seq}`
  const status: IssueStatus = over.status ?? "todo"
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
    order: seq,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

function renderColumn(over: Partial<BoardColumnProps> = {}) {
  const props: BoardColumnProps = {
    status: "todo",
    items: [],
    collapsed: false,
    dimmed: false,
    insertionIndex: null,
    statusLabel: "Todo",
    addLabel: "Add",
    emptyText: "Nothing here",
    collapseLabel: "Collapse",
    expandLabel: "Expand",
    ...over,
  }
  return render(<BoardColumn {...props} />)
}

beforeEach(() => {
  seq = 0
  droppableCalls.length = 0
})

describe("BoardColumn", () => {
  describe("expanded", () => {
    it("shows the status name and the card count", () => {
      renderColumn({ items: [item(), item()] })
      const column = screen.getByTestId("issue-column-todo")
      expect(column).toHaveTextContent("Todo")
      expect(within(column).getByText("2")).toBeInTheDocument()
    })

    it("shows the empty text when there is nothing to render", () => {
      renderColumn()
      expect(screen.getByText("Nothing here")).toBeInTheDocument()
    })

    it("renders one card per item", () => {
      renderColumn({ items: [item(), item()] })
      expect(screen.getByTestId("issue-card-local:s1")).toBeInTheDocument()
      expect(screen.getByTestId("issue-card-local:s2")).toBeInTheDocument()
    })

    it("marks the running cards it is told about", () => {
      const a = item()
      renderColumn({ items: [a], runningIds: new Set([a.unifiedId]) })
      expect(screen.getByTestId(`issue-card-running-${a.unifiedId}`)).toBeInTheDocument()
    })

    it("resolves label ids through the catalogue and drops the ones it cannot", () => {
      const a = item({ labelIds: ["l1", "missing"] })
      renderColumn({
        items: [a],
        labelsById: new Map([
          [
            "l1",
            {
              id: "l1",
              scope: "issue" as const,
              name: "bug",
              sortOrder: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        ]),
      })
      expect(screen.getByText("bug")).toBeInTheDocument()
      expect(screen.queryByText("missing")).not.toBeInTheDocument()
    })
  })

  describe("collapsed", () => {
    it("renders a strip instead of a column", () => {
      renderColumn({ collapsed: true, items: [item()] })
      const column = screen.getByTestId("issue-column-todo")
      expect(column).toHaveAttribute("data-collapsed", "true")
      expect(screen.queryByTestId("issue-card-local:s1")).not.toBeInTheDocument()
    })

    it("still registers a droppable, so the transition stays reachable", () => {
      renderColumn({ collapsed: true })
      expect(droppableCalls).toContainEqual({ id: "col:todo", disabled: false })
    })

    it("keeps the count visible on the strip", () => {
      renderColumn({ collapsed: true, items: [item(), item(), item()] })
      expect(within(screen.getByTestId("issue-column-todo")).getByText("3")).toBeInTheDocument()
    })

    it("expands on click", () => {
      const onToggleCollapsed = jest.fn()
      renderColumn({ collapsed: true, onToggleCollapsed })
      fireEvent.click(screen.getByTestId("issue-column-expand-todo"))
      expect(onToggleCollapsed).toHaveBeenCalledWith("todo")
    })
  })

  describe("insertion indicator", () => {
    it("draws nothing when there is no preview", () => {
      renderColumn({ items: [item()] })
      expect(screen.queryByTestId("issue-drop-indicator-todo")).not.toBeInTheDocument()
    })

    it("draws before the card at the insertion index", () => {
      renderColumn({ items: [item(), item()], insertionIndex: 1 })
      const body = screen.getByTestId("issue-drop-indicator-todo").parentElement!
      const rendered = Array.from(body.children).map((node) => node.getAttribute("data-testid"))
      expect(rendered).toEqual([
        "issue-card-local:s1",
        "issue-drop-indicator-todo",
        "issue-card-local:s2",
      ])
    })

    it("draws after the last card when the index is past the end", () => {
      renderColumn({ items: [item()], insertionIndex: 1 })
      const body = screen.getByTestId("issue-drop-indicator-todo").parentElement!
      const rendered = Array.from(body.children).map((node) => node.getAttribute("data-testid"))
      expect(rendered).toEqual(["issue-card-local:s1", "issue-drop-indicator-todo"])
    })

    it("replaces the empty text on an empty column", () => {
      renderColumn({ insertionIndex: 0 })
      expect(screen.getByTestId("issue-drop-indicator-todo")).toBeInTheDocument()
      expect(screen.queryByText("Nothing here")).not.toBeInTheDocument()
    })
  })

  describe("legality", () => {
    it("disables the droppable and marks itself when dimmed", () => {
      renderColumn({ dimmed: true })
      expect(screen.getByTestId("issue-column-todo")).toHaveAttribute("data-dimmed", "true")
      expect(droppableCalls).toContainEqual({ id: "col:todo", disabled: true })
    })
  })

  describe("controls", () => {
    it("hides the add button without a handler", () => {
      renderColumn()
      expect(screen.queryByTestId("issue-column-add-todo")).not.toBeInTheDocument()
    })

    it("adds to its own column", () => {
      const onAddIssue = jest.fn()
      renderColumn({ onAddIssue })
      fireEvent.click(screen.getByTestId("issue-column-add-todo"))
      expect(onAddIssue).toHaveBeenCalledWith("todo")
    })

    it("collapses on click", () => {
      const onToggleCollapsed = jest.fn()
      renderColumn({ onToggleCollapsed })
      fireEvent.click(screen.getByTestId("issue-column-collapse-todo"))
      expect(onToggleCollapsed).toHaveBeenCalledWith("todo")
    })
  })

  describe("item menu", () => {
    it("renders cards directly when no wrapper is supplied", () => {
      renderColumn({ items: [item()] })
      expect(screen.getByTestId("issue-card-local:s1")).toBeInTheDocument()
    })

    it("wraps each card when one is", () => {
      renderColumn({
        items: [item(), item()],
        renderItemMenu: (menuItem, children) => (
          <div key={menuItem.unifiedId} data-testid={`menu-${menuItem.unifiedId}`}>
            {children}
          </div>
        ),
      })
      const wrapper = screen.getByTestId("menu-local:s1")
      expect(wrapper.contains(screen.getByTestId("issue-card-local:s1"))).toBe(true)
      expect(screen.getByTestId("menu-local:s2")).toBeInTheDocument()
    })

    it("keys the cards itself, so the unwrapped path is not a React key warning", () => {
      const warn = jest.spyOn(console, "error").mockImplementation(() => undefined)
      renderColumn({ items: [item(), item()] })
      expect(warn.mock.calls.flat().join(" ")).not.toContain('unique "key"')
      warn.mockRestore()
    })
  })
})
