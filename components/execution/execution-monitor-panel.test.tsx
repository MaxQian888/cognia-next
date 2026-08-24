import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ExecutionMonitorState } from "./use-execution-monitor"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import {
  DEFAULT_EXECUTION_MONITOR_PREFS,
  type ExecutionMonitorPrefs,
} from "@/lib/execution/monitor-prefs"

const cancelMock = jest.fn()
const cancelAllMock = jest.fn()
jest.mock("@/lib/execution/broker", () => ({
  getExecutionBroker: () => ({ cancel: cancelMock, cancelAll: cancelAllMock }),
}))

let monitorState: ExecutionMonitorState
jest.mock("./use-execution-monitor", () => ({
  useExecutionMonitor: () => monitorState,
}))

const promoteMock = jest.fn().mockResolvedValue({ seeded: true })
jest.mock("@/lib/execution/promote-to-pane", () => ({
  promoteLegToPane: (id: string) => promoteMock(id),
}))

const toggleKindMock = jest.fn().mockResolvedValue(undefined)
const setSortMock = jest.fn().mockResolvedValue(undefined)
const setGroupByKindMock = jest.fn().mockResolvedValue(undefined)
const setShowElapsedMock = jest.fn().mockResolvedValue(undefined)
const resetMock = jest.fn().mockResolvedValue(undefined)
let prefsState: ExecutionMonitorPrefs
let isDefaultState: boolean
jest.mock("@/hooks/execution/use-execution-monitor-prefs", () => ({
  useExecutionMonitorPrefs: () => ({
    prefs: prefsState,
    toggleKind: toggleKindMock,
    setSort: setSortMock,
    setGroupByKind: setGroupByKindMock,
    setShowElapsed: setShowElapsedMock,
    isDefault: isDefaultState,
    reset: resetMock,
  }),
}))

import { ExecutionMonitorPanel } from "./execution-monitor-panel"

const row = (o: Partial<UnifiedExecutionRow>): UnifiedExecutionRow => ({
  rowId: "broker:leg1",
  source: "broker",
  nativeId: "leg1",
  kind: "connector",
  label: "WeCom reply",
  status: "running",
  startedAt: 1,
  legId: "leg1",
  cancellable: true,
  ...o,
})

beforeEach(() => {
  cancelMock.mockReset()
  cancelAllMock.mockReset()
  promoteMock.mockReset().mockResolvedValue({ seeded: true })
  toggleKindMock.mockClear()
  setSortMock.mockClear()
  setGroupByKindMock.mockClear()
  setShowElapsedMock.mockClear()
  resetMock.mockClear()
  monitorState = { rows: [], runningCount: 0, isLoading: false }
  // Elapsed off by default so the 1s tick interval never starts mid-test.
  prefsState = { ...DEFAULT_EXECUTION_MONITOR_PREFS, showElapsed: false }
  isDefaultState = true
})

describe("ExecutionMonitorPanel", () => {
  it("renders the title and the empty state when nothing runs", () => {
    render(<ExecutionMonitorPanel />)
    expect(screen.getByRole("heading", { name: "Execution Monitor" })).toBeInTheDocument()
    expect(screen.getByText("Nothing is running right now.")).toBeInTheDocument()
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
  })

  it("renders a row per leg with its kind + status label", () => {
    monitorState = {
      rows: [
        row({ rowId: "broker:leg1", kind: "connector", label: "WeCom reply", status: "running" }),
        row({
          rowId: "workflow:run1",
          source: "workflow",
          kind: "workflow",
          label: "Nightly digest",
          status: "waiting",
          legId: undefined,
          cancellable: false,
        }),
      ],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(screen.getByText("WeCom reply")).toBeInTheDocument()
    expect(screen.getByText("Nightly digest")).toBeInTheDocument()
    expect(screen.getByText("Connector")).toBeInTheDocument()
    expect(screen.getByText("Workflow")).toBeInTheDocument()
    expect(screen.getByText("Running")).toBeInTheDocument()
    expect(screen.getByText("Waiting")).toBeInTheDocument()
    // Running count chip is derived from the (visible) rows.
    expect(screen.getByText("1 running")).toBeInTheDocument()
  })

  it("promotes a conversational leg (one with a sessionId) to a watchable pane", async () => {
    const user = userEvent.setup()
    monitorState = {
      rows: [row({ sessionId: "sess-9", label: "Goal turn" })],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    await user.click(screen.getByRole("button", { name: "Watch Goal turn" }))
    expect(promoteMock).toHaveBeenCalledWith("sess-9")
  })

  it("shows no watch button for rows without a session", () => {
    monitorState = {
      rows: [
        row({
          rowId: "workflow:run1",
          source: "workflow",
          kind: "workflow",
          label: "Nightly digest",
          sessionId: undefined,
          legId: undefined,
          cancellable: false,
        }),
      ],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    expect(screen.queryByRole("button", { name: /Watch/ })).not.toBeInTheDocument()
  })

  it("cancels a single leg via the broker", async () => {
    const user = userEvent.setup()
    monitorState = {
      rows: [row({ legId: "leg1", label: "WeCom reply" })],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    await user.click(screen.getByRole("button", { name: "Cancel WeCom reply" }))
    expect(cancelMock).toHaveBeenCalledWith("leg1")
  })

  it("shows Cancel all only when something is cancellable and wires it to the broker", async () => {
    const user = userEvent.setup()
    monitorState = {
      rows: [row({ legId: "leg1" })],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    await user.click(screen.getByRole("button", { name: "Cancel all" }))
    expect(cancelAllMock).toHaveBeenCalledTimes(1)
  })

  it("hides cancel affordances for non-cancellable (workflow/scheduler) rows", () => {
    monitorState = {
      rows: [
        row({
          rowId: "scheduled:ex1",
          source: "scheduled",
          kind: "backup",
          label: "Backup",
          legId: undefined,
          cancellable: false,
        }),
      ],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    expect(screen.queryByRole("button", { name: "Cancel all" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument()
    // A scheduler task type with no dedicated i18n label falls back to the raw kind.
    expect(screen.getByText("backup")).toBeInTheDocument()
  })

  it("hides rows whose kind is in the deny list", () => {
    prefsState = { ...prefsState, hiddenKinds: ["workflow"] }
    monitorState = {
      rows: [
        row({ rowId: "broker:leg1", kind: "connector", label: "WeCom reply" }),
        row({
          rowId: "workflow:run1",
          source: "workflow",
          kind: "workflow",
          label: "Nightly digest",
          legId: undefined,
          cancellable: false,
        }),
      ],
      runningCount: 2,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    expect(screen.getByText("WeCom reply")).toBeInTheDocument()
    expect(screen.queryByText("Nightly digest")).not.toBeInTheDocument()
  })

  it("shows the filtered-empty state and clears filters on demand", async () => {
    const user = userEvent.setup()
    prefsState = { ...prefsState, hiddenKinds: ["connector"] }
    isDefaultState = false
    monitorState = {
      rows: [row({ kind: "connector", label: "WeCom reply" })],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    expect(screen.getByText("No executions match your filters.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(resetMock).toHaveBeenCalledTimes(1)
  })

  it("groups rows under per-kind subheaders when groupByKind is on", () => {
    prefsState = { ...prefsState, groupByKind: true }
    monitorState = {
      rows: [
        row({ rowId: "broker:leg1", kind: "connector", label: "WeCom reply" }),
        row({
          rowId: "workflow:run1",
          source: "workflow",
          kind: "workflow",
          label: "Nightly digest",
          legId: undefined,
          cancellable: false,
        }),
      ],
      runningCount: 2,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    // Each kind becomes its own labelled group (region + inner list share the label).
    expect(screen.getByRole("region", { name: "Connector" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Workflow" })).toBeInTheDocument()
  })

  it("drives the view-settings popover controls", async () => {
    const user = userEvent.setup()
    isDefaultState = false
    monitorState = {
      rows: [row({ kind: "team", label: "Team turn", legId: undefined, cancellable: false })],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)

    await user.click(screen.getByRole("button", { name: "View settings" }))

    // Toggle a kind chip off (currently visible → hide it).
    await user.click(screen.getByRole("button", { name: /^Team/ }))
    expect(toggleKindMock).toHaveBeenCalledWith("team", false)

    // Change the sort (single-select ToggleGroup items are role="radio").
    await user.click(screen.getByRole("radio", { name: "By status" }))
    expect(setSortMock).toHaveBeenCalledWith("status")

    // Flip the two switches.
    await user.click(screen.getByRole("switch", { name: "Group by kind" }))
    expect(setGroupByKindMock).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole("switch", { name: "Show elapsed time" }))
    expect(setShowElapsedMock).toHaveBeenCalledWith(true)

    // Reset.
    await user.click(screen.getByRole("button", { name: /Reset to defaults/ }))
    expect(resetMock).toHaveBeenCalledTimes(1)
  })

  it("renders a live elapsed timer when enabled", () => {
    jest.useFakeTimers({ now: 120_000 })
    try {
      prefsState = { ...prefsState, showElapsed: true }
      monitorState = {
        rows: [
          row({ label: "WeCom reply", startedAt: 60_000, legId: undefined, cancellable: false }),
        ],
        runningCount: 1,
        isLoading: false,
      }
      render(<ExecutionMonitorPanel />)
      expect(screen.getByText("1m 0s")).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("queued reason", () => {
  it("says a leg is waiting for the folder, not merely queued", () => {
    // "Queued" alone reads as "hung", and only one of the two reasons is
    // something the user can act on.
    monitorState = {
      rows: [row({ status: "queued", slotKey: "dir:/repos/app", label: "Second turn" })],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    expect(screen.getByText("Waiting for the folder")).toBeInTheDocument()
  })

  it("keeps the plain label for a leg waiting on a permit", () => {
    monitorState = {
      rows: [row({ status: "queued", label: "Second turn" })],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    expect(screen.getByText("Queued")).toBeInTheDocument()
  })

  it("keeps the plain label for the leg that HOLDS the folder", () => {
    monitorState = {
      rows: [
        row({ status: "queued", slotKey: "dir:/repos/app", holdsSlot: true, label: "Holder" }),
      ],
      runningCount: 1,
      isLoading: false,
    }
    render(<ExecutionMonitorPanel />)
    expect(screen.getByText("Queued")).toBeInTheDocument()
  })
})
