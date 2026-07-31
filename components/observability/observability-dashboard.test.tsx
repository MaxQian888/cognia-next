/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { ObservabilityDashboard } from "./observability-dashboard"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import { makeSpan } from "@/lib/observability/fixtures"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mutable so a test can flip the dashboard into its empty state.
const mockData = {
  spans: [makeSpan({ traceId: "t1", surface: "chat", responseModel: "opus" })],
  windowSpans: [makeSpan({ traceId: "t1", surface: "chat", responseModel: "opus" })],
  loading: false,
}
let currentData: { spans: unknown[]; windowSpans: unknown[]; loading: boolean } = mockData

// Avoid Dexie + recharts + RGL in this wrapper test.
jest.mock("@/hooks/observability/use-observability-data", () => ({
  useObservabilityData: () => currentData,
}))
jest.mock("@/hooks/observability/use-refresh-tick", () => ({
  useRefreshTick: () => ({ tick: 0, lastUpdated: null, refresh: jest.fn() }),
}))
// The settings sheet independently touches Dexie via useClientLiveQuery — stub it.
jest.mock("./observability-settings-sheet", () => ({
  ObservabilitySettingsSheet: ({ open }: { open: boolean }) => (
    <div data-testid="settings-sheet">{open ? "open" : "closed"}</div>
  ),
}))

// Stub PanelGrid: render only the recent-traces panel so we can drive the
// drawer, plus a button that fires onLayoutChange so the debounce is covered.
jest.mock("./panel-grid", () => ({
  PanelGrid: ({
    renderPanel,
    onLayoutChange,
  }: {
    renderPanel: (p: unknown) => React.ReactNode
    onLayoutChange: (layouts: unknown) => void
  }) => {
    const { panelById: byId } = jest.requireActual("./panel-registry")
    return (
      <div data-testid="panel-grid">
        <button
          data-testid="fire-layout"
          onClick={() =>
            onLayoutChange({ lg: [{ i: "kpi-cost", x: 5, y: 0, w: 2, h: 2 }], md: [], sm: [] })
          }
        >
          layout
        </button>
        {renderPanel(byId("traces"))}
      </div>
    )
  },
}))

jest.mock("./recent-traces-panel", () => ({
  RecentTracesPanel: ({ onSelectTrace }: { onSelectTrace: (id: string) => void }) => (
    <button data-testid="fake-trace" onClick={() => onSelectTrace("trace-xyz")}>
      open
    </button>
  ),
}))

jest.mock("./trace-waterfall-drawer", () => ({
  TraceWaterfallDrawer: ({ traceId, onClose }: { traceId: string | null; onClose: () => void }) => (
    <div data-testid="drawer">
      {traceId ?? "closed"}
      <button data-testid="drawer-close" onClick={onClose}>
        x
      </button>
    </div>
  ),
}))

beforeEach(() => {
  currentData = mockData
  useObservabilityStore.setState({
    layouts: null,
    rangePreset: "1h",
    customSince: null,
    customUntil: null,
    refreshMs: 0,
    filters: {},
    editMode: false,
    thresholds: {},
    hiddenPanels: [],
  })
})

describe("ObservabilityDashboard", () => {
  it("renders the header, toolbar and grid", () => {
    render(<ObservabilityDashboard />)
    expect(screen.getByTestId("observability-dashboard")).toBeInTheDocument()
    expect(screen.getByTestId("observability-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("panel-grid")).toBeInTheDocument()
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("shows the empty state when the window has no spans", () => {
    currentData = { spans: [], windowSpans: [], loading: false }
    render(<ObservabilityDashboard />)
    expect(screen.getByTestId("observability-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("panel-grid")).not.toBeInTheDocument()
  })

  it("opens the waterfall drawer when a trace is selected", () => {
    render(<ObservabilityDashboard />)
    expect(screen.getByTestId("drawer")).toHaveTextContent("closed")
    fireEvent.click(screen.getByTestId("fake-trace"))
    expect(screen.getByTestId("drawer")).toHaveTextContent("trace-xyz")
    fireEvent.click(screen.getByTestId("drawer-close"))
    expect(screen.getByTestId("drawer")).toHaveTextContent("closed")
  })

  it("toggles edit mode through the store", () => {
    render(<ObservabilityDashboard />)
    fireEvent.click(screen.getByTestId("toggle-edit"))
    expect(useObservabilityStore.getState().editMode).toBe(true)
  })

  it("opens settings when the gear is clicked", () => {
    render(<ObservabilityDashboard />)
    expect(screen.getByTestId("settings-sheet")).toHaveTextContent("closed")
    fireEvent.click(screen.getByTestId("open-settings"))
    expect(screen.getByTestId("settings-sheet")).toHaveTextContent("open")
  })

  it("persists layout changes after the debounce window", () => {
    jest.useFakeTimers()
    try {
      render(<ObservabilityDashboard />)
      fireEvent.click(screen.getByTestId("fire-layout"))
      // Fire again to exercise the clearTimeout branch.
      fireEvent.click(screen.getByTestId("fire-layout"))
      expect(useObservabilityStore.getState().layouts).toBeNull()
      act(() => jest.advanceTimersByTime(300))
      expect(useObservabilityStore.getState().layouts?.lg[0]).toMatchObject({ i: "kpi-cost", x: 5 })
    } finally {
      jest.useRealTimers()
    }
  })
})
