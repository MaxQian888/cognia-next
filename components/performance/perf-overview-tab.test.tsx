/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
    <div data-testid="area-chart" data-points={JSON.stringify(data)}>
      {children}
    </div>
  ),
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

import { PerfOverviewTab, resolveOverviewMetric } from "./perf-overview-tab"
import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfSourceDescriptor,
  type PerfSourceKind,
} from "@/lib/perf/backend/types"

function source(kind: PerfSourceKind, capabilities: string[]): PerfSourceDescriptor {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: `${kind}:test`,
    kind,
    hostInstanceId: `${kind}-test`,
    runtimeKind: kind === "host" ? "tauri-rust" : "browser",
    build: { version: "1", commit: null, profile: "development" },
    metricSchemaVersion: 1,
    capabilities,
    clock: { kind: "host-monotonic", originWallMs: 0 },
    connection: { state: "live", changedAtMs: 0, detail: null },
  }
}

function frame(
  index: number,
  options: { cpu?: number; mem?: number; observations?: Record<string, number | null> } = {}
): PerfFrame {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: "s",
    targetId: "t",
    routingGeneration: 0,
    hostInstanceId: "h",
    samplingSessionId: "session",
    sequence: index + 1,
    requestedIntervalMs: 1000,
    actualIntervalMs: 1000,
    monotonicElapsedMs: 1000,
    wallStartMs: index * 1000,
    wallEndMs: (index + 1) * 1000,
    collectionDurationMs: 1,
    missedTicks: 0,
    flags: { reset: false, discontinuity: false, counterReset: false, sourceRestarted: false },
    tsMs: (index + 1) * 1000,
    intervalMs: 1000,
    processes:
      options.cpu === undefined
        ? []
        : [
            {
              pid: 1,
              parentPid: null,
              name: "cognia",
              role: "main",
              cpuPct: options.cpu,
              cpuPctRaw: options.cpu,
              memBytes: options.mem ?? 0,
              diskReadBps: 0,
              diskWriteBps: 0,
              runSecs: 60,
            },
          ],
    runtime: {
      workers: 2,
      aliveTasks: 5,
      globalQueueDepth: 0,
      blockingThreads: 0,
      blockingQueueDepth: 0,
      spawnedTasksCount: 0,
      budgetForcedYieldCount: 0,
      workerStealCount: 0,
      workerParkCount: 0,
      workerOverflowCount: 0,
      busyPct: 30,
      perWorkerBusyPct: [30, 30],
    },
    topSpans: [],
    systemMemory: null,
    managed: [],
    observations: options.observations,
  }
}

const HOST = source("host", ["host.processes", "runtime.tokio"])
const RENDERER = source("renderer", ["renderer.fps", "renderer.long-task", "renderer.user-timing"])

function renderTab(overrides: Partial<React.ComponentProps<typeof PerfOverviewTab>> = {}) {
  const props: React.ComponentProps<typeof PerfOverviewTab> = {
    rendererHistory: [frame(0, { observations: { "renderer.fps": 58 } })],
    hostHistory: [frame(0, { cpu: 10, mem: 1024 }), frame(1, { cpu: 42.5, mem: 2048 })],
    sources: [RENDERER, HOST],
    hostState: "live",
    selectedMetric: null,
    onSelectMetric: jest.fn(),
    intervalMs: 1000,
    onOpenDiagnose: jest.fn(),
    ...overrides,
  }
  render(<PerfOverviewTab {...props} />)
  return props
}

describe("PerfOverviewTab", () => {
  it("groups tiles by source and shows only advertised metrics", () => {
    renderTab()
    expect(screen.getByTestId("perf-rail-host")).toHaveTextContent("Selected host")
    expect(screen.getByTestId("perf-tile-host.main.cpu-pct")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tile-host.runtime.busy-pct")).toBeInTheDocument()
    // Disk I/O is Rust-only but the source is tauri-rust → present.
    expect(screen.getByTestId("perf-tile-host.disk.bytes-per-second")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tile-renderer.fps")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tile-renderer.long-task.count")).toBeInTheDocument()
    // No heap capability → no heap tile, rather than a zero line.
    expect(screen.queryByTestId("perf-tile-renderer.js-heap.used-bytes")).not.toBeInTheDocument()
  })

  it("charts the first available metric by default with its description and summary", () => {
    renderTab()
    expect(screen.getByTestId("perf-tile-host.main.cpu-pct")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    const graph = screen.getByTestId("perf-overview-graph")
    expect(graph).toHaveTextContent("App CPU")
    expect(screen.getByTestId("perf-graph-value")).toHaveTextContent("42.5%")
    expect(screen.getByTestId("perf-graph-description")).toHaveTextContent(/normalized/)
    expect(screen.getByTestId("perf-graph-subtitle")).toHaveTextContent("Peak 42.5%")
  })

  it("reports a tile click instead of switching on its own (URL-controlled)", () => {
    const props = renderTab()
    fireEvent.click(screen.getByTestId("perf-tile-renderer.fps"))
    expect(props.onSelectMetric).toHaveBeenCalledWith("renderer.fps")
  })

  it("charts the requested metric when it is available", () => {
    renderTab({ selectedMetric: "renderer.fps" })
    expect(screen.getByTestId("perf-tile-renderer.fps")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("perf-graph-value")).toHaveTextContent("58 fps")
  })

  it("keeps unmeasured intervals as gaps rather than zeros", () => {
    renderTab({
      selectedMetric: "renderer.fps",
      rendererHistory: [
        frame(0, { observations: { "renderer.fps": 60 } }),
        frame(1, { observations: { "renderer.fps": null } }),
      ],
    })
    const charts = screen.getAllByTestId("area-chart")
    const main = charts[charts.length - 1]
    const points = JSON.parse(main.getAttribute("data-points") ?? "[]") as Array<{
      value: number | null
    }>
    expect(points.map((point) => point.value)).toEqual([60, null])
  })

  it("explains an empty host rail on web and links to Diagnose", () => {
    const props = renderTab({ hostHistory: [], sources: [RENDERER], hostState: "unsupported" })
    expect(screen.getByTestId("perf-rail-host-empty")).toHaveTextContent(
      "No host is attached in this runtime"
    )
    fireEvent.click(screen.getByText("Source details"))
    expect(props.onOpenDiagnose).toHaveBeenCalled()
    // The renderer metric is charted instead.
    expect(screen.getByTestId("perf-tile-renderer.fps")).toHaveAttribute("aria-pressed", "true")
  })

  it("says so when no source reports any metric", () => {
    renderTab({
      hostHistory: [],
      rendererHistory: [],
      sources: [source("renderer", ["renderer.user-timing"])],
      hostState: "unsupported",
    })
    expect(screen.getByTestId("perf-overview-no-metrics")).toBeInTheDocument()
  })
})

describe("resolveOverviewMetric", () => {
  it("prefers the requested metric, else the first available, else null", () => {
    expect(resolveOverviewMetric(["renderer.fps", "host.main.cpu-pct"], "host.main.cpu-pct")).toBe(
      "host.main.cpu-pct"
    )
    expect(resolveOverviewMetric(["renderer.fps"], "host.main.cpu-pct")).toBe("renderer.fps")
    expect(resolveOverviewMetric([], "renderer.fps")).toBeNull()
  })
})
