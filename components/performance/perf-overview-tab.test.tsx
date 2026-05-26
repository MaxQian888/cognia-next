/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}))
jest.mock("@/lib/observability/chart-config", () => ({ TOOLTIP_STYLE: { contentStyle: {} } }))
jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({
    "chart-1": "#1",
    "chart-2": "#2",
    "chart-3": "#3",
    "chart-4": "#4",
    "chart-5": "#5",
    destructive: "#ef4444",
  }),
}))

import { PerfOverviewTab } from "./perf-overview-tab"
import type { PerfSample } from "@/lib/perf/backend/types"

function sample(cpu: number, mem: number, busy: number, tasks: number, disk = 0): PerfSample {
  return {
    tsMs: 1,
    intervalMs: 1000,
    processes: [
      {
        pid: 1,
        parentPid: null,
        name: "cognia",
        role: "main",
        cpuPct: cpu,
        cpuPctRaw: cpu,
        memBytes: mem,
        diskReadBps: disk,
        diskWriteBps: disk,
        runSecs: 60,
      },
    ],
    runtime: {
      workers: 2,
      aliveTasks: tasks,
      globalQueueDepth: 0,
      blockingThreads: 0,
      blockingQueueDepth: 0,
      spawnedTasksCount: 0,
      budgetForcedYieldCount: 0,
      workerStealCount: 0,
      workerParkCount: 0,
      workerOverflowCount: 0,
      busyPct: busy,
      perWorkerBusyPct: [busy, busy],
    },
    topSpans: [],
    systemMemory: null,
  }
}

describe("PerfOverviewTab", () => {
  it("renders five metric tiles with CPU selected by default", () => {
    render(<PerfOverviewTab history={[sample(50, 1024 * 1024, 25, 7)]} />)
    expect(screen.getByTestId("perf-tile-cpu")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tile-memory")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tile-runtimeBusy")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tile-tasks")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tile-diskIo")).toBeInTheDocument()
    // CPU tile active by default.
    expect(screen.getByTestId("perf-tile-cpu")).toHaveAttribute("aria-pressed", "true")
    // Big graph shows the CPU value.
    expect(screen.getByTestId("perf-graph-value")).toHaveTextContent("50.0%")
  })

  it("switches the big graph when another tile is selected", () => {
    render(<PerfOverviewTab history={[sample(50, 2 * 1024 * 1024, 25, 7)]} />)
    fireEvent.click(screen.getByTestId("perf-tile-memory"))
    expect(screen.getByTestId("perf-tile-memory")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("perf-graph-value")).toHaveTextContent("2.0 MB")
  })

  it("shows combined disk throughput when the Disk I/O tile is selected", () => {
    // 512 KB/s read + 512 KB/s write across the tree → 1.0 MB/s.
    render(<PerfOverviewTab history={[sample(50, 1024 * 1024, 25, 7, 512 * 1024)]} />)
    fireEvent.click(screen.getByTestId("perf-tile-diskIo"))
    expect(screen.getByTestId("perf-tile-diskIo")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("perf-graph-value")).toHaveTextContent("1.0 MB/s")
  })

  it("handles an empty history without crashing", () => {
    render(<PerfOverviewTab history={[]} />)
    expect(screen.getByTestId("perf-overview-graph")).toBeInTheDocument()
    expect(screen.getByTestId("perf-graph-value")).toHaveTextContent("0%")
  })
})
