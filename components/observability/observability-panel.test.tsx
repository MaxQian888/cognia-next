/**
 * @jest-environment jsdom
 */
import { fireEvent, render, renderHook, screen } from "@testing-library/react"
import { ObservabilityPanel } from "./observability-panel"
import { panelById, type PanelDef } from "./panel-registry"
import { useObservabilitySeries } from "@/hooks/observability/use-observability-series"
import { customRange } from "@/lib/observability/time-range"
import { DEFAULT_THRESHOLDS } from "@/lib/observability/thresholds"
import { makeSpan } from "@/lib/observability/fixtures"

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

function makeSeries() {
  const range = customRange(0, 3000)
  const spans = [
    makeSpan({
      traceId: "t1",
      startTime: 100,
      durationMs: 100,
      costUsdEstimate: 0.1,
      responseModel: "opus",
      surface: "chat",
    }),
  ]
  return renderHook(() => useObservabilitySeries(spans, range)).result.current
}

describe("ObservabilityPanel dispatch", () => {
  const series = makeSeries()
  const onFilterValue = jest.fn()

  const baseProps = {
    series,
    editMode: false,
    thresholds: DEFAULT_THRESHOLDS,
    filters: {},
    onFilterValue,
  }

  it.each([
    ["kpi-cost", "stat-panel-kpi-cost"],
    ["ts-cost", "ts-panel-ts-cost"],
    ["bd-model", "donut-panel-bd-model"],
    ["bd-surface", "bar-panel-bd-surface"],
    ["bd-provider", "donut-panel-bd-provider"],
    ["bd-project", "bar-panel-bd-project"],
    ["bd-operation", "donut-panel-bd-operation"],
    ["bd-tool", "bar-panel-bd-tool"],
  ])("renders the right panel for %s", (panelId, testId) => {
    render(<ObservabilityPanel panel={panelById(panelId)!} {...baseProps} />)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it.each([
    ["operation", "donut", "donut-panel-x"],
    ["tool", "bar", "bar-panel-x"],
    ["provider", "donut", "donut-panel-x"],
    ["project", "bar", "bar-panel-x"],
    [undefined, "donut", "donut-panel-x"],
  ] as const)("resolves the %s breakdown dimension", (dimension, kind, testId) => {
    const panel = { id: "x", kind, titleKey: "byModel", dimension } as PanelDef
    render(<ObservabilityPanel panel={panel} {...baseProps} />)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  // `bd-provider` / `bd-project` shipped wired to a `breakdownFor` switch that
  // had no case for either dimension, so both plotted the MODEL rollup.
  it("plots the provider rollup on the provider panel, not the model one", () => {
    render(<ObservabilityPanel panel={panelById("bd-provider")!} {...baseProps} />)
    expect(screen.getByTestId("donut-legend-bd-provider-anthropic")).toBeInTheDocument()
    expect(screen.queryByTestId("donut-legend-bd-provider-opus")).not.toBeInTheDocument()
  })

  it("routes a breakdown click to onFilterValue with the panel dimension", () => {
    onFilterValue.mockClear()
    render(<ObservabilityPanel panel={panelById("bd-model")!} {...baseProps} />)
    fireEvent.click(screen.getByTestId("donut-legend-bd-model-opus"))
    expect(onFilterValue).toHaveBeenCalledWith("model", "opus")
  })

  it("turns each panel kind's drill gesture into a DashboardDrill", () => {
    const onDrill = jest.fn()
    const { unmount } = render(
      <ObservabilityPanel
        panel={panelById("kpi-tool-failures")!}
        {...baseProps}
        onDrill={onDrill}
      />
    )
    fireEvent.click(screen.getByTestId("stat-drill-kpi-tool-failures"))
    expect(onDrill).toHaveBeenLastCalledWith({ kind: "errors" })
    unmount()

    render(<ObservabilityPanel panel={panelById("bd-model")!} {...baseProps} onDrill={onDrill} />)
    fireEvent.click(screen.getByTestId("donut-legend-bd-model-show-opus"))
    expect(onDrill).toHaveBeenLastCalledWith({ kind: "filter", dimension: "model", value: "opus" })
  })

  it("offers no drill without a handler", () => {
    render(<ObservabilityPanel panel={panelById("bd-model")!} {...baseProps} />)
    expect(screen.queryByTestId("donut-legend-bd-model-show-opus")).not.toBeInTheDocument()
  })
})
