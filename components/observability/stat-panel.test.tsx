/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { StatPanel, resolveStat, statLevel } from "./stat-panel"
import { panelById } from "./panel-registry"
import type { WindowKpis } from "@/lib/observability/aggregate-series"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string) => key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

function kpis(over: Partial<WindowKpis> = {}): WindowKpis {
  return {
    totalCost: 0,
    totalSpans: 0,
    errorRate: 0,
    cacheHitRate: 0,
    p95LatencyMs: 0,
    reqPerMin: 0,
    toolCalls: 0,
    toolFailures: 0,
    ...over,
  }
}

describe("resolveStat", () => {
  it("formats each metric", () => {
    expect(resolveStat(panelById("kpi-cost")!, kpis({ totalCost: 3.5 })).display).toBe("$3.50")
    expect(resolveStat(panelById("kpi-spans")!, kpis({ totalSpans: 1500 })).display).toBe("1.5k")
    expect(resolveStat(panelById("kpi-errors")!, kpis({ errorRate: 0.123 })).display).toBe("12.3%")
    expect(resolveStat(panelById("kpi-rate")!, kpis({ reqPerMin: 12 })).display).toBeTruthy()
    expect(resolveStat(panelById("kpi-tools")!, kpis({ toolCalls: 2100 })).display).toBe("2.1k")
    expect(resolveStat(panelById("kpi-tool-failures")!, kpis({ toolFailures: 7 })).display).toBe(
      "7"
    )
    expect(resolveStat(panelById("kpi-latency")!, kpis({ p95LatencyMs: 1500 })).display).toBe(
      "1.50s"
    )
  })

  it("formats with a caller-supplied formatter set", () => {
    const fmt = {
      usd: () => "U",
      compact: () => "C",
      percent: () => "P",
      duration: () => "D",
      decimal: () => "N",
    }
    expect(resolveStat(panelById("kpi-cost")!, kpis(), fmt).display).toBe("U")
    expect(resolveStat(panelById("kpi-rate")!, kpis(), fmt).display).toBe("N")
    expect(resolveStat(panelById("kpi-latency")!, kpis(), fmt).display).toBe("D")
  })
})

describe("statLevel", () => {
  it("returns undefined without a threshold", () => {
    expect(statLevel(panelById("kpi-spans")!, 999)).toBeUndefined()
  })
  it("flags a critical error rate", () => {
    expect(statLevel(panelById("kpi-errors")!, 0.5)).toBe("crit")
  })
  it("treats a low cache hit rate as critical (below direction)", () => {
    expect(statLevel(panelById("kpi-cache")!, 0.1)).toBe("crit")
  })
})

describe("StatPanel", () => {
  it("renders the value and title", () => {
    render(<StatPanel panel={panelById("kpi-cost")!} kpis={kpis({ totalCost: 2 })} />)
    expect(screen.getByTestId("stat-value-kpi-cost")).toHaveTextContent("$2.00")
    expect(screen.getByText("panels.totalCost")).toBeInTheDocument()
  })

  it("shows a threshold dot when over the limit", () => {
    render(<StatPanel panel={panelById("kpi-errors")!} kpis={kpis({ errorRate: 0.5 })} />)
    expect(screen.getByTestId("panel-threshold-dot")).toHaveAttribute("data-level", "crit")
  })

  it("makes a failing-count stat a drill into errors-only", () => {
    const onDrill = jest.fn()
    render(
      <StatPanel
        panel={panelById("kpi-errors")!}
        kpis={kpis({ errorRate: 0.1 })}
        onDrill={onDrill}
      />
    )
    const button = screen.getByTestId("stat-drill-kpi-errors")
    expect(button).toHaveAccessibleName("drill.showFailing")
    fireEvent.click(button)
    expect(onDrill).toHaveBeenCalledTimes(1)
  })

  it("does not drill from a stat that is not a failure count", () => {
    render(<StatPanel panel={panelById("kpi-cost")!} kpis={kpis()} onDrill={jest.fn()} />)
    expect(screen.queryByTestId("stat-drill-kpi-cost")).not.toBeInTheDocument()
  })

  it("does not drill in edit mode, where a click starts a drag", () => {
    render(
      <StatPanel
        panel={panelById("kpi-tool-failures")!}
        kpis={kpis()}
        onDrill={jest.fn()}
        editMode
      />
    )
    expect(screen.queryByTestId("stat-drill-kpi-tool-failures")).not.toBeInTheDocument()
  })

  it("formats through the app-locale formatter set", () => {
    render(<StatPanel panel={panelById("kpi-errors")!} kpis={kpis({ errorRate: 0.123 })} />)
    expect(screen.getByTestId("stat-value-kpi-errors")).toHaveTextContent("12.3%")
  })
})
