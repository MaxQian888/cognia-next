/**
 * @jest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
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

const listBackgroundJobs = jest.fn()
const listBackgroundMonitors = jest.fn()
const readBackgroundJobTail = jest.fn()
const killBackgroundJob = jest.fn()
const cancelBackgroundMonitor = jest.fn()
jest.mock("@/lib/jobs/background-jobs", () => ({
  listBackgroundJobs: (...args: unknown[]) => listBackgroundJobs(...args),
  listBackgroundMonitors: (...args: unknown[]) => listBackgroundMonitors(...args),
  readBackgroundJobTail: (...args: unknown[]) => readBackgroundJobTail(...args),
  killBackgroundJob: (...args: unknown[]) => killBackgroundJob(...args),
  cancelBackgroundMonitor: (...args: unknown[]) => cancelBackgroundMonitor(...args),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
const pushMock = jest.fn()
const selectTask = jest.fn()
jest.mock("@/stores/scheduler/scheduler-store", () => ({
  useSchedulerStore: { getState: () => ({ selectTask }) },
}))

const resolveScheduledTaskNames = jest.fn(async () => new Map())
jest.mock("@/lib/scheduler/task-processes", () => ({
  resolveScheduledTaskNames: (...args: unknown[]) => resolveScheduledTaskNames(...(args as [])),
}))

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

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
  pushMock.mockReset()
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
  selectTask.mockReset()
  resolveScheduledTaskNames.mockReset().mockResolvedValue(new Map())
  listBackgroundJobs.mockReset()
  listBackgroundMonitors.mockReset()
  readBackgroundJobTail.mockReset()
  killBackgroundJob.mockReset()
  cancelBackgroundMonitor.mockReset()
  listBackgroundJobs.mockResolvedValue([])
  listBackgroundMonitors.mockResolvedValue([])
  readBackgroundJobTail.mockResolvedValue({ data: "build ready" })
  killBackgroundJob.mockResolvedValue({})
  cancelBackgroundMonitor.mockResolvedValue({})
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

it("shows supervised jobs and monitors with log and cancellation controls", async () => {
  const user = userEvent.setup()
  listBackgroundJobs.mockResolvedValue([
    {
      id: "job-1",
      command: "pnpm build",
      cwd: "/workspace",
      owner: { kind: "session", sessionId: "session-1" },
      status: "running",
      startedAtMs: Date.now() - 2_000,
      totalOutputBytes: 42,
      droppedOutputBytes: 0,
    },
  ])
  listBackgroundMonitors.mockResolvedValue([
    {
      id: "monitor-1",
      condition: { kind: "jobExit", jobId: "job-1" },
      owner: { kind: "app" },
      status: "waiting",
      createdAtMs: Date.now(),
    },
  ])

  render(<JobCenterPanel />)
  await waitFor(() => expect(listBackgroundJobs).toHaveBeenCalled())
  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByRole("tab", { name: /Processes/ }))

  expect(screen.getByText("pnpm build")).toBeInTheDocument()
  expect(screen.getByText("jobExit")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Log" }))
  await waitFor(() => expect(screen.getByText("build ready")).toBeInTheDocument())

  await user.click(screen.getByRole("button", { name: "Stop" }))
  expect(killBackgroundJob).toHaveBeenCalledWith("job-1")

  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(cancelBackgroundMonitor).toHaveBeenCalledWith("monitor-1")
})

// The Job Center is the only surface that can stop these processes, and its
// owner label was a bare task id. "scheduledTask xR9k2…" is not something a
// user can act on, and there was no way back to the schedule that started it.
it("names a scheduled task that owns a job, and links back to its schedule", async () => {
  const user = userEvent.setup()
  resolveScheduledTaskNames.mockResolvedValue(new Map([["task-7", "Nightly build"]]))
  listBackgroundJobs.mockResolvedValue([
    {
      id: "job-1",
      command: "pnpm build",
      cwd: "/workspace",
      owner: { kind: "scheduledTask", taskId: "task-7" },
      status: "running",
      startedAtMs: Date.now() - 2_000,
      totalOutputBytes: 0,
      droppedOutputBytes: 0,
    },
  ])

  render(<JobCenterPanel />)
  await waitFor(() => expect(listBackgroundJobs).toHaveBeenCalled())
  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByRole("tab", { name: /Processes/ }))

  const owner = await screen.findByTestId("job-owner-scheduled-task")
  expect(owner).toHaveTextContent("Nightly build")

  await user.click(owner)
  // Selection is store state on /scheduler rather than a URL param, so it has
  // to be set before the navigation, not after.
  await waitFor(() => expect(selectTask).toHaveBeenCalledWith("task-7"))
  expect(pushMock).toHaveBeenCalledWith("/scheduler")
})

it("falls back to the task id when the schedule is gone", async () => {
  const user = userEvent.setup()
  // An orphan process outliving its schedule is exactly when this list earns
  // its keep, so the row must not disappear with the name.
  resolveScheduledTaskNames.mockResolvedValue(new Map())
  listBackgroundJobs.mockResolvedValue([
    {
      id: "job-1",
      command: "pnpm build",
      cwd: "/workspace",
      owner: { kind: "scheduledTask", taskId: "task-gone" },
      status: "running",
      startedAtMs: Date.now(),
      totalOutputBytes: 0,
      droppedOutputBytes: 0,
    },
  ])

  render(<JobCenterPanel />)
  await waitFor(() => expect(listBackgroundJobs).toHaveBeenCalled())
  await user.click(screen.getByTestId("status-job-center"))
  await user.click(screen.getByRole("tab", { name: /Processes/ }))

  expect(await screen.findByTestId("job-owner-scheduled-task")).toHaveTextContent("task-gone")
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

/**
 * The job bridge already projects this row onto `kind: "job"` in the run
 * journal, so its timeline, changes, tests and approvals live in the cockpit.
 * This link is what keeps the sheet from growing a second, thinner copy.
 */
it("deep-links a task into the cockpit under its projected run id", async () => {
  const user = userEvent.setup()
  render(<JobCenterPanel />)
  await user.click(screen.getByTestId("status-job-center"))
  await user.click(await screen.findByTestId("job-open-run-run-live"))
  expect(pushMock).toHaveBeenCalledWith("/agent-runs?run=execution%3Ajob%3Arun-live")
})

/**
 * This panel is mounted in the status bar and the mobile shell for the whole
 * life of the app, and its sheet is shut for nearly all of it. The supervisor
 * refresh is two native IPC calls; at the open-panel cadence it used to fire
 * every two seconds, forever, for a number in a status bar.
 */
describe("polling is scoped to the sheet", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it("falls back to a slow heartbeat while the sheet is shut", async () => {
    render(<JobCenterPanel />)
    // The mount pass still runs: the trigger's badge counts supervisor rows.
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    const afterMount = listBackgroundJobs.mock.calls.length
    expect(afterMount).toBe(1)

    // Ten seconds of a closed panel — five passes at the old cadence.
    await act(async () => {
      jest.advanceTimersByTime(10_000)
    })
    expect(listBackgroundJobs.mock.calls.length).toBe(afterMount)

    await act(async () => {
      jest.advanceTimersByTime(25_000)
    })
    expect(listBackgroundJobs.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it("polls at the watching cadence once the sheet is open", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    render(<JobCenterPanel />)
    await act(async () => {
      jest.advanceTimersByTime(0)
    })

    await user.click(screen.getByTestId("status-job-center"))
    // Opening re-arms the effect, so a pass fires immediately.
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    const afterOpen = listBackgroundJobs.mock.calls.length

    await act(async () => {
      jest.advanceTimersByTime(4_000)
    })
    expect(listBackgroundJobs.mock.calls.length).toBeGreaterThanOrEqual(afterOpen + 2)
  })
})
