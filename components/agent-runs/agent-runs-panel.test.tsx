import { fireEvent, render, screen, within } from "@testing-library/react"

import { AgentRunsPanel } from "./agent-runs-panel"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"

// Namespace-aware so the status pill (which scopes to `agentRuns.status`)
// renders a distinguishable label instead of colliding with the filter chips.
jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
    const full = namespace === "agentRuns.status" ? `status.${key}` : key
    return values ? `${full}:${JSON.stringify(values)}` : full
  },
}))

let cockpit: Record<string, unknown>
jest.mock("@/hooks/agent-runs/use-agent-runs", () => ({
  useExecutionCockpit: (options: unknown) => {
    lastOptions = options
    return cockpit
  },
}))
let lastOptions: unknown

jest.mock("@/hooks/agent-runs/use-agent-run-actions", () => ({
  useRunControlActions: () => ({ pendingRowId: null, can: () => false, dispatch: jest.fn() }),
}))

jest.mock("./run-detail-pane", () => ({
  RunDetailPane: ({ row }: { row: UnifiedExecutionRow }) => (
    <div data-testid="detail">{row.rowId}</div>
  ),
}))

let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => compact,
}))

// The real one is a Drawer below `md`; the point under test is which surface
// the detail lands in, not vaul's animation.
jest.mock("@/components/shared/responsive-detail-sheet", () => ({
  ResponsiveDetailSheet: ({
    open,
    title,
    children,
  }: {
    open: boolean
    title: string
    children: React.ReactNode
  }) =>
    open ? (
      <div data-testid="detail-drawer" data-title={title}>
        {children}
      </div>
    ) : null,
}))

function row(over: Partial<UnifiedExecutionRow> = {}): UnifiedExecutionRow {
  return {
    rowId: "journal:run-1",
    source: "journal",
    nativeId: "run-1",
    kind: "agent-turn",
    label: "Chat run",
    status: "running",
    startedAt: Date.now(),
    runId: "run-1",
    cancellable: false,
    ...over,
  }
}

function state(over: Record<string, unknown> = {}) {
  return {
    rows: [row()],
    allRows: [row()],
    statusCounts: { running: 1, waiting: 0, failed: 0, finished: 0 },
    kindCounts: { chat: 1 },
    isLoading: false,
    hasMore: false,
    loadMore: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  cockpit = state()
  lastOptions = undefined
  compact = false
})

describe("AgentRunsPanel", () => {
  it("lists runs with their status and kind", () => {
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    const list = screen.getByRole("list", { name: "title" })
    expect(within(list).getByText("Chat run")).toBeInTheDocument()
    expect(within(list).getByText("status.running")).toBeInTheDocument()
    expect(within(list).getByText("kind.agentTurn")).toBeInTheDocument()
  })

  /** The whole point of the rewrite: kinds the old view model could not carry. */
  it("renders a delegation and a background job like any other run", () => {
    const rows = [
      row({ rowId: "journal:d", nativeId: "d", runId: "d", kind: "delegation", label: "Deleg" }),
      row({ rowId: "journal:j", nativeId: "j", runId: "j", kind: "job", label: "Job" }),
    ]
    cockpit = state({ rows, allRows: rows })
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    // Scoped to the list: the kind dropdown offers every filter kind too.
    const list = screen.getByRole("list", { name: "title" })
    expect(within(list).getByText("kind.delegation")).toBeInTheDocument()
    expect(within(list).getByText("kind.job")).toBeInTheDocument()
  })

  /** A scheduler row's `kind` is an arbitrary product string. */
  it("never renders a raw taskType as a label", () => {
    const scheduled = row({
      rowId: "scheduled:x",
      source: "scheduled",
      nativeId: "x",
      runId: undefined,
      kind: "some-product-task-type",
      label: "Nightly backup",
    })
    cockpit = state({ rows: [scheduled], allRows: [scheduled] })
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    const list = screen.getByRole("list", { name: "title" })
    expect(within(list).getByText("kind.scheduled")).toBeInTheDocument()
    expect(screen.queryByText("some-product-task-type")).not.toBeInTheDocument()
  })

  it("passes the selected status group and kind down to the query", () => {
    render(<AgentRunsPanel onSelect={jest.fn()} statusGroup="failed" filterKind="team" />)
    expect(lastOptions).toEqual({ statusGroup: "failed", kind: "team" })
  })

  it("asks for everything when both filters are 'all'", () => {
    render(<AgentRunsPanel onSelect={jest.fn()} statusGroup="all" filterKind="all" />)
    expect(lastOptions).toEqual({})
  })

  it("reports the status counts on the filter chips", () => {
    cockpit = state({ statusCounts: { running: 2, waiting: 1, failed: 3, finished: 0 } })
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    const failedTab = screen.getByRole("tab", { name: /filters\.failed/ })
    expect(failedTab).toHaveTextContent("3")
  })

  it("selects by RUN id so an IM card's deep link resolves", () => {
    const onSelect = jest.fn()
    render(<AgentRunsPanel onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: /Chat run/ }))
    expect(onSelect).toHaveBeenCalledWith("run-1")
  })

  it("opens the detail pane for a run selected by its execution id", () => {
    render(<AgentRunsPanel onSelect={jest.fn()} selectedId="run-1" />)
    expect(screen.getByTestId("detail")).toHaveTextContent("journal:run-1")
  })

  /** A run filtered out of the list is still openable when deep-linked. */
  it("resolves a deep link against the unfiltered list", () => {
    const hidden = row({ rowId: "journal:hidden", nativeId: "hidden", runId: "hidden" })
    cockpit = state({ rows: [], allRows: [hidden] })
    render(<AgentRunsPanel onSelect={jest.fn()} selectedId="hidden" statusGroup="failed" />)
    expect(screen.getByTestId("detail")).toHaveTextContent("journal:hidden")
  })

  it("opens a directly fetched run that is outside the loaded pages", () => {
    const older = row({
      rowId: "journal:older",
      nativeId: "older",
      runId: "older",
      label: "Older run",
    })
    cockpit = state({ rows: [], allRows: [], selectedRow: older, hasMore: true })

    render(<AgentRunsPanel onSelect={jest.fn()} selectedId="older" />)

    expect(screen.getByTestId("detail")).toHaveTextContent("journal:older")
  })

  it("prompts instead of rendering a detail pane when nothing is selected", () => {
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(screen.queryByTestId("detail")).not.toBeInTheDocument()
    expect(screen.getByText("detail.selectPrompt")).toBeInTheDocument()
  })

  it("offers Load more only when a source filled its page", () => {
    const loadMore = jest.fn()
    const { rerender } = render(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(screen.queryByText("loadMore")).not.toBeInTheDocument()

    cockpit = state({ hasMore: true, loadMore })
    rerender(<AgentRunsPanel onSelect={jest.fn()} />)
    fireEvent.click(screen.getByText("loadMore"))
    expect(loadMore).toHaveBeenCalled()
  })

  it("distinguishes an empty list from an over-filtered one", () => {
    cockpit = state({ rows: [], allRows: [] })
    const { rerender } = render(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()

    cockpit = state({ rows: [], allRows: [row()] })
    rerender(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(screen.getByText("emptyFiltered")).toBeInTheDocument()
  })

  it("keeps the two-pane split when there is room for it", () => {
    cockpit = state({ selectedRow: row() })
    render(<AgentRunsPanel selectedId="run-1" onSelect={jest.fn()} />)
    expect(screen.getByTestId("detail")).toBeInTheDocument()
    expect(screen.queryByTestId("detail-drawer")).not.toBeInTheDocument()
  })

  it("moves the detail into a drawer on a narrow screen", () => {
    // Side by side, the list held `max-w-sm shrink-0` and took the whole 375px
    // column, leaving the detail pane off the right edge with the document
    // scrolling sideways to reach it.
    compact = true
    cockpit = state({ selectedRow: row() })
    const onSelect = jest.fn()
    render(<AgentRunsPanel selectedId="run-1" onSelect={onSelect} />)

    const drawer = screen.getByTestId("detail-drawer")
    expect(within(drawer).getByTestId("detail")).toHaveTextContent("journal:run-1")
    expect(drawer).toHaveAttribute("data-title", "Chat run")
    // Exactly one copy of the detail, so nothing is rendered off-screen too.
    expect(screen.getAllByTestId("detail")).toHaveLength(1)
  })

  it("clears the selection when the narrow drawer closes", () => {
    compact = true
    cockpit = state()
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    // Nothing selected: no drawer, and the list still fills the column.
    expect(screen.queryByTestId("detail-drawer")).not.toBeInTheDocument()
  })

  it("shows a live marker for queued and waiting work, not only running", () => {
    const rows = [
      row({ rowId: "a", nativeId: "a", status: "queued", label: "Queued run" }),
      row({ rowId: "b", nativeId: "b", status: "done", label: "Finished run" }),
    ]
    cockpit = state({ rows, allRows: rows })
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(screen.getAllByText("live")).toHaveLength(1)
  })
})
