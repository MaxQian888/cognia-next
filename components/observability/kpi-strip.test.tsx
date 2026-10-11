/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { KpiStrip } from "./kpi-strip"
import { KPI_PANELS } from "./panel-registry"
import type { WindowKpis } from "@/lib/observability/aggregate-series"

jest.mock("next-intl", () => {
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

const KPIS: WindowKpis = {
  totalCost: 2.5,
  totalSpans: 164,
  errorRate: 0.061,
  cacheHitRate: 0.45,
  p95LatencyMs: 30_560,
  reqPerMin: 2.73,
  toolCalls: 57,
  toolFailures: 2,
}

describe("KpiStrip", () => {
  it("renders every KPI as a labelled cell of one list", () => {
    render(<KpiStrip kpis={KPIS} />)
    const strip = screen.getByTestId("kpi-strip")
    expect(strip).toHaveAccessibleName("kpiStrip.label")
    expect(strip.querySelector("dl")).toHaveAttribute("data-count", String(KPI_PANELS.length))
    for (const panel of KPI_PANELS) {
      expect(screen.getByTestId(`stat-panel-${panel.id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId("stat-value-kpi-cost")).toHaveTextContent("$2.50")
    expect(screen.getByTestId("stat-value-kpi-spans")).toHaveTextContent("164")
  })

  it("reflows by its own width, not the viewport's", () => {
    render(<KpiStrip kpis={KPIS} />)
    const strip = screen.getByTestId("kpi-strip")
    expect(strip.className).toContain("@container/kpi")
    const list = strip.querySelector("dl")!
    expect(list.className).toContain("grid-cols-2")
    expect(list.className).toContain("@lg/kpi:grid-cols-4")
    expect(list.className).toContain("@5xl/kpi:grid-cols-8")
  })

  it("draws rules between cells instead of a frame around each one", () => {
    render(<KpiStrip kpis={KPIS} />)
    const cell = screen.getByTestId("stat-panel-kpi-cost")
    expect(cell.className).toContain("border-t")
    expect(cell.className).toContain("border-l")
    expect(cell.querySelector("section")).toBeNull()
  })

  it("drops hidden stats and renders nothing when all are hidden", () => {
    const { rerender } = render(<KpiStrip kpis={KPIS} hiddenPanels={["kpi-cost", "kpi-rate"]} />)
    expect(screen.queryByTestId("stat-panel-kpi-cost")).not.toBeInTheDocument()
    expect(screen.queryByTestId("stat-panel-kpi-rate")).not.toBeInTheDocument()
    expect(screen.getByTestId("stat-panel-kpi-spans")).toBeInTheDocument()

    rerender(<KpiStrip kpis={KPIS} hiddenPanels={KPI_PANELS.map((p) => p.id)} />)
    expect(screen.queryByTestId("kpi-strip")).not.toBeInTheDocument()
  })

  it("offers the errors drill only on failure-count stats", () => {
    const onDrillErrors = jest.fn()
    render(<KpiStrip kpis={KPIS} onDrillErrors={onDrillErrors} />)
    expect(screen.queryByTestId("stat-drill-kpi-cost")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("stat-drill-kpi-errors"))
    fireEvent.click(screen.getByTestId("stat-drill-kpi-tool-failures"))
    expect(onDrillErrors).toHaveBeenCalledTimes(2)
  })
})
