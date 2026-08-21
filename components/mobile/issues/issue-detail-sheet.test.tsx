/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueDetailSheet } from "./issue-detail-sheet"

const label: LabelRow = {
  id: "l1",
  scope: "issue",
  name: "bug",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
}

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  return {
    unifiedId: "local:i1",
    kind: "local",
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship the board",
    status: "in_progress",
    statusCategory: statusCategoryOf("in_progress"),
    priority: "urgent",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

function renderSheet(over: Partial<React.ComponentProps<typeof IssueDetailSheet>> = {}) {
  const props: React.ComponentProps<typeof IssueDetailSheet> = {
    item: item(),
    onOpenChange: jest.fn(),
    labelsById: new Map([["l1", label]]),
    projectNamesById: new Map([["p1", "Mercury"]]),
    ...over,
  }
  return { props, ...render(<IssueDetailSheet {...props} />) }
}

describe("IssueDetailSheet", () => {
  it("stays shut without an item", () => {
    renderSheet({ item: null })
    expect(screen.queryByTestId("issues-mobile-detail")).not.toBeInTheDocument()
  })

  it("shows the identifier, title and localized properties", () => {
    renderSheet()
    expect(screen.getByText("MERC-1")).toBeInTheDocument()
    expect(screen.getByText("Ship the board")).toBeInTheDocument()
    expect(screen.getByTestId("issues-mobile-detail")).toHaveTextContent("status.in_progress")
    expect(screen.getByTestId("issues-mobile-detail")).toHaveTextContent("priority.urgent")
  })

  it("names an unassigned issue explicitly", () => {
    renderSheet()
    expect(screen.getByTestId("issues-mobile-detail-assignee-none")).toHaveTextContent(
      "actor.unassigned"
    )
  })

  it("resolves the container name", () => {
    renderSheet({ item: item({ issueProjectId: "p1" }) })
    expect(screen.getByTestId("issues-mobile-detail")).toHaveTextContent("Mercury")
  })

  it("resolves labels through the catalogue", () => {
    renderSheet({ item: item({ labelIds: ["l1"] }) })
    expect(screen.getByText("bug")).toBeInTheDocument()
  })

  it("omits the description section when there is none", () => {
    renderSheet()
    expect(screen.queryByText("detail.description")).not.toBeInTheDocument()
  })

  it("renders a description when there is one", () => {
    renderSheet({ item: item({ description: "Because reasons" }) })
    expect(screen.getByText("Because reasons")).toBeInTheDocument()
  })

  it("says it is read-only rather than leaving the user hunting for controls", () => {
    renderSheet()
    expect(screen.getByText("detail.mobileReadOnly")).toBeInTheDocument()
  })

  it("offers nothing that writes", () => {
    const { container } = renderSheet({ item: item({ description: "x", labelIds: ["l1"] }) })
    expect(container.querySelector("input, textarea, select")).toBeNull()
  })

  it("reports a close", () => {
    const { props } = renderSheet()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
