/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueRow } from "./issue-row"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:i1`,
    kind,
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship it",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const label = (id: string, name: string): LabelRow => ({
  id,
  scope: "issue",
  name,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
})

function renderRow(over: Partial<React.ComponentProps<typeof IssueRow>> = {}) {
  const props: React.ComponentProps<typeof IssueRow> = {
    item: item(),
    density: "comfortable",
    selected: false,
    checked: false,
    cursored: false,
    onOpen: jest.fn(),
    onToggleCheck: jest.fn(),
    ...over,
  }
  return { props, ...render(<IssueRow {...props} />) }
}

describe("IssueRow", () => {
  it("renders the identifier and title", () => {
    renderRow()
    expect(screen.getByTestId("issue-row-local:i1")).toHaveTextContent("MERC-1")
    expect(screen.getByTestId("issue-row-open-local:i1")).toHaveTextContent("Ship it")
  })

  it("opens on the title, which is the row's flexible column", () => {
    const onOpen = jest.fn()
    renderRow({ onOpen })
    fireEvent.click(screen.getByTestId("issue-row-open-local:i1"))
    expect(onOpen).toHaveBeenCalled()
  })

  describe("selection versus ticking", () => {
    it("keeps them separate — opening a row is not including it in a bulk edit", () => {
      renderRow({ selected: true, checked: false })
      const row = screen.getByTestId("issue-row-local:i1")
      expect(row).not.toHaveAttribute("data-checked")
      expect(screen.getByTestId("issue-row-open-local:i1")).toHaveAttribute("aria-pressed", "true")
    })

    it("ticks through the checkbox", () => {
      const onToggleCheck = jest.fn()
      renderRow({ onToggleCheck })
      fireEvent.click(screen.getByTestId("issue-row-check-local:i1"))
      expect(onToggleCheck).toHaveBeenCalledWith({ shiftKey: false })
    })

    it("reports shift so the list can extend a range", () => {
      const onToggleCheck = jest.fn()
      renderRow({ onToggleCheck })
      fireEvent.click(screen.getByTestId("issue-row-check-local:i1"), { shiftKey: true })
      expect(onToggleCheck).toHaveBeenCalledWith({ shiftKey: true })
    })

    it("hides the checkbox when the list is not selectable", () => {
      renderRow({ selectable: false })
      expect(screen.queryByTestId("issue-row-check-local:i1")).not.toBeInTheDocument()
    })

    it("marks a ticked row for the eye as well as for the DOM", () => {
      renderRow({ checked: true })
      expect(screen.getByTestId("issue-row-local:i1")).toHaveAttribute("data-checked", "true")
    })
  })

  describe("density", () => {
    it("uses roomier padding when comfortable", () => {
      renderRow({ density: "comfortable" })
      expect(screen.getByTestId("issue-row-local:i1").className).toContain("py-2.5")
    })

    it("tightens up when compact", () => {
      renderRow({ density: "compact" })
      expect(screen.getByTestId("issue-row-local:i1").className).toContain("py-1")
    })
  })

  describe("labels", () => {
    it("renders the first two", () => {
      renderRow({ labels: [label("a", "bug"), label("b", "chore")] })
      expect(screen.getByText("bug")).toBeInTheDocument()
      expect(screen.getByText("chore")).toBeInTheDocument()
    })

    it("collapses the rest into a count rather than overflowing the row", () => {
      renderRow({ labels: [label("a", "1"), label("b", "2"), label("c", "3"), label("d", "4")] })
      expect(screen.getByText("list.moreLabels:2")).toBeInTheDocument()
    })
  })

  it("badges a federated row with its source", () => {
    renderRow({ item: item({ kind: "github" }) })
    expect(screen.getByTestId("issue-row-github:i1")).toHaveTextContent("source.github")
  })

  it("labels an unassigned row explicitly rather than leaving it blank", () => {
    renderRow()
    expect(screen.getByTestId("issue-row-assignee-none")).toHaveTextContent("actor.unassigned")
  })

  it("prefers the assignee's cached display name", () => {
    renderRow({ item: item({ assignee: { kind: "agent", id: "a1", label: "Scout" } }) })
    expect(screen.getByTestId("issue-row-assignee-agent:a1")).toHaveTextContent("Scout")
  })

  it("marks a running row", () => {
    renderRow({ running: true })
    expect(screen.getByTestId("issue-row-running-local:i1")).toBeInTheDocument()
  })

  it("marks the keyboard cursor", () => {
    renderRow({ cursored: true })
    expect(screen.getByTestId("issue-row-local:i1")).toHaveAttribute("data-cursored", "true")
  })

  it("shows the project name when the caller resolved one", () => {
    renderRow({ projectName: "Mercury" })
    expect(screen.getByTestId("issue-row-local:i1")).toHaveTextContent("Mercury")
  })
})
