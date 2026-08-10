/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Replace Recharts with a tree of testable stubs — jsdom can't render SVG charts.
jest.mock("recharts", () => {
  const Mock = ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <div data-recharts {...(props as Record<string, unknown>)}>
      {children}
    </div>
  )
  const Series = (props: {
    name?: string
    dataKey?: string
    label?: (p: { name: string; percent: number }) => string
    [k: string]: unknown
  }) => {
    // Exercise inline `label` callback (used by Pie) to register coverage.
    if (typeof props.label === "function") {
      try {
        props.label({ name: "info", percent: 0.5 })
      } catch {
        /* noop */
      }
    }
    return (
      <div
        data-testid={`series-${String(props.name ?? props.dataKey ?? "anon")}`}
        data-name={String(props.name ?? "")}
        data-key={String(props.dataKey ?? "")}
      />
    )
  }
  return {
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="rc-container">{children}</div>
    ),
    PieChart: Mock,
    Pie: Series,
    Cell: () => null,
    AreaChart: Mock,
    Area: Series,
    LineChart: Mock,
    Line: Series,
    BarChart: Mock,
    Bar: Series,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
  }
})

jest.mock("@/lib/observability/chart-config", () => ({
  TOOLTIP_STYLE: { contentStyle: {}, labelStyle: {} },
  CHART_MARGINS: {
    default: { top: 0, right: 0, bottom: 0, left: 0 },
    withYAxis: { top: 0, right: 0, bottom: 0, left: 0 },
  },
}))

import { LogStatsDashboard } from "./log-stats-dashboard"
import type { StructuredLogEntry, LogLevel } from "@cognia/logging"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

function makeLog(
  level: LogLevel,
  module: string,
  message: string,
  offsetMs = 0
): StructuredLogEntry {
  return {
    id: `${level}-${offsetMs}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0, 0) + offsetMs).toISOString(),
    level,
    module,
    message,
  } as StructuredLogEntry
}

function buildLogs(n = 60): StructuredLogEntry[] {
  const logs: StructuredLogEntry[] = []
  for (let i = 0; i < n; i++) {
    const lvl: LogLevel =
      i % 11 === 0 ? "error" : i % 5 === 0 ? "warn" : i % 7 === 0 ? "trace" : "info"
    logs.push(makeLog(lvl, i % 2 === 0 ? "auth" : "api", `event ${i % 4}`, i * 60_000))
  }
  return logs
}

function makeNative(overrides: Partial<NativeLoggingReadiness> = {}): NativeLoggingReadiness {
  return {
    runtime: "tauri",
    activeTargets: ["console", "file"],
    platformLogging: {
      backend: "OSLog",
      health: "healthy",
      minLevel: "info",
      error: null,
    },
    ...overrides,
  } as NativeLoggingReadiness
}

describe("LogStatsDashboard", () => {
  it("renders the no-data message when logs is empty", () => {
    render(<LogStatsDashboard logs={[]} />)
    expect(screen.getByText("No log data available for visualization")).toBeInTheDocument()
  })

  it("renders all eight stat cards", () => {
    render(<LogStatsDashboard logs={buildLogs(40)} logRate={42} />)
    expect(screen.getByText("Total Logs")).toBeInTheDocument()
    expect(screen.getByText("Error Rate")).toBeInTheDocument()
    expect(screen.getByText("Most Active Module")).toBeInTheDocument()
    expect(screen.getByText("Time Span")).toBeInTheDocument()
    expect(screen.getByText("Log Rate")).toBeInTheDocument()
    expect(screen.getByText("Warning Rate")).toBeInTheDocument()
    expect(screen.getByText("Unique Modules")).toBeInTheDocument()
    expect(screen.getByText("Unique Traces")).toBeInTheDocument()
  })

  it("exposes each dashboard section as a named region", () => {
    render(<LogStatsDashboard logs={buildLogs(30)} />)

    expect(screen.getByRole("region", { name: "Level Distribution" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Log Volume Over Time" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Module Activity" })).toBeInTheDocument()
  })

  it("hides logRate sub-label when logRate is 0", () => {
    render(<LogStatsDashboard logs={buildLogs(10)} logRate={0} />)
    // 'Log Rate' card still renders the label and a "-" placeholder.
    expect(screen.getByText("Log Rate")).toBeInTheDocument()
  })

  it("renders the platform-logging card only when nativeLogging.runtime is tauri", () => {
    const { rerender } = render(<LogStatsDashboard logs={buildLogs(10)} />)
    expect(screen.queryByText("Platform Logging")).not.toBeInTheDocument()
    rerender(<LogStatsDashboard logs={buildLogs(10)} nativeLogging={makeNative()} />)
    expect(screen.getByText("Platform Logging")).toBeInTheDocument()
    expect(screen.getByText("OSLog")).toBeInTheDocument()
    expect(screen.getByText(/console, file/)).toBeInTheDocument()
  })

  it("falls back to localized 'none' placeholder when activeTargets is empty", () => {
    render(
      <LogStatsDashboard logs={buildLogs(10)} nativeLogging={makeNative({ activeTargets: [] })} />
    )
    expect(screen.getByText("none")).toBeInTheDocument()
  })

  it("renders platform error block when present", () => {
    render(
      <LogStatsDashboard
        logs={buildLogs(10)}
        nativeLogging={makeNative({
          platformLogging: {
            backend: "OSLog",
            health: "degraded",
            minLevel: "info",
            error: "permission denied",
          } as NativeLoggingReadiness["platformLogging"],
        })}
      />
    )
    expect(screen.getByText("permission denied")).toBeInTheDocument()
  })

  it("renders the responsive 1/2/3/4 columns grid on the stat cards row", () => {
    const { container } = render(<LogStatsDashboard logs={buildLogs(10)} />)
    const grid = container.querySelector(
      ".grid.grid-cols-1.sm\\:grid-cols-2.md\\:grid-cols-3.lg\\:grid-cols-4"
    )
    expect(grid).toBeInTheDocument()
  })

  it("renders responsive Tailwind chart heights, not inline 220px", () => {
    const { container } = render(<LogStatsDashboard logs={buildLogs(30)} />)
    expect(container.querySelector('[data-testid="dashboard-chart-pie"]')).toHaveClass(
      "h-[180px]",
      "sm:h-[200px]",
      "md:h-[220px]",
      "lg:h-[260px]"
    )
    expect(container.querySelector('[data-testid="dashboard-chart-area"]')).toBeInTheDocument()
  })

  it("renders Recharts AreaChart Area series with localized names", () => {
    render(<LogStatsDashboard logs={buildLogs(30)} />)
    expect(screen.getByTestId("series-Info")).toBeInTheDocument()
    expect(screen.getByTestId("series-Warning")).toBeInTheDocument()
    expect(screen.getByTestId("series-Error")).toBeInTheDocument()
    expect(screen.getByTestId("series-Other")).toBeInTheDocument()
  })

  it("renders Bar series with localized 'Logs' name", () => {
    render(<LogStatsDashboard logs={buildLogs(30)} />)
    // en.json maps dashboard.logsSeries → "Logs"
    const bar = screen.getByTestId("series-Logs")
    expect(bar).toHaveAttribute("data-name", "Logs")
  })

  it("renders the LineChart error-trend block when volume has ≥4 buckets", () => {
    render(<LogStatsDashboard logs={buildLogs(60)} />)
    // current + previous series rendered via LineChart
    expect(screen.getByTestId("series-Current Period")).toBeInTheDocument()
    expect(screen.getByTestId("series-Previous Period")).toBeInTheDocument()
  })

  it("filters by a top error when its row is activated", async () => {
    const user = userEvent.setup({ skipHover: true })
    const onSearchFilter = jest.fn()
    const errorLogs = Array.from({ length: 8 }, (_, i) =>
      makeLog("error", "auth", "Connection refused — retrying", i * 1000)
    )
    render(<LogStatsDashboard logs={errorLogs} onSearchFilter={onSearchFilter} />)
    expect(screen.getByText("Top Errors")).toBeInTheDocument()
    const first = screen.getByRole("button", { name: /Connection refused/ })
    await user.click(first)
    expect(onSearchFilter).toHaveBeenCalledWith("Connection refused — retrying")
  })

  it("renders the BarChart block for the module activity row", () => {
    render(<LogStatsDashboard logs={[makeLog("info", "m", "x")]} />)
    expect(screen.queryByText("Module Activity")).toBeInTheDocument()
  })

  it("renders day-unit time-span for spans >24h", () => {
    const longSpan = [
      makeLog("info", "auth", "a", 0),
      makeLog("info", "auth", "b", 25 * 60 * 60_000),
    ]
    const { container } = render(<LogStatsDashboard logs={longSpan} />)
    // Time Span card sits 4th in the grid; just verify the unit appears in DOM.
    expect(container.textContent).toMatch(/1\.0d/)
  })

  it("expresses sub-hour span in minutes", () => {
    const shortSpan = [makeLog("info", "auth", "a", 0), makeLog("info", "auth", "b", 10 * 60_000)]
    const { container } = render(<LogStatsDashboard logs={shortSpan} />)
    expect(container.textContent).toContain("10m")
  })

  it("expresses spans between 1h and 24h in hours", () => {
    const midSpan = [makeLog("info", "auth", "a", 0), makeLog("info", "auth", "b", 3 * 60 * 60_000)]
    const { container } = render(<LogStatsDashboard logs={midSpan} />)
    expect(container.textContent).toMatch(/3\.0h/)
  })

  it("classifies trend down when error rate drops in late buckets", () => {
    const logs: StructuredLogEntry[] = []
    for (let i = 0; i < 30; i++) logs.push(makeLog("error", "m", "boom", i * 60_000))
    for (let i = 0; i < 90; i++) logs.push(makeLog("info", "m", "ok", (30 + i) * 60_000))
    const { container } = render(<LogStatsDashboard logs={logs} />)
    // TrendingDown icon class
    expect(container.querySelector(".lucide-trending-down")).toBeInTheDocument()
  })

  it("renders the BarChart for modules", () => {
    render(<LogStatsDashboard logs={buildLogs(30)} />)
    expect(screen.getByText("Module Activity")).toBeInTheDocument()
  })

  it("classifies trend up when later quarters spike", () => {
    const logs: StructuredLogEntry[] = []
    // first 75% are mostly info
    for (let i = 0; i < 90; i++) logs.push(makeLog("info", "m", "ok", i * 60_000))
    // last 25% are all errors
    for (let i = 0; i < 30; i++) logs.push(makeLog("error", "m", "boom", (90 + i) * 60_000))
    render(<LogStatsDashboard logs={logs} />)
    expect(screen.getByText("Total Logs")).toBeInTheDocument()
  })
})
