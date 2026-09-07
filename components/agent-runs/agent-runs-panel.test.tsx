import { fireEvent, render, screen, within } from "@testing-library/react"

import { AgentRunsPanel } from "./agent-runs-panel"
import {
  COCKPIT_STATUS_GROUPS,
  buildCockpitFacets,
  type CockpitFilter,
} from "@/lib/execution/cockpit-model"
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
    statusTotal: 1,
    statusCounts: { running: 1, waiting: 0, failed: 0, finished: 0 },
    kindTotal: 1,
    kindCounts: { chat: 1 },
    isLoading: false,
    hasMore: false,
    loadMore: jest.fn(),
    ...over,
  }
}

/**
 * The cockpit state as the REAL model would answer it, so a case can assert
 * the chips against the list rather than against a hand-written record that
 * cannot disagree with anything.
 */
function fromJournal(allRows: UnifiedExecutionRow[], filter: CockpitFilter = {}) {
  return {
    ...buildCockpitFacets(allRows, filter),
    allRows,
    isLoading: false,
    hasMore: false,
    loadMore: jest.fn(),
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

  /**
   * "No runs match these filters" is only honest when the reader owns a
   * control that would widen the view. A host that PINS an axis renders none,
   * so an empty Squad reads "No runs yet" instead of sending the reader
   * looking for a knob that is not on the page.
   */
  it("blames a filter only when the reader can release one", () => {
    cockpit = state({ rows: [], allRows: [] })
    const { rerender } = render(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()

    cockpit = state({ rows: [], allRows: [row()] })
    rerender(<AgentRunsPanel onSelect={jest.fn()} statusGroup="failed" onStatusGroup={jest.fn()} />)
    expect(screen.getByText("emptyFiltered")).toBeInTheDocument()

    // Same empty list, but the kind is pinned by the host and has no control.
    rerender(<AgentRunsPanel onSelect={jest.fn()} filterKind="team" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  /** A dropdown that shows a value it will not let you change is a lie. */
  it("renders the kind control only where it is one", () => {
    render(<AgentRunsPanel onSelect={jest.fn()} filterKind="team" />)
    expect(screen.queryByLabelText("filters.kindLabel")).not.toBeInTheDocument()

    render(<AgentRunsPanel onSelect={jest.fn()} filterKind="team" onFilterKind={jest.fn()} />)
    expect(screen.getByLabelText("filters.kindLabel")).toBeInTheDocument()
  })

  /**
   * The `/squads` Runs tab: six runs in the journal, two of them a Squad's.
   * The panel is pinned to `kind: "team"`, so the list renders two — while the
   * chips, counting `allRows`, read "All 6 / Failed 1 / Finished 5" over "No
   * runs match these filters". A chip and the list below it are now one
   * computation, and this walks every chip to prove it.
   */
  it("never shows a chip count the list below it cannot produce", () => {
    const journal = [
      row({ rowId: "j:1", nativeId: "1", runId: "1", label: "Chat one", status: "running" }),
      row({ rowId: "j:2", nativeId: "2", runId: "2", label: "Chat two", status: "error" }),
      row({ rowId: "j:3", nativeId: "3", runId: "3", kind: "goal", label: "G1", status: "done" }),
      row({ rowId: "j:4", nativeId: "4", runId: "4", kind: "goal", label: "G2", status: "done" }),
      row({
        rowId: "j:5",
        nativeId: "5",
        runId: "5",
        kind: "team",
        label: "Squad build",
        status: "running",
        teamId: "team_1",
      }),
      row({
        rowId: "j:6",
        nativeId: "6",
        runId: "6",
        kind: "team",
        label: "Squad ship",
        status: "error",
        teamId: "team_1",
      }),
    ]

    for (const group of ["all", ...COCKPIT_STATUS_GROUPS] as const) {
      const pinned: CockpitFilter = { kind: "team" }
      cockpit = fromJournal(journal, group === "all" ? pinned : { ...pinned, statusGroup: group })
      const view = render(
        <AgentRunsPanel
          onSelect={jest.fn()}
          filterKind="team"
          statusGroup={group}
          onStatusGroup={jest.fn()}
        />
      )

      const chip = screen.getByRole("tab", { name: new RegExp(`^filters\\.${group}`) })
      const shown = Number(/(\d+)$/.exec(chip.textContent ?? "")?.[1] ?? 0)
      const rendered = within(screen.getByRole("list", { name: "title" })).queryAllByRole(
        "button"
      ).length

      expect({ group, shown }).toEqual({ group, shown: rendered })
      view.unmount()
    }
  })

  /** The pinned scope binds the `all` chip too — it is not "everything". */
  it("counts the pinned scope on the all chip, not the whole journal", () => {
    const journal = [
      row({ rowId: "j:1", nativeId: "1", runId: "1", label: "Chat" }),
      row({ rowId: "j:2", nativeId: "2", runId: "2", kind: "goal", label: "Goal" }),
    ]
    cockpit = fromJournal(journal, { kind: "team" })
    render(<AgentRunsPanel onSelect={jest.fn()} filterKind="team" />)

    expect(screen.getByRole("tab", { name: /^filters\.all/ })).toHaveTextContent(/^filters\.all$/)
    expect(screen.getByText("empty")).toBeInTheDocument()
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

describe("pinning the panel to one source", () => {
  beforeEach(() => {
    cockpit = fromJournal([])
  })

  it("passes a Bot installation through to the cockpit query", () => {
    render(
      <AgentRunsPanel embedded onSelect={jest.fn()} filterKind="bot" botInstallationId="boti_1" />
    )
    expect(lastOptions).toMatchObject({ kind: "bot", botInstallationId: "boti_1" })
  })

  it("omits the key entirely when nothing is pinned, rather than sending undefined", () => {
    // `CockpitFilter` treats a present key as a narrowing, so an explicit
    // undefined and an absent one have to stay distinguishable.
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(lastOptions).not.toHaveProperty("botInstallationId")
    expect(lastOptions).not.toHaveProperty("teamId")
  })
})
