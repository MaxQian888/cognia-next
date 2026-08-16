/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { buildIssueGroups } from "@/lib/issues/board-model"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueList } from "./issue-list"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const kind = over.kind ?? "local"
  const sourceId = over.sourceId ?? `s${seq}`
  const status = over.status ?? "todo"
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
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
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

beforeEach(() => {
  seq = 0
})

describe("IssueList", () => {
  it("renders an empty state when there is nothing at all", () => {
    render(<IssueList groups={buildIssueGroups([], "status")} groupBy="status" />)
    expect(screen.getByTestId("issue-list-empty")).toBeInTheDocument()
  })

  it("renders a row per issue with its identifier and title", () => {
    const items = [item(), item()]
    render(<IssueList groups={buildIssueGroups(items, "none")} groupBy="none" />)
    expect(screen.getByText("MERC-1")).toBeInTheDocument()
    expect(screen.getByText("Issue 2")).toBeInTheDocument()
  })

  it("omits group headers when grouping is off", () => {
    render(<IssueList groups={buildIssueGroups([item()], "none")} groupBy="none" />)
    expect(screen.queryByText("status.todo")).not.toBeInTheDocument()
  })

  it("localizes status group headers", () => {
    const items = [item({ status: "todo" }), item({ status: "done" })]
    render(<IssueList groups={buildIssueGroups(items, "status")} groupBy="status" />)
    expect(screen.getByText("status.todo")).toBeInTheDocument()
    expect(screen.getByText("status.done")).toBeInTheDocument()
  })

  it("localizes priority group headers", () => {
    const items = [item({ priority: "urgent" })]
    render(<IssueList groups={buildIssueGroups(items, "priority")} groupBy="priority" />)
    expect(screen.getByText("priority.urgent")).toBeInTheDocument()
  })

  it("labels the unassigned bucket rather than showing an empty header", () => {
    render(<IssueList groups={buildIssueGroups([item()], "assignee")} groupBy="assignee" />)
    // The same string also appears in the row's assignee cell, so scope the
    // assertion to the group heading.
    expect(screen.getByRole("heading", { name: "actor.unassigned" })).toBeInTheDocument()
  })

  it("resolves a project group header to its name when the caller knows it", () => {
    const items = [item({ issueProjectId: "p1" })]
    render(
      <IssueList
        groups={buildIssueGroups(items, "project")}
        groupBy="project"
        projectNamesById={new Map([["p1", "Mercury"]])}
      />
    )
    expect(screen.getByText("Mercury")).toBeInTheDocument()
  })

  it("falls back to the raw id when a project name is unknown", () => {
    const items = [item({ issueProjectId: "p-unknown" })]
    render(<IssueList groups={buildIssueGroups(items, "project")} groupBy="project" />)
    expect(screen.getByText("p-unknown")).toBeInTheDocument()
  })

  it("selects on click and reflects selection to assistive tech", () => {
    const onSelect = jest.fn()
    const one = item()
    render(
      <IssueList
        groups={buildIssueGroups([one], "none")}
        groupBy="none"
        selectedId={one.unifiedId}
        onSelect={onSelect}
      />
    )
    const row = screen.getByTestId(`issue-row-${one.unifiedId}`)
    expect(row).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith(one.unifiedId)
  })

  it("badges a federated row with its source", () => {
    render(
      <IssueList groups={buildIssueGroups([item({ kind: "github" })], "none")} groupBy="none" />
    )
    expect(screen.getByText("source.github")).toBeInTheDocument()
  })

  it("shows at most two label chips so a dense row stays readable", () => {
    const labels = ["a", "b", "c"].map((id) => ({
      id,
      scope: "issue" as const,
      name: id,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    }))
    render(
      <IssueList
        groups={buildIssueGroups([item({ labelIds: ["a", "b", "c"] })], "none")}
        groupBy="none"
        labelsById={new Map(labels.map((l) => [l.id, l]))}
      />
    )
    expect(screen.getByTestId("label-chip-a")).toBeInTheDocument()
    expect(screen.getByTestId("label-chip-b")).toBeInTheDocument()
    expect(screen.queryByTestId("label-chip-c")).not.toBeInTheDocument()
  })

  it("marks an unassigned row explicitly", () => {
    render(<IssueList groups={buildIssueGroups([item()], "none")} groupBy="none" />)
    expect(screen.getByTestId("issue-row-assignee-none")).toHaveTextContent("actor.unassigned")
  })
})
