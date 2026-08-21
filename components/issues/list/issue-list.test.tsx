/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen, within } from "@testing-library/react"
import { buildIssueGroups } from "@/lib/issues/board-model"
import { statusCategoryOf } from "@/types/issues"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueList } from "./issue-list"

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

function renderList(
  items: UnifiedIssueItem[],
  over: Partial<React.ComponentProps<typeof IssueList>> = {}
) {
  const groupBy = over.groupBy ?? "status"
  const props: React.ComponentProps<typeof IssueList> = {
    groups: buildIssueGroups(items, groupBy),
    groupBy,
    ...over,
  }
  return { props, ...render(<IssueList {...props} />) }
}

beforeEach(() => {
  seq = 0
})

describe("IssueList", () => {
  it("shows an empty state when nothing matches", () => {
    renderList([])
    expect(screen.getByTestId("issue-list-empty")).toBeInTheDocument()
  })

  it("renders one row per item", () => {
    renderList([item(), item()])
    expect(screen.getByTestId("issue-row-local:s1")).toBeInTheDocument()
    expect(screen.getByTestId("issue-row-local:s2")).toBeInTheDocument()
  })

  describe("grouping", () => {
    it("renders a localized header and a count per group", () => {
      renderList([item({ status: "todo" }), item({ status: "done" })])
      const group = screen.getByTestId("issue-group-todo")
      expect(within(group).getByText("status.todo")).toBeInTheDocument()
      expect(within(group).getByText("1")).toBeInTheDocument()
    })

    it("drops the headers entirely when grouping is off", () => {
      renderList([item()], { groupBy: "none" })
      expect(screen.queryByText("status.todo")).not.toBeInTheDocument()
    })

    it("names the catch-all bucket after the axis", () => {
      renderList([item()], { groupBy: "assignee" })
      // Scoped to the header: the row's own assignee cell says the same thing.
      const header = screen.getByTestId("issue-group-none").querySelector("header")!
      expect(within(header).getByText("actor.unassigned")).toBeInTheDocument()
    })

    it("resolves a project group through the caller's names", () => {
      renderList([item({ issueProjectId: "p1" })], {
        groupBy: "project",
        projectNamesById: new Map([["p1", "Mercury"]]),
      })
      const header = screen.getByTestId("issue-group-p1").querySelector("header")!
      expect(within(header).getByText("Mercury")).toBeInTheDocument()
    })
  })

  describe("selection", () => {
    it("offers no checkboxes without a handler", () => {
      renderList([item()])
      expect(screen.queryByTestId("issue-row-check-local:s1")).not.toBeInTheDocument()
    })

    it("reports a tick with its modifiers", () => {
      const onToggleCheck = jest.fn()
      renderList([item()], { onToggleCheck })
      fireEvent.click(screen.getByTestId("issue-row-check-local:s1"), { shiftKey: true })
      expect(onToggleCheck).toHaveBeenCalledWith("local:s1", { shiftKey: true })
    })

    it("marks the ticked rows", () => {
      renderList([item(), item()], {
        onToggleCheck: jest.fn(),
        checkedIds: new Set(["local:s2"]),
      })
      expect(screen.getByTestId("issue-row-local:s2")).toHaveAttribute("data-checked", "true")
      expect(screen.getByTestId("issue-row-local:s1")).not.toHaveAttribute("data-checked")
    })
  })

  it("marks the keyboard cursor separately from the open row", () => {
    renderList([item(), item()], { cursorId: "local:s2", selectedId: "local:s1" })
    expect(screen.getByTestId("issue-row-local:s2")).toHaveAttribute("data-cursored", "true")
    expect(screen.getByTestId("issue-row-local:s1")).not.toHaveAttribute("data-cursored")
  })

  it("forwards the open action", () => {
    const onSelect = jest.fn()
    renderList([item()], { onSelect })
    fireEvent.click(screen.getByTestId("issue-row-open-local:s1"))
    expect(onSelect).toHaveBeenCalledWith("local:s1")
  })

  it("marks a running row", () => {
    renderList([item()], { runningIds: new Set(["local:s1"]) })
    expect(screen.getByTestId("issue-row-running-local:s1")).toBeInTheDocument()
  })

  it("records the density on the scroller, so the whole list reads as one", () => {
    renderList([item()], { density: "compact" })
    expect(screen.getByTestId("issue-list")).toHaveAttribute("data-density", "compact")
  })

  it("wraps each row when the caller supplies a menu", () => {
    renderList([item()], {
      renderItemMenu: (menuItem, children) => (
        <div data-testid={`menu-${menuItem.unifiedId}`}>{children}</div>
      ),
    })
    expect(screen.getByTestId("menu-local:s1")).toBeInTheDocument()
    expect(
      screen.getByTestId("menu-local:s1").contains(screen.getByTestId("issue-row-local:s1"))
    ).toBe(true)
  })

  it("scrolls the cursor into view, so `j` past the fold is not a no-op", () => {
    const scrollIntoView = jest.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    renderList([item(), item()], { cursorId: "local:s2" })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
  })
})
