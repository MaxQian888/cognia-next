/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PerfSample } from "@/lib/perf/backend/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

let mockStream: { history: PerfSample[]; latest: PerfSample | null; available: boolean }
jest.mock("@/hooks/perf/use-perf-stream", () => ({
  usePerfStream: () => mockStream,
}))

// Avoid recharts in jsdom — render a marker exposing the point count.
jest.mock("@/components/performance/perf-sparkline", () => ({
  PerfSparkline: ({ points, "data-testid": id }: { points: number[]; "data-testid"?: string }) => (
    <div data-testid={id ?? "sparkline"} data-points={points.length} />
  ),
}))
jest.mock("@/components/performance/perf-metric-tile", () => ({
  PerfMetricTile: ({
    label,
    value,
    onSelect,
    "data-testid": id,
  }: {
    label: string
    value: string
    onSelect: () => void
    "data-testid"?: string
  }) => (
    <button type="button" data-testid={id} onClick={onSelect}>
      {label}:{value}
    </button>
  ),
}))

// Inline the popover so content is always present.
jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { StatusBarPerf } from "./status-bar-perf"

function sample(cpuPct: number, memBytes: number): PerfSample {
  return {
    tsMs: 0,
    intervalMs: 1000,
    processes: [
      {
        pid: 1,
        parentPid: null,
        name: "main",
        role: "main",
        cpuPct,
        cpuPctRaw: cpuPct,
        memBytes,
        diskReadBps: 0,
        diskWriteBps: 0,
        runSecs: 1,
      },
    ],
    runtime: {
      workers: 1,
      aliveTasks: 0,
      globalQueueDepth: 0,
      blockingThreads: 0,
      blockingQueueDepth: 0,
      spawnedTasksCount: 0,
      budgetForcedYieldCount: 0,
      workerStealCount: 0,
      workerParkCount: 0,
      workerOverflowCount: 0,
      busyPct: 0,
      perWorkerBusyPct: [],
    },
    topSpans: [],
    systemMemory: null,
  }
}

beforeEach(() => {
  mockPush.mockClear()
  const s = sample(12.4, 340 * 1024 * 1024)
  mockStream = { history: [s], latest: s, available: true }
})

describe("StatusBarPerf", () => {
  it("returns null when the native runtime is unavailable", () => {
    mockStream = { history: [], latest: null, available: false }
    const { container } = render(<StatusBarPerf />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the rounded main-process CPU percent", () => {
    render(<StatusBarPerf />)
    expect(screen.getByTestId("status-perf")).toHaveTextContent("12%")
  })

  it("shows CPU and Memory tiles in the popover and links to /performance", () => {
    render(<StatusBarPerf />)
    expect(screen.getByTestId("status-perf-cpu")).toHaveTextContent("perfCpu:12%")
    // 340 MB, 0 fraction digits.
    expect(screen.getByTestId("status-perf-mem")).toHaveTextContent("perfMem:340 MB")
    fireEvent.click(screen.getByTestId("status-perf-cpu"))
    fireEvent.click(screen.getByTestId("status-perf-mem"))
    expect(mockPush).toHaveBeenCalledTimes(2)
    expect(mockPush).toHaveBeenCalledWith("/performance")
  })

  it("falls back to runtime busyPct / system memory when there is no main process", () => {
    const s = sample(0, 0)
    s.processes = []
    s.runtime.busyPct = 47
    s.systemMemory = { totalBytes: 100, usedBytes: 50 }
    mockStream = { history: [s], latest: s, available: true }
    render(<StatusBarPerf />)
    expect(screen.getByTestId("status-perf")).toHaveTextContent("47%")
    // memSeries/memBytes resolved from systemMemory.usedBytes.
    expect(screen.getByTestId("status-perf-mem")).toHaveTextContent("perfMem:50 B")
  })

  it("uses 0 memory when neither a main process nor system memory is present", () => {
    const s = sample(0, 0)
    s.processes = []
    s.runtime.busyPct = 5
    s.systemMemory = null
    mockStream = { history: [s], latest: s, available: true }
    render(<StatusBarPerf />)
    expect(screen.getByTestId("status-perf-mem")).toHaveTextContent("perfMem:0 B")
  })
})
