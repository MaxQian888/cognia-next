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

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

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
  const onSelect = jest.fn()
  const onFilterValue = jest.fn()

  const baseProps = {
    series,
    editMode: false,
    onSelectTrace: onSelect,
    thresholds: DEFAULT_THRESHOLDS,
    filters: {},
    onFilterValue,
  }

  it.each([
    ["kpi-cost", "stat-panel-kpi-cost"],
    ["ts-cost", "ts-panel-ts-cost"],
    ["bd-model", "donut-panel-bd-model"],
    ["bd-surface", "bar-panel-bd-surface"],
    ["traces", "recent-traces-panel"],
  ])("renders the right panel for %s", (panelId, testId) => {
    render(<ObservabilityPanel panel={panelById(panelId)!} {...baseProps} />)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it.each([
    ["operation", "donut", "donut-panel-x"],
    ["tool", "bar", "bar-panel-x"],
    [undefined, "donut", "donut-panel-x"],
  ] as const)("resolves the %s breakdown dimension", (dimension, kind, testId) => {
    const panel = { id: "x", kind, titleKey: "byModel", dimension } as PanelDef
    render(<ObservabilityPanel panel={panel} {...baseProps} />)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it("routes a breakdown click to onFilterValue with the panel dimension", () => {
    onFilterValue.mockClear()
    render(<ObservabilityPanel panel={panelById("bd-model")!} {...baseProps} />)
    fireEvent.click(screen.getByTestId("donut-legend-bd-model-opus"))
    expect(onFilterValue).toHaveBeenCalledWith("model", "opus")
  })
})
