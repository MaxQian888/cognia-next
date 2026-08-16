/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars && Object.keys(vars).length > 0
      ? `${key}:${Object.values(vars)
          .filter((v) => v !== "")
          .join(",")}`
      : key,
}))

const mockListIssueEvents = jest.fn()
jest.mock("@/lib/db/issue-events", () => ({
  listIssueEvents: (...args: unknown[]) => mockListIssueEvents(...args),
}))

// The dialog has its own suite; here it only needs to reveal what it was
// pointed at, so a mis-parsed target cannot pass unnoticed.
jest.mock("./github-writeback-dialog", () => ({
  GithubWritebackDialog: ({
    kind,
    target,
  }: {
    kind: string
    target: { repoFullName: string; number: number }
  }) => (
    <div data-testid="github-writeback-dialog">
      {kind} {target.repoFullName}#{target.number}
    </div>
  ),
}))

let liveValue: unknown = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => liveValue,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueDetailPanel } from "./issue-detail-panel"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:i1`,
    kind,
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship the board",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "high",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "https://github.test/o/r/issues/7" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  liveValue = []
})

describe("IssueDetailPanel", () => {
  it("renders the identifier, title and core properties", () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.getByText("MERC-1")).toBeInTheDocument()
    expect(screen.getByText("Ship the board")).toBeInTheDocument()
    expect(screen.getByText("status.todo")).toBeInTheDocument()
    expect(screen.getByText("priority.high")).toBeInTheDocument()
  })

  it("marks an unassigned issue explicitly", () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.getByTestId("issue-detail-assignee-none")).toHaveTextContent("actor.unassigned")
  })

  it("prefers the assignee's cached label", () => {
    render(
      <IssueDetailPanel item={item({ assignee: { kind: "team", id: "t1", label: "Falcon" } })} />
    )
    expect(screen.getByTestId("issue-detail-assignee-team:t1")).toHaveTextContent("Falcon")
  })

  it("warns that a federated row is read-only, and does not for a local one", () => {
    const { rerender } = render(<IssueDetailPanel item={item()} />)
    expect(screen.queryByTestId("issue-detail-read-only")).not.toBeInTheDocument()
    rerender(<IssueDetailPanel item={item({ kind: "github" })} />)
    expect(screen.getByTestId("issue-detail-read-only")).toBeInTheDocument()
  })

  it("offers an external link only for a federated row", () => {
    const { rerender } = render(<IssueDetailPanel item={item()} />)
    expect(screen.queryByTestId("issue-detail-external-link")).not.toBeInTheDocument()
    rerender(<IssueDetailPanel item={item({ kind: "github" })} />)
    const link = screen.getByTestId("issue-detail-external-link")
    expect(link).toHaveAttribute("href", "https://github.test/o/r/issues/7")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("renders the description only when there is one", () => {
    const { rerender } = render(<IssueDetailPanel item={item()} />)
    expect(screen.queryByText("detail.description")).not.toBeInTheDocument()
    rerender(<IssueDetailPanel item={item({ description: "why this matters" })} />)
    expect(screen.getByText("why this matters")).toBeInTheDocument()
  })

  it("says 'no labels' rather than rendering an empty row", () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.getByText("labels.none")).toBeInTheDocument()
  })

  it("renders resolved labels", () => {
    render(
      <IssueDetailPanel
        item={item({ labelIds: ["l1"] })}
        labelsById={
          new Map([
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
          ])
        }
      />
    )
    expect(screen.getByTestId("label-chip-l1")).toBeInTheDocument()
  })

  it("reads the activity trail only for a local row", () => {
    render(<IssueDetailPanel item={item({ kind: "github" })} />)
    expect(screen.queryByTestId("issue-detail-activity")).not.toBeInTheDocument()
  })

  it("localizes a status-change entry using the issue vocabulary, not stored text", () => {
    liveValue = [
      {
        id: "e1",
        issueId: "i1",
        kind: "status_changed",
        ts: 1,
        payload: { kind: "status_changed", from: "todo", to: "done", by: { kind: "human" } },
      },
    ]
    render(<IssueDetailPanel item={item()} />)
    expect(screen.getByTestId("issue-detail-activity")).toHaveTextContent(
      "activity.status_changed:status.todo,status.done"
    )
  })

  it("renders a comment's body alongside its activity line", () => {
    liveValue = [
      {
        id: "e2",
        issueId: "i1",
        kind: "commented",
        ts: 2,
        payload: { kind: "commented", commentId: "c1", body: "looks good", by: { kind: "human" } },
      },
    ]
    render(<IssueDetailPanel item={item()} />)
    expect(screen.getByText("looks good")).toBeInTheDocument()
    expect(screen.getByText("detail.comment")).toBeInTheDocument()
  })

  it("closes when asked", () => {
    const onClose = jest.fn()
    render(<IssueDetailPanel item={item()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId("issue-detail-close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders no close button without a handler", () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.queryByTestId("issue-detail-close")).not.toBeInTheDocument()
  })

  it("shows the project name when the caller resolved it", () => {
    render(
      <IssueDetailPanel
        item={item({ issueProjectId: "p1" })}
        projectNamesById={new Map([["p1", "Mercury"]])}
      />
    )
    expect(screen.getByText("Mercury")).toBeInTheDocument()
  })
})

describe("GitHub write-back", () => {
  const githubItem = (over: Partial<UnifiedIssueItem> = {}) =>
    item({
      kind: "github",
      unifiedId: "github:acme/one#7",
      sourceId: "acme/one#7",
      identifier: "acme/one#7",
      capabilities: { ...READ_ONLY_ISSUE_CAPABILITIES, canComment: true },
      ...over,
    })

  it("offers no GitHub actions on a local issue", () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.queryByTestId("issue-writeback-comment")).not.toBeInTheDocument()
  })

  it("offers them on a mirrored row", () => {
    render(<IssueDetailPanel item={githubItem()} />)
    expect(screen.getByTestId("issue-writeback-comment")).toBeInTheDocument()
    expect(screen.getByTestId("issue-writeback-label")).toBeInTheDocument()
    expect(screen.getByTestId("issue-writeback-close")).toBeInTheDocument()
  })

  it("labels them as GitHub writes, not board controls", () => {
    // The board still refuses to drag these — position is derived from GitHub.
    render(<IssueDetailPanel item={githubItem()} />)
    expect(screen.getByText("writeback.sectionHint")).toBeInTheDocument()
    expect(screen.getByTestId("issue-detail-read-only")).toBeInTheDocument()
  })

  it("greys commenting out when the source says it cannot", () => {
    render(<IssueDetailPanel item={githubItem({ capabilities: READ_ONLY_ISSUE_CAPABILITIES })} />)
    expect(screen.getByTestId("issue-writeback-comment")).toBeDisabled()
  })

  it("greys closing out on an already-closed issue", () => {
    render(
      <IssueDetailPanel
        item={githubItem({ status: "done", statusCategory: statusCategoryOf("done") })}
      />
    )
    expect(screen.getByTestId("issue-writeback-close")).toBeDisabled()
  })

  it("opens no dialog until an action is chosen", () => {
    render(<IssueDetailPanel item={githubItem()} />)
    expect(screen.queryByTestId("github-writeback-dialog")).not.toBeInTheDocument()
  })

  it("opens the confirmation dialog for the chosen action", () => {
    render(<IssueDetailPanel item={githubItem()} />)
    fireEvent.click(screen.getByTestId("issue-writeback-label"))
    expect(screen.getByTestId("github-writeback-dialog")).toHaveTextContent("label")
  })

  it("targets the repo and number parsed from the mirror id", () => {
    render(<IssueDetailPanel item={githubItem()} />)
    fireEvent.click(screen.getByTestId("issue-writeback-comment"))
    expect(screen.getByTestId("github-writeback-dialog")).toHaveTextContent("acme/one#7")
  })

  it("hides the actions when the mirror id is unparseable", () => {
    // A malformed id must not produce a write aimed at the wrong issue.
    render(<IssueDetailPanel item={githubItem({ unifiedId: "github:garbage" })} />)
    expect(screen.queryByTestId("issue-writeback-comment")).not.toBeInTheDocument()
  })
})
