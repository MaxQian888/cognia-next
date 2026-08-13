/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="rc">{children}</div>
  ),
  AreaChart: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="sparkline-chart">{children}</div>
  ),
  Area: () => <div data-testid="sparkline-area" />,
}))

jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({ "chart-1": "#fff" }),
}))

const listTracesMock = jest.fn()
const openTraceDirMock = jest.fn()
jest.mock("@/lib/perf/backend/commands", () => ({
  perfListTraces: () => listTracesMock(),
  perfOpenTraceDir: () => openTraceDirMock(),
}))

import { PerfRuntimeTab } from "./perf-runtime-tab"
import type { PerfSample, RuntimeSample } from "@/lib/perf/backend/types"

function makeRuntime(overrides: Partial<RuntimeSample> = {}): RuntimeSample {
  return {
    workers: 4,
    aliveTasks: 12,
    globalQueueDepth: 1,
    blockingThreads: 2,
    blockingQueueDepth: 0,
    spawnedTasksCount: 1500,
    budgetForcedYieldCount: 3,
    workerStealCount: 220,
    workerParkCount: 4400,
    workerOverflowCount: 6,
    busyPct: 37.5,
    perWorkerBusyPct: [50, 25, 40, 35],
    ...overrides,
  }
}

beforeEach(() => {
  listTracesMock.mockReset()
  openTraceDirMock.mockReset()
  listTracesMock.mockResolvedValue([])
})

describe("PerfRuntimeTab", () => {
  it("shows an empty state when there is no runtime sample", async () => {
    render(<PerfRuntimeTab runtime={null} />)
    expect(screen.getByTestId("perf-runtime-empty")).toBeInTheDocument()
    await waitFor(() => expect(listTracesMock).toHaveBeenCalled())
  })

  it("renders grouped stat cards including the new throughput counters", async () => {
    render(<PerfRuntimeTab runtime={makeRuntime()} />)
    expect(screen.getByTestId("perf-rt-workers")).toHaveTextContent("4")
    expect(screen.getByTestId("perf-rt-alive")).toHaveTextContent("12")
    expect(screen.getByTestId("perf-rt-busy")).toHaveTextContent("37.5%")
    expect(screen.getByTestId("perf-rt-spawned")).toHaveTextContent("1.5k")
    // New Tokio throughput counters.
    expect(screen.getByTestId("perf-rt-steal")).toHaveTextContent("220")
    expect(screen.getByTestId("perf-rt-park")).toHaveTextContent("4.4k")
    expect(screen.getByTestId("perf-rt-overflow")).toHaveTextContent("6")
    expect(screen.getByTestId("perf-rt-yields")).toHaveTextContent("3")
    expect(screen.getAllByTestId(/perf-rt-worker-/)).toHaveLength(4)
    await waitFor(() => expect(listTracesMock).toHaveBeenCalled())
  })

  it("highlights the busy card when the runtime is saturated", async () => {
    render(<PerfRuntimeTab runtime={makeRuntime({ busyPct: 95 })} />)
    const busy = screen.getByTestId("perf-rt-busy")
    expect(busy).toHaveTextContent("95.0%")
    // Saturated → destructive chip color rather than the calm chart-4 color.
    expect(busy.querySelector(".text-destructive")).toBeTruthy()
    await waitFor(() => expect(listTracesMock).toHaveBeenCalled())
  })

  it("lists trace files and opens the folder", async () => {
    listTracesMock.mockResolvedValue([{ traceId: "opaque-a", sizeBytes: 2048, modifiedMs: 1 }])
    render(<PerfRuntimeTab runtime={makeRuntime()} />)
    await waitFor(() => expect(screen.getByTestId("perf-trace-opaque-a")).toBeInTheDocument())
    expect(screen.queryByText("trace.bin")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("perf-open-traces"))
    expect(openTraceDirMock).toHaveBeenCalled()
  })

  it("shows the empty-trace message when none exist", async () => {
    listTracesMock.mockResolvedValue([])
    render(<PerfRuntimeTab runtime={makeRuntime()} />)
    await waitFor(() => expect(screen.getByTestId("perf-traces-empty")).toBeInTheDocument())
  })

  it("renders a sparkline per worker row", async () => {
    const history: PerfSample[] = [1, 2].map((ts) => ({
      tsMs: ts,
      intervalMs: 1000,
      processes: [],
      runtime: makeRuntime({ perWorkerBusyPct: [10 + ts, 20 + ts, 30 + ts, 40 + ts] }),
      topSpans: [],
      systemMemory: null,
      managed: [],
    }))
    render(<PerfRuntimeTab runtime={makeRuntime()} history={history} />)
    expect(screen.getAllByTestId("sparkline-chart")).toHaveLength(4)
    await waitFor(() => expect(listTracesMock).toHaveBeenCalled())
  })
})
