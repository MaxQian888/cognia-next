import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ExecutionMonitorState } from "./use-execution-monitor"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"

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
  monitorState = { rows: [], runningCount: 0, isLoading: false }
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
    // Running count chip.
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
})
