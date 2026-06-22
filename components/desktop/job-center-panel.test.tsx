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
