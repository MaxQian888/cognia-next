/**
 * @jest-environment jsdom
 *
 * Orchestration-level tests: the rail, the filter bar, the board, the list and
 * the inspector each have their own suite, so they are stubbed here and this
 * file asserts on what the console hands them and what it does with what comes
 * back.
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

let shellProps: Record<string, unknown> = {}
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: (props: Record<string, unknown>) => {
    shellProps = props
    const { header, children, leftPane, rightPane } = props as {
      header: React.ReactNode
      children: React.ReactNode
      leftPane?: { content: React.ReactNode }
      rightPane?: { content: React.ReactNode }
    }
    return (
      <div>
        {header}
        {leftPane?.content}
        {children}
        {rightPane?.content}
      </div>
    )
  },
}))

let headerProps: Record<string, unknown> = {}
jest.mock("@/components/feature-shell/feature-page-header", () => ({
  FeaturePageHeader: (props: Record<string, unknown>) => {
    headerProps = props
    const { status, actions, controls } = props as Record<string, React.ReactNode>
    return (
      <div data-testid="header-stub">
        {status}
        {actions}
        {controls}
      </div>
    )
  },
}))

let boardProps: Record<string, unknown> = {}
jest.mock("./board/issue-board", () => ({
  IssueBoard: (props: Record<string, unknown>) => {
    boardProps = props
    return <div data-testid="board-stub" />
  },
}))
let listProps: Record<string, unknown> = {}
jest.mock("./list/issue-list", () => ({
  IssueList: (props: Record<string, unknown>) => {
    listProps = props
    return <div data-testid="list-stub" />
  },
}))
let railProps: Record<string, unknown> = {}
jest.mock("./rail/manage-labels-dialog", () => ({
  ManageLabelsDialog: (props: Record<string, unknown>) =>
    props.open ? <div data-testid="manage-labels-stub" /> : null,
}))
jest.mock("./rail/issue-rail", () => ({
  IssueRail: (props: Record<string, unknown>) => {
    railProps = props
    return <div data-testid="rail-stub" />
  },
}))
let filterBarProps: Record<string, unknown> = {}
jest.mock("./filter-bar/issue-filter-bar", () => ({
  IssueFilterBar: (props: Record<string, unknown>) => {
    filterBarProps = props
    return <div data-testid="filter-bar-stub" />
  },
}))
let bulkProps: Record<string, unknown> = {}
jest.mock("./list/issue-bulk-toolbar", () => ({
  IssueBulkToolbar: (props: Record<string, unknown>) => {
    bulkProps = props
    const items = props.items as unknown[]
    return items.length > 0 ? <div data-testid="bulk-stub">{items.length}</div> : null
  },
}))
jest.mock("./issue-context-menu", () => ({
  IssueContextMenu: (props: Record<string, unknown>) => {
    const { item, children } = props as { item: { unifiedId: string }; children: React.ReactNode }
    return <div data-testid={`context-${item.unifiedId}`}>{children}</div>
  },
}))
let deleteDialogProps: Record<string, unknown> = {}
jest.mock("./delete-issue-dialog", () => ({
  DeleteIssueDialog: (props: Record<string, unknown>) => {
    deleteDialogProps = props
    return props.open ? <div data-testid="delete-dialog-stub" /> : null
  },
}))
let detailProps: Record<string, unknown> = {}
jest.mock("./issue-detail-panel", () => ({
  IssueDetailPanel: (props: Record<string, unknown>) => {
    detailProps = props
    return <div data-testid="detail-stub" />
  },
}))
jest.mock("./create-issue-dialog", () => ({
  CreateIssueDialog: (props: Record<string, unknown>) =>
    props.open ? <div data-testid="create-dialog-stub" /> : null,
}))
jest.mock("./collab-refresh-stale-badge", () => ({
  CollabRefreshStaleBadge: () => <div data-testid="collab-refresh-stale-stub" />,
}))
jest.mock("@/hooks/issues/use-assignee-options", () => ({
  useAssigneeOptions: () => [],
}))

const mockApplyBulk = jest.fn().mockResolvedValue({ applied: 1, skipped: 0, failed: 0 })
jest.mock("@/lib/issues/bulk-actions", () => ({
  applyIssueBulkAction: (...a: unknown[]) => mockApplyBulk(...a),
}))

const mockMoveIssue = jest.fn().mockResolvedValue(null)
const mockReorderIssues = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/issues", () => ({
  listIssues: jest.fn(),
  moveIssue: (...a: unknown[]) => mockMoveIssue(...a),
  reorderIssues: (...a: unknown[]) => mockReorderIssues(...a),
}))
jest.mock("@/lib/db/issue-projects", () => ({ listIssueProjects: jest.fn() }))
jest.mock("@/lib/db/labels", () => ({ listLabels: jest.fn() }))

// Stable references on purpose: a fresh array per render would mask whether
// the console's fan-out effect is identity-fragile.
const EMPTY_ROWS: unknown[] = []
let projectsForTest: unknown[] = EMPTY_ROWS
let labelsForTest: unknown[] = EMPTY_ROWS
let runningIdsForTest: ReadonlySet<string> = new Set()
let squadRunsForTest: ReadonlyMap<string, unknown> = new Map()
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: unknown, _deps: unknown, initial: unknown) => {
    if (initial instanceof Set) return runningIdsForTest
    if (initial instanceof Map) return squadRunsForTest
    const source = String(query)
    if (source.includes("listIssueProjects")) return projectsForTest
    if (source.includes("listLabels")) return labelsForTest
    return EMPTY_ROWS
  },
}))

let viewerForTest = { selfKey: "human:self", agentKeys: [] as string[] }
jest.mock("@/lib/issues/run/running", () => ({
  SELF_ACTOR_KEY: "human:self",
  listRunningIssueIds: () => Promise.resolve(new Set()),
  listSquadRunsByIssue: () => Promise.resolve(new Map()),
  loadIssueViewerContext: () => Promise.resolve(viewerForTest),
}))

const mockListAll = jest.fn()
jest.mock("@/lib/issues/sources/registry", () => ({
  getIssueSourceRegistry: () => ({ listAll: (...a: unknown[]) => mockListAll(...a) }),
}))

const mockRunSync = jest.fn().mockResolvedValue({ repoCount: 0, results: [], failures: [] })
jest.mock("@/lib/issues/sync-runner", () => ({
  runWorkspaceGithubSync: (...a: unknown[]) => mockRunSync(...a),
}))

const toastCalls: Array<[string, unknown]> = []
jest.mock("sonner", () => ({
  toast: {
    error: (m: unknown) => toastCalls.push(["error", m]),
    success: (m: unknown) => toastCalls.push(["success", m]),
    warning: (m: unknown) => toastCalls.push(["warning", m]),
  },
}))

let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId }),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { useIssueViewStore } from "@/stores/issues/issue-view-store"
import { IssueConsole } from "./issue-console"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  const sourceId = over.sourceId ?? "i1"
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
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

/** Call a captured prop callback inside `act`. */
function callProp<T extends unknown[]>(
  props: Record<string, unknown>,
  name: string,
  ...args: T
): void {
  act(() => {
    ;(props[name] as (...a: T) => void)(...args)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  useIssueViewStore.getState().reset()
  shellProps = {}
  headerProps = {}
  boardProps = {}
  listProps = {}
  railProps = {}
  filterBarProps = {}
  bulkProps = {}
  deleteDialogProps = {}
  detailProps = {}
  toastCalls.length = 0
  activeProjectId = "w1"
  projectsForTest = EMPTY_ROWS
  labelsForTest = EMPTY_ROWS
  runningIdsForTest = new Set()
  squadRunsForTest = new Map()
  viewerForTest = { selfKey: "human:self", agentKeys: [] }
  mockListAll.mockResolvedValue({ items: [], errors: [] })
  mockRunSync.mockResolvedValue({ repoCount: 0, results: [], failures: [] })
})

describe("IssueConsole", () => {
  describe("data", () => {
    it("reads the board through the source registry, not straight from Dexie", async () => {
      render(<IssueConsole />)
      await waitFor(() => expect(mockListAll).toHaveBeenCalledWith({ projectId: "w1" }))
    })

    it("does not query when no workspace is active", async () => {
      activeProjectId = null
      render(<IssueConsole />)
      await waitFor(() => expect(mockListAll).not.toHaveBeenCalled())
    })
  })

  describe("layout", () => {
    it("mounts the rail in the shell's left pane", async () => {
      render(<IssueConsole />)
      expect(await screen.findByTestId("rail-stub")).toBeInTheDocument()
      expect(shellProps.leftPane).toBeDefined()
    })

    it("hides the rail when it is collapsed, and says so on the toggle", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("rail-stub")
      fireEvent.click(screen.getByTestId("issue-rail-toggle"))
      await waitFor(() => expect(screen.queryByTestId("rail-stub")).not.toBeInTheDocument())
      expect(shellProps.leftPane).toBeUndefined()
    })

    it("renders the filter bar above the layout rather than in the header", async () => {
      render(<IssueConsole />)
      expect(await screen.findByTestId("filter-bar-stub")).toBeInTheDocument()
      expect(headerProps.controls).toBeUndefined()
    })

    it("offers create as the header's primary action", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(headerProps.primaryAction).toMatchObject({ id: "create", disabled: false })
    })

    it("disables create without a workspace, rather than hiding it", async () => {
      activeProjectId = null
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(headerProps.primaryAction).toMatchObject({ disabled: true })
    })
  })

  describe("views and preferences", () => {
    it("opens on the board layout the default view declares", async () => {
      render(<IssueConsole />)
      expect(await screen.findByTestId("board-stub")).toBeInTheDocument()
    })

    it("follows the view's own layout when the rail switches view", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      // The `created` view ships a list layout.
      callProp(railProps, "onSelectView", "created")
      expect(await screen.findByTestId("list-stub")).toBeInTheDocument()
    })

    it("lets the filter bar override the view's layout", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      expect(await screen.findByTestId("list-stub")).toBeInTheDocument()
    })

    it("keeps each view's override apart", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      await screen.findByTestId("list-stub")

      // `assigned` also declares a board layout and must not inherit the override.
      callProp(railProps, "onSelectView", "assigned")
      expect(await screen.findByTestId("board-stub")).toBeInTheDocument()

      callProp(railProps, "onSelectView", "all")
      expect(await screen.findByTestId("list-stub")).toBeInTheDocument()
    })

    it("survives a remount, which is what the old useState version could not do", async () => {
      const { unmount } = render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      await screen.findByTestId("list-stub")
      unmount()

      render(<IssueConsole />)
      expect(await screen.findByTestId("list-stub")).toBeInTheDocument()
    })
  })

  describe("rail wiring", () => {
    it("scopes the my-agents view to the viewer's own Characters and squads", async () => {
      viewerForTest = { selfKey: "human:self", agentKeys: ["agent:a1"] }
      mockListAll.mockResolvedValue({
        items: [
          item({ assignee: { kind: "agent", id: "a1", label: "Scout" } }),
          item({ sourceId: "i2", assignee: { kind: "agent", id: "stranger" } }),
        ],
        errors: [],
      })
      render(<IssueConsole />)
      await waitFor(() =>
        expect((railProps.viewCounts as Record<string, number>)["my-agents"]).toBe(1)
      )
    })

    it("counts every view from the unfiltered scope", async () => {
      mockListAll.mockResolvedValue({
        items: [item(), item({ sourceId: "i2" })],
        errors: [],
      })
      render(<IssueConsole />)
      await waitFor(() => expect((railProps.viewCounts as Record<string, number>).all).toBe(2))
    })

    it("applies the ?project= deep link once, and only once", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole initialProjectId="p1" />)
      await waitFor(() =>
        expect((filterBarProps.filter as { issueProjectIds: string[] }).issueProjectIds).toEqual([
          "p1",
        ])
      )
      // Taking it off must stick: re-applying on every render would make the
      // container filter impossible to remove.
      callProp(
        filterBarProps,
        "onToggleProject" in railProps ? "onFilterChange" : "onFilterChange",
        {
          query: "",
          labelIds: [],
          priorities: [],
          assignees: [],
          sources: [],
          issueProjectIds: [],
        }
      )
      await waitFor(() =>
        expect((filterBarProps.filter as { issueProjectIds: string[] }).issueProjectIds).toEqual([])
      )
    })

    it("turns a project click into a filter, not a navigation", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("rail-stub")
      callProp(railProps, "onToggleProject", "p1")
      await waitFor(() =>
        expect((filterBarProps.filter as { issueProjectIds: string[] }).issueProjectIds).toEqual([
          "p1",
        ])
      )
    })

    it("opens label management from the rail — the control was never wired before", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("rail-stub")
      expect(typeof railProps.onManageLabels).toBe("function")
      callProp(railProps, "onManageLabels")
      expect(await screen.findByTestId("manage-labels-stub")).toBeInTheDocument()
    })

    it("turns a label click into a filter", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("rail-stub")
      callProp(railProps, "onToggleLabel", "l1")
      await waitFor(() =>
        expect((filterBarProps.filter as { labelIds: string[] }).labelIds).toEqual(["l1"])
      )
    })
  })

  describe("running runs", () => {
    it("passes the run index to the board — it used to be computed and dropped", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      runningIdsForTest = new Set(["i1"])
      render(<IssueConsole />)
      await waitFor(() =>
        expect(boardProps.runningIds as ReadonlySet<string>).toEqual(new Set(["local:i1"]))
      )
    })

    it("keys the squad runs by unified id, so the board can badge the card", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      const ref = { runId: "r1", teamId: "team-1", teamName: "Docs", status: "running" }
      squadRunsForTest = new Map([["i1", ref]])
      render(<IssueConsole />)
      await waitFor(() =>
        expect(boardProps.squadRuns as ReadonlyMap<string, unknown>).toEqual(
          new Map([["local:i1", ref]])
        )
      )
    })

    it("shows the agents-working badge only when something is running", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(screen.queryByTestId("issue-agents-working")).not.toBeInTheDocument()
    })

    it("shows it once a run is in flight", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      runningIdsForTest = new Set(["i1"])
      render(<IssueConsole />)
      expect(await screen.findByTestId("issue-agents-working")).toBeInTheDocument()
    })

    it("hides the degraded badge when every source is healthy", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(screen.queryByTestId("issue-source-errors")).not.toBeInTheDocument()
    })

    it("surfaces a degraded source instead of silently under-reporting", async () => {
      mockListAll.mockResolvedValue({ items: [], errors: [new Error("boom")] })
      render(<IssueConsole />)
      expect(await screen.findByTestId("issue-source-errors")).toBeInTheDocument()
    })
  })

  describe("drops", () => {
    it("persists a same-column reorder", async () => {
      mockListAll.mockResolvedValue({
        items: [item(), item({ sourceId: "i2" })],
        errors: [],
      })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onDrop", {
        type: "reorder",
        unifiedId: "local:i1",
        targetIndex: 1,
      })
      await waitFor(() => expect(mockReorderIssues).toHaveBeenCalled())
    })

    it("reports a denial returned by the write boundary itself, not just by the reducer", async () => {
      mockMoveIssue.mockResolvedValueOnce("runtime-owned")
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onDrop", { type: "move", unifiedId: "local:i1", to: "done" })
      await waitFor(() =>
        expect(toastCalls).toContainEqual(["error", "board.denied.runtime-owned:source.local"])
      )
    })

    it("stays quiet when the row simply vanished under the drop", async () => {
      mockMoveIssue.mockResolvedValueOnce("issue-not-found")
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onDrop", { type: "move", unifiedId: "local:i1", to: "done" })
      await waitFor(() => expect(mockMoveIssue).toHaveBeenCalled())
      expect(toastCalls).toEqual([])
    })

    it("writes a move through the guarded store call", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onDrop", { type: "move", unifiedId: "local:i1", to: "done" })
      await waitFor(() =>
        expect(mockMoveIssue).toHaveBeenCalledWith({
          id: "i1",
          to: "done",
          by: { kind: "human" },
        })
      )
    })

    it("localizes a denial instead of writing", async () => {
      mockListAll.mockResolvedValue({ items: [item({ kind: "github" })], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onDrop", {
        type: "denied",
        unifiedId: "github:i1",
        reason: "federated-read-only",
      })
      await waitFor(() =>
        expect(toastCalls).toContainEqual([
          "error",
          "board.denied.federated-read-only:source.github",
        ])
      )
      expect(mockMoveIssue).not.toHaveBeenCalled()
    })

    it("ignores a drop on a federated row that reached the writer anyway", async () => {
      mockListAll.mockResolvedValue({ items: [item({ kind: "github" })], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onDrop", { type: "move", unifiedId: "github:i1", to: "done" })
      await waitFor(() => expect(mockMoveIssue).not.toHaveBeenCalled())
    })
  })

  describe("bulk actions", () => {
    async function selectOne() {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      await screen.findByTestId("list-stub")
      callProp(listProps, "onToggleCheck", "local:i1", { shiftKey: false })
      await screen.findByTestId("bulk-stub")
    }

    it("shows nothing until something is ticked", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(screen.queryByTestId("bulk-stub")).not.toBeInTheDocument()
    })

    it("hands the ticked issues to the toolbar", async () => {
      await selectOne()
      expect((bulkProps.items as UnifiedIssueItem[]).map((i) => i.unifiedId)).toEqual(["local:i1"])
    })

    it("applies an action and reports the count", async () => {
      await selectOne()
      await act(async () => {
        ;(bulkProps.onAction as (a: unknown) => void)({ kind: "priority", to: "high" })
      })
      expect(mockApplyBulk).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ unifiedId: "local:i1" })]),
        { kind: "priority", to: "high" },
        { kind: "human" },
        expect.any(Set)
      )
      expect(toastCalls).toContainEqual(["success", "bulk.applied:1"])
    })

    it("says how many were skipped rather than claiming them all", async () => {
      mockApplyBulk.mockResolvedValueOnce({ applied: 1, skipped: 2, failed: 0 })
      await selectOne()
      await act(async () => {
        ;(bulkProps.onAction as (a: unknown) => void)({ kind: "priority", to: "high" })
      })
      expect(toastCalls).toContainEqual(["warning", "bulk.skipped:1,2"])
    })

    it("explains a total refusal with the guard's own reason", async () => {
      mockApplyBulk.mockResolvedValueOnce({
        applied: 0,
        skipped: 1,
        failed: 0,
        reason: "runtime-owned",
      })
      await selectOne()
      await act(async () => {
        ;(bulkProps.onAction as (a: unknown) => void)({ kind: "status", to: "done" })
      })
      expect(toastCalls).toContainEqual(["error", "board.denied.runtime-owned:source.local"])
    })

    it("reports a failure as a failure", async () => {
      mockApplyBulk.mockResolvedValueOnce({ applied: 0, skipped: 0, failed: 2 })
      await selectOne()
      await act(async () => {
        ;(bulkProps.onAction as (a: unknown) => void)({ kind: "delete" })
      })
      expect(toastCalls).toContainEqual(["error", "bulk.failed:2"])
    })

    it("clears the selection when the rows leave the result set", async () => {
      await selectOne()
      act(() => {
        mockListAll.mockResolvedValue({ items: [], errors: [] })
      })
      callProp(filterBarProps, "onFilterChange", {
        query: "nothing-matches-this",
        labelIds: [],
        priorities: [],
        assignees: [],
        sources: [],
        issueProjectIds: [],
      })
      await waitFor(() => expect(screen.queryByTestId("bulk-stub")).not.toBeInTheDocument())
    })
  })

  describe("delete", () => {
    it("keeps the dialog shut until something asks for it", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(screen.queryByTestId("delete-dialog-stub")).not.toBeInTheDocument()
    })

    it("clears the inspector and the selection once the cascade lands", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onSelect", "local:i1")
      await screen.findByTestId("detail-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      await screen.findByTestId("list-stub")
      callProp(listProps, "onToggleCheck", "local:i1", { shiftKey: false })
      callProp(bulkProps, "onRequestDelete")
      await screen.findByTestId("delete-dialog-stub")
      await act(async () => {
        await (deleteDialogProps.onConfirm as () => Promise<void>)()
      })
      await waitFor(() => expect(screen.queryByTestId("detail-stub")).not.toBeInTheDocument())
      expect(screen.queryByTestId("bulk-stub")).not.toBeInTheDocument()
    })

    it("opens with the issues it would delete", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      await screen.findByTestId("list-stub")
      callProp(listProps, "onToggleCheck", "local:i1", { shiftKey: false })
      callProp(bulkProps, "onRequestDelete")
      expect(await screen.findByTestId("delete-dialog-stub")).toBeInTheDocument()
      expect(deleteDialogProps.items as UnifiedIssueItem[]).toHaveLength(1)
    })
  })

  describe("context menu", () => {
    /**
     * The wrapper's props, read off the element it returns.
     *
     * Calling `renderItemMenu` builds an element; it does not render one, so
     * the mock component's own capture stays empty. Reading `.props` is what
     * actually proves what the console handed the menu.
     */
    function invokeMenu(props: Record<string, unknown>, target: UnifiedIssueItem) {
      const build = props.renderItemMenu as (
        item: UnifiedIssueItem,
        children: React.ReactNode
      ) => React.ReactElement<Record<string, unknown>>
      return build(target, null).props
    }

    it("wraps every card so the shared menu is reachable from the board", async () => {
      const card = item()
      mockListAll.mockResolvedValue({ items: [card], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(invokeMenu(boardProps, card).item).toBe(card)
    })

    it("wraps every row in the list too", async () => {
      const card = item()
      mockListAll.mockResolvedValue({ items: [card], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      await screen.findByTestId("list-stub")
      expect(invokeMenu(listProps, card).item).toBe(card)
    })

    it("hands write menus LOCAL labels only, never GitHub's projections", async () => {
      // Applying a `github:` id to a local issue would store a reference that
      // resolves only while that GitHub row happens to be on the board.
      const card = item()
      labelsForTest = [
        { id: "lbl_local", scope: "issue", name: "bug", sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ]
      mockListAll.mockResolvedValue({
        items: [card, item({ kind: "github", sourceId: "o/r#1", labelIds: ["github:remote"] })],
        errors: [],
      })
      render(<IssueConsole />)
      await screen.findByTestId("rail-stub")

      const menuLabels = (invokeMenu(boardProps, card).labels as Array<{ id: string }>).map(
        (label) => label.id
      )
      expect(menuLabels).toEqual(["lbl_local"])

      // The rail keeps the merged catalogue, because filtering by a GitHub
      // label is legitimate.
      const railLabels = (railProps.labels as Array<{ id: string }>).map((label) => label.id)
      expect(railLabels).toEqual(expect.arrayContaining(["lbl_local", "github:remote"]))
    })

    it("routes a single-issue action through the same reporting path as a bulk one", async () => {
      const card = item()
      mockListAll.mockResolvedValue({ items: [card], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      const menu = invokeMenu(boardProps, card)
      await act(async () => {
        ;(menu.onAction as (a: unknown) => void)({ kind: "priority", to: "low" })
      })
      expect(mockApplyBulk).toHaveBeenCalledWith(
        [card],
        { kind: "priority", to: "low" },
        { kind: "human" },
        expect.any(Set)
      )
      expect(toastCalls).toContainEqual(["success", "bulk.applied:1"])
    })
  })

  describe("inspector", () => {
    it("stays shut until a row is selected", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      expect(screen.queryByTestId("detail-stub")).not.toBeInTheDocument()
    })

    it("opens on the selected row and resolves its labels through the catalogue", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onSelect", "local:i1")
      expect(await screen.findByTestId("detail-stub")).toBeInTheDocument()
      expect(detailProps.labelsById).toBeInstanceOf(Map)
    })

    it("still re-reads the sources when the refetch itself fails", async () => {
      mockRunSync.mockRejectedValueOnce(new Error("offline"))
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onSelect", "local:i1")
      await screen.findByTestId("detail-stub")
      const before = mockListAll.mock.calls.length
      await act(async () => {
        await (detailProps.onWritebackCompleted as () => Promise<void>)()
      })
      await waitFor(() => expect(mockListAll.mock.calls.length).toBeGreaterThan(before))
    })

    it("round-trips a GitHub write-back through a full sync", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(boardProps, "onSelect", "local:i1")
      await screen.findByTestId("detail-stub")
      await act(async () => {
        await (detailProps.onWritebackCompleted as () => Promise<void>)()
      })
      expect(mockRunSync).toHaveBeenCalledWith({ projectId: "w1", full: true })
    })
  })

  describe("labels", () => {
    it("resolves GitHub's namespaced ids so no raw `github:` string reaches the UI", async () => {
      mockListAll.mockResolvedValue({
        items: [item({ kind: "github", labelIds: ["github:bug"] })],
        errors: [],
      })
      render(<IssueConsole />)
      await waitFor(() =>
        expect(
          (boardProps.labelsById as Map<string, { name: string }>).get("github:bug")?.name
        ).toBe("bug")
      )
    })
  })

  describe("view preferences", () => {
    it("resets one view back to what it declares", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      callProp(filterBarProps, "onLayoutChange", "list")
      await screen.findByTestId("list-stub")
      callProp(filterBarProps, "onResetView")
      expect(await screen.findByTestId("board-stub")).toBeInTheDocument()
    })
  })

  describe("keyboard", () => {
    it("opens the create dialog on `c`", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
      })
      expect(await screen.findByTestId("create-dialog-stub")).toBeInTheDocument()
    })

    it("opens the cursor row on Enter", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      // The cursor walks the rows, so wait for the fan-out to deliver them —
      // the board stub renders with zero items too.
      await waitFor(() => expect((boardProps.items as unknown[]).length).toBe(1))
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      })
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      })
      expect(await screen.findByTestId("detail-stub")).toBeInTheDocument()
    })

    it("ticks the cursor row on x, and Escape clears the selection", async () => {
      mockListAll.mockResolvedValue({ items: [item()], errors: [] })
      render(<IssueConsole />)
      await waitFor(() => expect((boardProps.items as unknown[]).length).toBe(1))
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      })
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }))
      })
      expect(await screen.findByTestId("bulk-stub")).toBeInTheDocument()
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      await waitFor(() => expect(screen.queryByTestId("bulk-stub")).not.toBeInTheDocument())
    })

    it("does not open it while typing", async () => {
      render(<IssueConsole />)
      await screen.findByTestId("board-stub")
      const input = document.createElement("input")
      document.body.appendChild(input)
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
      })
      expect(screen.queryByTestId("create-dialog-stub")).not.toBeInTheDocument()
      input.remove()
    })
  })
})
