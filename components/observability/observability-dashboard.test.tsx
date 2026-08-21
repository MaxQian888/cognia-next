/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { ObservabilityDashboard } from "./observability-dashboard"
import { panelById } from "./panel-registry"
import { buildSeries, makeRange } from "@/lib/storybook/fixtures/observability"
import { makeSpan } from "@/lib/observability/fixtures"
import { DEFAULT_THRESHOLDS } from "@/lib/observability/thresholds"
import { defaultLayouts } from "./panel-registry"
import type { PanelLayouts } from "@/stores/observability/observability-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub PanelGrid: render one real panel through the dispatch so the wiring is
// covered, plus a button that fires onLayoutChange so the debounce is too.
jest.mock("./panel-grid", () => ({
  PanelGrid: ({
    renderPanel,
    onLayoutChange,
    hiddenPanels,
  }: {
    renderPanel: (p: unknown) => React.ReactNode
    onLayoutChange: (layouts: unknown) => void
    hiddenPanels?: string[]
  }) => {
    const { panelById: byId } = jest.requireActual("./panel-registry")
    return (
      <div data-testid="panel-grid" data-hidden={(hiddenPanels ?? []).join(",")}>
        <button
          data-testid="fire-layout"
          onClick={() =>
            onLayoutChange({ lg: [{ i: "kpi-cost", x: 5, y: 0, w: 2, h: 2 }], md: [], sm: [] })
          }
        >
          layout
        </button>
        {renderPanel(byId("kpi-cost"))}
      </div>
    )
  },
}))

const range = makeRange(1_700_000_000_000)
const series = buildSeries(
  [makeSpan({ traceId: "t1", surface: "chat", responseModel: "opus", costUsdEstimate: 1.5 })],
  range
)

function renderDashboard(overrides: Partial<Parameters<typeof ObservabilityDashboard>[0]> = {}) {
  const onLayoutChange = jest.fn()
  const onFilterValue = jest.fn()
  const utils = render(
    <ObservabilityDashboard
      series={series}
      layouts={defaultLayouts()}
      editMode={false}
      hiddenPanels={[]}
      thresholds={DEFAULT_THRESHOLDS}
      filters={{}}
      onLayoutChange={onLayoutChange}
      onFilterValue={onFilterValue}
      empty={false}
      {...overrides}
    />
  )
  return { ...utils, onLayoutChange, onFilterValue }
}

describe("ObservabilityDashboard", () => {
  it("renders the grid and dispatches a panel through the registry", () => {
    renderDashboard()
    expect(screen.getByTestId("observability-dashboard")).toBeInTheDocument()
    expect(screen.getByTestId("panel-grid")).toBeInTheDocument()
    expect(screen.getByTestId("stat-panel-kpi-cost")).toBeInTheDocument()
  })

  it("forwards hidden panels to the grid", () => {
    renderDashboard({ hiddenPanels: ["ts-cost", "bd-tool"] })
    expect(screen.getByTestId("panel-grid")).toHaveAttribute("data-hidden", "ts-cost,bd-tool")
  })

  it("shows the empty state instead of the grid when the window has no spans", () => {
    const onWidenRange = jest.fn()
    renderDashboard({ empty: true, onWidenRange })
    expect(screen.getByTestId("observability-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("panel-grid")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("empty-widen"))
    expect(onWidenRange).toHaveBeenCalled()
  })

  it("debounces layout changes into a single write", () => {
    jest.useFakeTimers()
    try {
      const { onLayoutChange } = renderDashboard()
      fireEvent.click(screen.getByTestId("fire-layout"))
      // Fire again to exercise the clearTimeout branch.
      fireEvent.click(screen.getByTestId("fire-layout"))
      expect(onLayoutChange).not.toHaveBeenCalled()
      act(() => jest.advanceTimersByTime(300))
      expect(onLayoutChange).toHaveBeenCalledTimes(1)
      const written = onLayoutChange.mock.calls[0][0] as PanelLayouts
      expect(written.lg[0]).toMatchObject({ i: "kpi-cost", x: 5 })
    } finally {
      jest.useRealTimers()
    }
  })

  it("no longer ships a recent-traces panel — the Explore sub-view is the list", () => {
    expect(panelById("traces")).toBeUndefined()
  })
})
