/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { ObservabilityToolbar, type ObservabilityToolbarProps } from "./observability-toolbar"
import { DASHBOARD_CONFIG_VERSION } from "@/lib/observability/dashboard-config"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function setup(over: Partial<ObservabilityToolbarProps> = {}) {
  const props: ObservabilityToolbarProps = {
    preset: "1h",
    customSince: null,
    customUntil: null,
    refreshMs: 10_000,
    filters: {},
    editMode: false,
    windowSpans: [],
    lastUpdated: null,
    traces: [],
    onPreset: jest.fn(),
    onCustom: jest.fn(),
    onRefreshMs: jest.fn(),
    onRefresh: jest.fn(),
    onFilters: jest.fn(),
    onToggleEdit: jest.fn(),
    onResetLayout: jest.fn(),
    onOpenSettings: jest.fn(),
    buildConfig: () => ({
      version: DASHBOARD_CONFIG_VERSION,
      layouts: null,
      hiddenPanels: [],
      thresholds: {},
      rangePreset: "1h",
      customSince: null,
      customUntil: null,
      refreshMs: 10_000,
      filters: {},
    }),
    onImportConfig: jest.fn(),
    ...over,
  }
  render(<ObservabilityToolbar {...props} />)
  return props
}

describe("ObservabilityToolbar", () => {
  it("renders the controls", () => {
    setup()
    expect(screen.getByTestId("variable-filter-bar")).toBeInTheDocument()
    expect(screen.getByTestId("time-range-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("toggle-edit")).toBeInTheDocument()
    expect(screen.getByTestId("manual-refresh")).toBeInTheDocument()
    expect(screen.getByTestId("export-menu")).toBeInTheDocument()
    expect(screen.getByTestId("open-settings")).toBeInTheDocument()
  })

  it("opens settings and fires a manual refresh", () => {
    const props = setup()
    fireEvent.click(screen.getByTestId("open-settings"))
    expect(props.onOpenSettings).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("manual-refresh"))
    expect(props.onRefresh).toHaveBeenCalled()
  })

  it("hides reset-layout unless editing", () => {
    setup({ editMode: false })
    expect(screen.queryByTestId("reset-layout")).not.toBeInTheDocument()
  })

  it("shows reset-layout while editing and fires it", () => {
    const props = setup({ editMode: true })
    fireEvent.click(screen.getByTestId("reset-layout"))
    expect(props.onResetLayout).toHaveBeenCalled()
  })

  it("toggles edit mode", () => {
    const props = setup()
    fireEvent.click(screen.getByTestId("toggle-edit"))
    expect(props.onToggleEdit).toHaveBeenCalled()
  })
})
