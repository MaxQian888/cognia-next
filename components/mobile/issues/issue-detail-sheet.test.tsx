/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

let eventsResult: unknown[] = []
let runsResult: unknown[] = []
jest.mock("@/hooks/data/use-dexie-first-query", () => ({
  useDexieFirstQuery: ({ query }: { query: () => Promise<unknown> }) => ({
    data: String(query).includes("listIssueRuns") ? runsResult : eventsResult,
    isSyncing: false,
    lastSyncedAt: null,
    error: null,
  }),
}))
jest.mock("@/lib/db/issue-events", () => ({ listIssueEvents: jest.fn() }))
jest.mock("@/lib/db/issue-runs", () => ({ listIssueRuns: jest.fn() }))

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

  describe("activity trail and runs", () => {
    beforeEach(() => {
      eventsResult = []
      runsResult = []
    })

    it("renders the dispatch history the phone could not see before", () => {
      runsResult = [
        {
          id: "r1",
          issueId: "i1",
          adapterId: "agent-task",
          status: "failed",
          summary: "half the tests",
          error: "boom",
        },
      ]
      renderSheet()
      expect(screen.getByTestId("issues-mobile-detail-runs")).toBeInTheDocument()
      expect(screen.getByTestId("issues-mobile-run-failed")).toBeInTheDocument()
      expect(screen.getByText("run.status.failed")).toBeInTheDocument()
      expect(screen.getByText("run.adapter.agent-task.name")).toBeInTheDocument()
      expect(screen.getByText("boom")).toBeInTheDocument()
    })

    it("renders the merged activity and comment timeline", () => {
      eventsResult = [
        {
          id: "e1",
          issueId: "i1",
          kind: "status_changed",
          ts: 2,
          payload: { kind: "status_changed", from: "todo", to: "in_progress" },
        },
        {
          id: "e2",
          issueId: "i1",
          kind: "commented",
          ts: 1,
          payload: { kind: "commented", body: "looks right to me" },
        },
      ]
      renderSheet()
      expect(screen.getByTestId("issues-mobile-detail-activity")).toBeInTheDocument()
      // The values go through the shared formatter, so the enum halves come
      // back localized rather than as raw `todo` / `in_progress`.
      expect(
        screen.getByText("activity.status_changed:status.todo,status.in_progress")
      ).toBeInTheDocument()
      expect(screen.getByText("looks right to me")).toBeInTheDocument()
    })

    it("asks for neither on a federated row, which keeps its history elsewhere", () => {
      // A GitHub or agent-board row has no trail in our tables. Rendering an
      // empty one would claim nothing ever happened to it.
      eventsResult = [{ id: "e1", issueId: "gh", kind: "created", ts: 1, payload: {} }]
      runsResult = [{ id: "r1", issueId: "gh", adapterId: "agent-task", status: "succeeded" }]
      renderSheet({ item: item({ kind: "github", sourceId: "owner/repo#1" }) })
      expect(screen.queryByTestId("issues-mobile-detail-activity")).not.toBeInTheDocument()
      expect(screen.queryByTestId("issues-mobile-detail-runs")).not.toBeInTheDocument()
    })

    it("shows neither section when the issue has no history", () => {
      renderSheet()
      expect(screen.queryByTestId("issues-mobile-detail-activity")).not.toBeInTheDocument()
      expect(screen.queryByTestId("issues-mobile-detail-runs")).not.toBeInTheDocument()
    })
  })
})
