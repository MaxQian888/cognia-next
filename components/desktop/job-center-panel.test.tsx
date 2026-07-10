/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"

const useClientLiveQuery = jest.fn()
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (...args: unknown[]) => useClientLiveQuery(...args),
}))

const collectRendererBackgroundResult = jest.fn()
const cancelRendererBackgroundRun = jest.fn()
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  collectRendererBackgroundResult: (runId: string) => collectRendererBackgroundResult(runId),
  cancelRendererBackgroundRun: (runId: string) => cancelRendererBackgroundRun(runId),
}))

const clearSettledBackgroundTasks = jest.fn()
jest.mock("@/lib/db/background-tasks", () => ({
  listBackgroundTaskRecords: jest.fn(),
  clearSettledBackgroundTasks: (...args: unknown[]) => clearSettledBackgroundTasks(...args),
}))

const redispatchBackgroundRun = jest.fn()
jest.mock("@/lib/background-tasks/redispatch", () => ({
  redispatchBackgroundRun: (...args: unknown[]) => redispatchBackgroundRun(...args),
}))
const cancelSubagentRun = jest.fn()
jest.mock("@/lib/claude/agents/cancel-subagent", () => ({
  cancelSubagentRun: (...args: unknown[]) => cancelSubagentRun(...args),
}))
const managerCancelAgent = jest.fn()
jest.mock("@/lib/ai/agent/background-agent-manager", () => ({
  getBackgroundAgentManager: () => ({ cancelAgent: (id: string) => managerCancelAgent(id) }),
}))
let liveSubAgent: Record<string, unknown> | undefined
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: (selector: (s: unknown) => unknown) =>
    selector({ subAgents: liveSubAgent ? { "run-live": liveSubAgent } : {} }),
}))

let runningCount = 0
jest.mock("@/components/execution/use-execution-monitor", () => ({
  useExecutionMonitor: () => ({ rows: [], runningCount, isLoading: false }),
}))
jest.mock("@/components/execution/execution-monitor-panel", () => ({
  ExecutionMonitorPanel: () => <div data-testid="execution-monitor-panel">monitor</div>,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { JobCenterPanel } from "./job-center-panel"

const row = (overrides: Partial<BackgroundTaskJournalRecord>): BackgroundTaskJournalRecord => ({
  runId: "run-1",
  kind: "subagent",
  subagentId: "reviewer",
  prompt: "Review this patch",
  sessionId: "session-1",
  host: "renderer",
  status: "running",
  startedAt: Date.now() - 30_000,
  ...overrides,
})

beforeEach(() => {
  useClientLiveQuery.mockReset()
  collectRendererBackgroundResult.mockReset()
  cancelRendererBackgroundRun.mockReset()
  clearSettledBackgroundTasks.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  useClientLiveQuery.mockReturnValue([
    row({ runId: "run-live", subagentId: "reviewer", status: "running" }),
    row({
      runId: "run-done",
      subagentId: "writer",
      status: "done",
      settledAt: Date.now() - 10_000,
      resultText: "Final summary text",
    }),
    row({
      runId: "run-interrupted",
      subagentId: "qa",
      status: "interrupted",
      settledAt: Date.now() - 5_000,
      error: "Process exited",
    }),
  ])
  collectRendererBackgroundResult.mockResolvedValue({
    text: "Collected result",
    channel: "text",
    toolsAvailable: false,
    runId: "run-done",
  })
  cancelRendererBackgroundRun.mockReturnValue(true)
  clearSettledBackgroundTasks.mockResolvedValue(undefined)
  redispatchBackgroundRun.mockReset()
  redispatchBackgroundRun.mockResolvedValue({ ok: true, runId: "new-run" })
  cancelSubagentRun.mockReset()
  managerCancelAgent.mockReset()
  managerCancelAgent.mockReturnValue(true)
  liveSubAgent = undefined
  runningCount = 0
})

afterEach(() => {
  cleanup()
})

it("opens from the trigger and separates active runs from history", async () => {
  const user = userEvent.setup()
  render(<JobCenterPanel />)

  await user.click(screen.getByTestId("status-job-center"))

  expect(screen.getByRole("heading", { name: "Job Center" })).toBeInTheDocument()
  expect(screen.getByText("reviewer")).toBeInTheDocument()
  expect(screen.getAllByText("Review this patch")).toHaveLength(2)

  await user.click(screen.getByRole("tab", { name: /History/ }))

  expect(screen.getByText("writer")).toBeInTheDocument()
  expect(screen.getByText("Final summary text")).toBeInTheDocument()
  expect(screen.getByText("qa")).toBeInTheDocument()
})

it("collects, cancels, and clears settled renderer tasks", async () => {
  const user = userEvent.setup()
  render(<JobCenterPanel />)

  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByTestId("job-cancel-run-live"))
  expect(cancelRendererBackgroundRun).toHaveBeenCalledWith("run-live")
  expect(toastSuccess).toHaveBeenCalled()

  await user.click(screen.getByRole("tab", { name: /History/ }))
  await user.click(screen.getByTestId("job-collect-run-done"))
  await waitFor(() => expect(collectRendererBackgroundResult).toHaveBeenCalledWith("run-done"))

  await user.click(screen.getByRole("button", { name: "Clear settled" }))
  expect(clearSettledBackgroundTasks).toHaveBeenCalledWith({ host: "renderer" })
})

it("shows empty states when no renderer tasks are journaled", async () => {
  const user = userEvent.setup()
  useClientLiveQuery.mockReturnValue([])

  render(<JobCenterPanel />)

  await user.click(screen.getByTestId("status-job-center"))

  expect(screen.getByText("No active background jobs")).toBeInTheDocument()

  await user.click(screen.getByRole("tab", { name: /History/ }))

  expect(screen.getByText("No background history")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Clear settled" })).toBeDisabled()
})

it("surfaces collect and cancel failure states", async () => {
  const user = userEvent.setup()
  useClientLiveQuery.mockReturnValue([
    row({ runId: "run-live", subagentId: "reviewer", status: "running" }),
    row({ runId: "run-missing", subagentId: "writer", status: "done", resultText: "done" }),
    row({ runId: "run-error", subagentId: "qa", status: "error", error: "stored error" }),
    row({ runId: "run-throw", subagentId: "ops", status: "done", resultText: "throws" }),
  ])
  cancelRendererBackgroundRun.mockReturnValueOnce(false)
  collectRendererBackgroundResult
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({
      text: "Collected failure",
      channel: "text",
      toolsAvailable: false,
      runId: "run-error",
      finishReason: "error",
    })
    .mockRejectedValueOnce(new Error("network down"))

  render(<JobCenterPanel />)

  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByTestId("job-cancel-run-live"))
  expect(toastError).toHaveBeenCalledWith("This background run is no longer cancellable.")

  await user.click(screen.getByRole("tab", { name: /History/ }))
  await user.click(screen.getByTestId("job-collect-run-missing"))
  await user.click(screen.getByTestId("job-collect-run-error"))
  await user.click(screen.getByTestId("job-collect-run-throw"))

  await waitFor(() => expect(collectRendererBackgroundResult).toHaveBeenCalledTimes(3))
  expect(toastError).toHaveBeenCalledWith("That background run is no longer available.")
  expect(toastError).toHaveBeenCalledWith("Collected failure")
  expect(toastError).toHaveBeenCalledWith("Could not collect background result: network down")
})

it("shows live executions under the Running tab and counts them in the badge", async () => {
  const user = userEvent.setup()
  runningCount = 2

  render(<JobCenterPanel />)

  // Badge = 3 journal records + 2 live runs.
  expect(screen.getByTestId("status-job-center")).toHaveTextContent("5")

  await user.click(screen.getByTestId("status-job-center"))

  // Running is the default tab when live activity exists → monitor is visible.
  expect(screen.getByTestId("execution-monitor-panel")).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: /Running/ })).toBeInTheDocument()
})

it("defaults to the Active tab and reaches Running on demand when nothing is live", async () => {
  const user = userEvent.setup()
  runningCount = 0

  render(<JobCenterPanel />)

  await user.click(screen.getByTestId("status-job-center"))

  // No live runs → Active is default, monitor not mounted until its tab is opened.
  expect(screen.queryByTestId("execution-monitor-panel")).not.toBeInTheDocument()

  await user.click(screen.getByRole("tab", { name: /Running/ }))
  expect(screen.getByTestId("execution-monitor-panel")).toBeInTheDocument()
})

it("reports clear-settled failures", async () => {
  const user = userEvent.setup()
  clearSettledBackgroundTasks.mockRejectedValueOnce(new Error("locked"))

  render(<JobCenterPanel />)

  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByRole("button", { name: "Clear settled" }))

  await waitFor(() =>
    expect(toastError).toHaveBeenCalledWith("Could not clear settled jobs: locked")
  )
})

it("routes cancellation by kind and mode", async () => {
  const user = userEvent.setup()
  useClientLiveQuery.mockReturnValue([
    row({ runId: "run-fg", mode: "foreground", status: "running" }),
    row({ runId: "run-plugin", kind: "plugin-agent", status: "running", pluginId: "p1" }),
  ])
  render(<JobCenterPanel />)
  await user.click(screen.getByTestId("status-job-center"))

  await user.click(screen.getByTestId("job-cancel-run-fg"))
  expect(cancelSubagentRun).toHaveBeenCalledWith("run-fg")
  expect(cancelRendererBackgroundRun).not.toHaveBeenCalled()

  await user.click(screen.getByTestId("job-cancel-run-plugin"))
  expect(managerCancelAgent).toHaveBeenCalledWith("run-plugin")
})

it("hides Collect for foreground rows and shows kind/mode badges", async () => {
  const user = userEvent.setup()
  useClientLiveQuery.mockReturnValue([
    row({
      runId: "run-fg-done",
      mode: "foreground",
      status: "done",
      settledAt: Date.now(),
      resultText: "ok",
    }),
  ])
  render(<JobCenterPanel />)
  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByRole("tab", { name: /History/ }))

  expect(screen.queryByTestId("job-collect-run-fg-done")).toBeNull()
  expect(screen.getByText("Foreground")).toBeInTheDocument()
  expect(screen.getByText("Subagent")).toBeInTheDocument()
})

it("re-runs an interrupted row and shows a pending-delivery chip", async () => {
  const user = userEvent.setup()
  useClientLiveQuery.mockReturnValue([
    row({
      runId: "run-int",
      status: "interrupted",
      settledAt: Date.now(),
      error: "crashed",
    }),
    row({
      runId: "run-pending",
      status: "done",
      settledAt: Date.now(),
      resultText: "done",
      deliveryState: "pending",
    }),
  ])
  render(<JobCenterPanel />)
  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByRole("tab", { name: /History/ }))

  expect(screen.getByTestId("job-pending-delivery-run-pending")).toBeInTheDocument()
  await user.click(screen.getByTestId("job-rerun-run-int"))
  await waitFor(() =>
    expect(redispatchBackgroundRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-int" }),
      { kind: "manual" }
    )
  )
  expect(toastSuccess).toHaveBeenCalled()
})

it("shows live token + tool telemetry for a running subagent row", async () => {
  const user = userEvent.setup()
  liveSubAgent = { tokenUsage: { totalTokens: 1234 }, toolUses: 7 }
  render(<JobCenterPanel />)
  await user.click(screen.getByTestId("status-job-center"))

  expect(screen.getByTestId("job-tokens-run-live").textContent).toMatch(/1234/)
  expect(screen.getByTestId("job-tools-run-live").textContent).toMatch(/7/)
})
