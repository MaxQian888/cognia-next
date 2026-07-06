import { executeRadarReportTask } from "./radar-report-executor"
import { runRadarReport, NoRadarModelError } from "@/lib/radar/radar-runner"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

jest.mock("@/lib/radar/radar-runner", () => {
  class NoRadarModelError extends Error {}
  return { runRadarReport: jest.fn(), NoRadarModelError }
})
jest.mock("@/lib/logging", () => ({
  loggers: { scheduler: { info: jest.fn(), error: jest.fn() } },
}))

const mockRun = runRadarReport as jest.Mock
const task = { id: "t1" } as ScheduledTask
const execution = { id: "e1" } as TaskExecution
const signal = new AbortController().signal

beforeEach(() => jest.clearAllMocks())

describe("executeRadarReportTask", () => {
  it("returns report metadata on success", async () => {
    mockRun.mockResolvedValue({ id: "r1", itemCount: 7 })
    const r = await executeRadarReportTask(task, execution, signal)
    expect(r.success).toBe(true)
    expect(r.output).toEqual({ itemCount: 7, reportId: "r1" })
  })

  it("reports skipped when the runner returns null", async () => {
    mockRun.mockResolvedValue(null)
    const r = await executeRadarReportTask(task, execution, signal)
    expect(r.success).toBe(true)
    expect(r.output).toEqual({ skipped: true })
  })

  it("maps NoRadarModelError to a friendly message", async () => {
    mockRun.mockRejectedValue(new NoRadarModelError())
    const r = await executeRadarReportTask(task, execution, signal)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key/i)
  })
})
