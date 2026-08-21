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
let runsValue: unknown[] = []
jest.mock("@/hooks/data", () => ({
  // Two live queries share the hook: the activity trail and the run history.
  useClientLiveQuery: (fn: () => unknown) =>
    fn.toString().includes("listIssueRuns") ? runsValue : liveValue,
}))
jest.mock("@/lib/db/issue-runs", () => ({ listIssueRuns: jest.fn() }))

// Pro IDE binding + transport — the "open in Pro IDE" affordance reads the
// bound root after mount and drives code-server directly.
let mockProIdeRoot: string | null = "/repo"
jest.mock("@/lib/codeserver/pane-manager", () => ({
  getActiveProIdeRoot: () => mockProIdeRoot,
}))
const mockDriveOpen = jest.fn().mockResolvedValue(undefined)
const mockOpenFile = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    driveOpen: (...a: unknown[]) => mockDriveOpen(...a),
    openFile: (...a: unknown[]) => mockOpenFile(...a),
  },
}))

const mockSetIssueAssignee = jest.fn()
const mockAddIssueComment = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/issues", () => ({
  setIssueAssignee: (...a: unknown[]) => mockSetIssueAssignee(...a),
  addIssueComment: (...a: unknown[]) => mockAddIssueComment(...a),
}))
const mockCancelIssueRun = jest.fn()
jest.mock("@/lib/issues/run/registry", () => ({
  cancelIssueRun: (...a: unknown[]) => mockCancelIssueRun(...a),
}))
const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}))

// The picker and the run dialog have their own suites; stubs expose their props.
let pickerProps: { value: unknown; onChange: (actor: unknown) => void } | null = null
jest.mock("./assignee-picker", () => ({
  AssigneePicker: (props: { value: unknown; onChange: (actor: unknown) => void }) => {
    pickerProps = props
    return <div data-testid="assignee-picker-stub" />
  },
}))
jest.mock("./run-issue-dialog", () => ({
  RunIssueDialog: (props: {
    open: boolean
    issueId: string
    onOpenChange: (o: boolean) => void
  }) =>
    props.open ? (
      <div data-testid="run-dialog-stub">
        {props.issueId}
        <button data-testid="run-dialog-close" onClick={() => props.onOpenChange(false)} />
      </div>
    ) : null,
}))

import userEvent from "@testing-library/user-event"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
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
  runsValue = []
  pickerProps = null
  mockSetIssueAssignee.mockResolvedValue(undefined)
  mockCancelIssueRun.mockResolvedValue(undefined)
})

describe("IssueDetailPanel", () => {
  it("renders the identifier, title and core properties", () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.getByText("MERC-1")).toBeInTheDocument()
    expect(screen.getByText("Ship the board")).toBeInTheDocument()
    expect(screen.getByText("status.todo")).toBeInTheDocument()
    expect(screen.getByText("priority.high")).toBeInTheDocument()
  })

  it("marks an unassigned federated issue explicitly (read-only rows keep the text)", () => {
    render(<IssueDetailPanel item={item({ kind: "github" })} />)
    expect(screen.getByTestId("issue-detail-assignee-none")).toHaveTextContent("actor.unassigned")
  })

  it("prefers the assignee's cached label on a read-only row", () => {
    render(
      <IssueDetailPanel
        item={item({ kind: "github", assignee: { kind: "team", id: "t1", label: "Falcon" } })}
      />
    )
    expect(screen.getByTestId("issue-detail-assignee-team:t1")).toHaveTextContent("Falcon")
  })

  it("lets a local issue be (re)assigned through the picker", async () => {
    render(<IssueDetailPanel item={item({ assignee: { kind: "agent", id: "c1" } })} />)
    expect(screen.getByTestId("assignee-picker-stub")).toBeInTheDocument()
    expect(pickerProps!.value).toEqual({ kind: "agent", id: "c1" })
    pickerProps!.onChange({ kind: "team", id: "t1", label: "Squad" })
    await waitFor(() =>
      expect(mockSetIssueAssignee).toHaveBeenCalledWith(
        "i1",
        { kind: "team", id: "t1", label: "Squad" },
        { kind: "human" }
      )
    )
    mockSetIssueAssignee.mockRejectedValueOnce(new Error("nope"))
    pickerProps!.onChange(null)
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("nope"))
  })

  it("offers Run on a local issue and opens the run dialog", async () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.getByTestId("issue-detail-runs")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("issue-run-trigger"))
    expect(await screen.findByTestId("run-dialog-stub")).toHaveTextContent("i1")
    fireEvent.click(screen.getByTestId("run-dialog-close"))
    await waitFor(() => expect(screen.queryByTestId("run-dialog-stub")).not.toBeInTheDocument())
  })

  it("greys Run out on finished issues and hides it on federated rows", () => {
    const { unmount } = render(
      <IssueDetailPanel item={item({ status: "done", statusCategory: "completed" })} />
    )
    expect(screen.getByTestId("issue-run-trigger")).toBeDisabled()
    unmount()
    render(<IssueDetailPanel item={item({ kind: "github" })} />)
    expect(screen.queryByTestId("issue-detail-runs")).not.toBeInTheDocument()
  })

  it("lists run history with artifacts and cancels the active run", async () => {
    runsValue = [
      {
        id: "run-2",
        issueId: "i1",
        adapterId: "agent-team",
        kind: "agent-team",
        status: "running",
        artifacts: [],
      },
      {
        id: "run-1",
        issueId: "i1",
        adapterId: "agent-task",
        kind: "agent-task",
        status: "failed",
        error: "boom",
        summary: "did some",
        artifacts: [
          { label: "PR #1", href: "https://gh/pr/1" },
          { label: "Session", href: "/?session=s" },
        ],
      },
    ]
    render(<IssueDetailPanel item={item({ status: "in_progress", statusCategory: "started" })} />)
    expect(screen.getByTestId("issue-run-running")).toHaveTextContent("run.adapter.agent-team.name")
    expect(screen.getByTestId("issue-run-failed")).toHaveTextContent("boom")
    expect(screen.getByTestId("issue-run-failed")).toHaveTextContent("did some")
    const links = screen.getAllByTestId("issue-run-artifact")
    expect(links[0]).toHaveAttribute("target", "_blank")
    expect(links[1]).not.toHaveAttribute("target")
    expect(screen.getByText("run.activeHint")).toBeInTheDocument()
    expect(screen.queryByTestId("issue-run-trigger")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("issue-run-cancel"))
    await waitFor(() => expect(mockCancelIssueRun).toHaveBeenCalledWith("run-2"))
    expect(mockToastSuccess).toHaveBeenCalledWith("run.cancelled")
    mockCancelIssueRun.mockRejectedValueOnce(new Error("cannot"))
    fireEvent.click(screen.getByTestId("issue-run-cancel"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("cannot"))
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
    // The composer's send button carries the same label, so scope to the trail.
    expect(
      within(screen.getByTestId("issue-detail-activity")).getByText("detail.comment")
    ).toBeInTheDocument()
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

describe("open in Pro IDE", () => {
  /** The button is now per-reference: one id per path found. */
  const testId = (path: string) => `issue-detail-open-in-pro-ide-${path}`

  beforeEach(() => {
    mockProIdeRoot = "/repo"
    mockDriveOpen.mockClear().mockResolvedValue(undefined)
    mockOpenFile.mockClear().mockResolvedValue(undefined)
  })

  it("offers the file an issue names in its title", async () => {
    render(<IssueDetailPanel item={item({ title: "crash in lib/foo/bar.ts:42" })} />)
    const button = await screen.findByTestId(testId("lib/foo/bar.ts"))
    fireEvent.click(button)
    await waitFor(() =>
      expect(mockDriveOpen).toHaveBeenCalledWith("/repo", "/repo/lib/foo/bar.ts", 42, undefined)
    )
  })

  it("finds a path in the description too", async () => {
    render(
      <IssueDetailPanel item={item({ title: "Login broken", description: "see src/auth.ts" })} />
    )
    fireEvent.click(await screen.findByTestId(testId("src/auth.ts")))
    await waitFor(() =>
      expect(mockDriveOpen).toHaveBeenCalledWith("/repo", "/repo/src/auth.ts", undefined, undefined)
    )
  })

  it("stays hidden when the issue names no file", async () => {
    // An affordance that is usually disabled teaches people to ignore it.
    render(<IssueDetailPanel item={item({ title: "The login button is the wrong colour" })} />)
    await waitFor(() => expect(screen.getByTestId("assignee-picker-stub")).toBeInTheDocument())
    expect(screen.queryByTestId("issue-detail-file-references")).toBeNull()
  })

  it("stays hidden when no Pro IDE is bound", async () => {
    mockProIdeRoot = null
    render(<IssueDetailPanel item={item({ title: "crash in lib/a.ts" })} />)
    await waitFor(() => expect(screen.getByTestId("assignee-picker-stub")).toBeInTheDocument())
    expect(screen.queryByTestId("issue-detail-file-references")).toBeNull()
  })

  it("falls back to the CLI opener when the companion extension is absent", async () => {
    mockDriveOpen.mockRejectedValueOnce(new Error("no extension connected"))
    render(<IssueDetailPanel item={item({ title: "crash in lib/a.ts" })} />)
    fireEvent.click(await screen.findByTestId(testId("lib/a.ts")))
    await waitFor(() =>
      expect(mockOpenFile).toHaveBeenCalledWith("/repo", "/repo/lib/a.ts", undefined, undefined)
    )
  })

  it("does not touch the issue's state — opening a file is not a run", async () => {
    render(<IssueDetailPanel item={item({ title: "crash in lib/a.ts" })} />)
    fireEvent.click(await screen.findByTestId(testId("lib/a.ts")))
    await waitFor(() => expect(mockDriveOpen).toHaveBeenCalled())
    expect(mockSetIssueAssignee).not.toHaveBeenCalled()
  })
})

/*
 * The editing surface. Every one of these controls reaches an export that had
 * no caller anywhere in the app before this change: `updateIssue` (title,
 * description, priority), `addIssueComment`, `moveIssueToProject`,
 * `addIssueLabel` / `removeIssueLabel` and `deleteIssue`.
 */
describe("editing", () => {
  const project: IssueProject = {
    id: "p1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "in_progress",
    priority: "medium",
    resources: [],
    createdAt: 0,
    updatedAt: 0,
  }
  const label: LabelRow = {
    id: "l1",
    scope: "issue",
    name: "bug",
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  }

  function editable(over: Partial<React.ComponentProps<typeof IssueDetailPanel>> = {}) {
    const onAction = jest.fn()
    render(
      <IssueDetailPanel
        item={item()}
        labels={[label]}
        projects={[project]}
        assigneeOptions={[]}
        onAction={onAction}
        {...over}
      />
    )
    return onAction
  }

  it("renames through the title editor", async () => {
    const user = userEvent.setup()
    const onAction = editable()
    await user.click(screen.getByTestId("issue-detail-title"))
    await user.clear(screen.getByTestId("issue-detail-title-input"))
    await user.type(screen.getByTestId("issue-detail-title-input"), "Renamed{Enter}")
    expect(onAction).toHaveBeenCalledWith({ kind: "title", to: "Renamed" })
  })

  it("edits the description, and offers the editor even when it is empty", async () => {
    const user = userEvent.setup()
    const onAction = editable()
    await user.click(screen.getByTestId("issue-detail-description"))
    await user.type(screen.getByTestId("issue-detail-description-input"), "Because reasons")
    fireEvent.blur(screen.getByTestId("issue-detail-description-input"))
    expect(onAction).toHaveBeenCalledWith({ kind: "description", to: "Because reasons" })
  })

  it("changes status from the property menu", async () => {
    const user = userEvent.setup()
    const onAction = editable()
    await user.click(screen.getByTestId("issue-detail-status"))
    await user.click(await screen.findByTestId("issue-detail-status-done"))
    expect(onAction).toHaveBeenCalledWith({ kind: "status", to: "done" })
  })

  it("changes priority", async () => {
    const user = userEvent.setup()
    const onAction = editable()
    await user.click(screen.getByTestId("issue-detail-priority"))
    await user.click(await screen.findByTestId("issue-detail-priority-urgent"))
    expect(onAction).toHaveBeenCalledWith({ kind: "priority", to: "urgent" })
  })

  it("moves the issue to another container", async () => {
    const user = userEvent.setup()
    const onAction = editable()
    await user.click(screen.getByTestId("issue-detail-project"))
    await user.click(await screen.findByTestId("issue-detail-project-p1"))
    expect(onAction).toHaveBeenCalledWith({ kind: "project", issueProjectId: "p1" })
  })

  it("applies a label", async () => {
    const user = userEvent.setup()
    const onAction = editable()
    await user.click(screen.getByTestId("issue-detail-labels"))
    await user.click(await screen.findByTestId("issue-detail-labels-l1"))
    expect(onAction).toHaveBeenCalledWith({ kind: "addLabel", labelId: "l1" })
  })

  it("writes a comment", async () => {
    const user = userEvent.setup()
    editable()
    await user.type(screen.getByTestId("issue-comment-input"), "looks good")
    await user.click(screen.getByTestId("issue-comment-submit"))
    await waitFor(() =>
      expect(mockAddIssueComment).toHaveBeenCalledWith("i1", "looks good", { kind: "human" })
    )
  })

  it("routes delete through a confirmation", async () => {
    const user = userEvent.setup()
    const onRequestDelete = jest.fn()
    editable({ onRequestDelete })
    await user.click(screen.getByTestId("issue-detail-delete"))
    expect(onRequestDelete).toHaveBeenCalled()
  })

  it("locks the status menu while a run holds the issue", async () => {
    const user = userEvent.setup()
    editable({ running: true })
    await user.click(screen.getByTestId("issue-detail-status"))
    expect(await screen.findByTestId("issue-detail-status-in_progress")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  describe("federated rows", () => {
    it("renders the properties without triggers rather than offering doomed controls", () => {
      render(
        <IssueDetailPanel
          item={item({ kind: "github" })}
          labels={[label]}
          projects={[project]}
          assigneeOptions={[]}
          onAction={jest.fn()}
        />
      )
      expect(screen.queryByTestId("issue-detail-status")).not.toBeInTheDocument()
      expect(screen.getByTestId("issue-detail-status-static")).toBeInTheDocument()
    })

    it("gives them no comment composer — a mirror comment goes through write-back", () => {
      render(<IssueDetailPanel item={item({ kind: "agent-task" })} onAction={jest.fn()} />)
      expect(screen.queryByTestId("issue-comment-composer")).not.toBeInTheDocument()
    })

    it("never offers delete", () => {
      render(
        <IssueDetailPanel
          item={item({ kind: "github" })}
          onAction={jest.fn()}
          onRequestDelete={jest.fn()}
        />
      )
      expect(screen.queryByTestId("issue-detail-delete")).not.toBeInTheDocument()
    })
  })

  it("falls back to a read-only panel when the caller supplies no action handler", () => {
    render(<IssueDetailPanel item={item()} />)
    expect(screen.queryByTestId("issue-detail-status")).not.toBeInTheDocument()
    expect(screen.getByTestId("issue-detail-title")).toBeDisabled()
  })
})
