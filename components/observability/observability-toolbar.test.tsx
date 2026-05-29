/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { ObservabilityToolbar, type ObservabilityToolbarProps } from "./observability-toolbar"

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
    onPreset: jest.fn(),
    onCustom: jest.fn(),
    onRefreshMs: jest.fn(),
    onFilters: jest.fn(),
    onToggleEdit: jest.fn(),
    onResetLayout: jest.fn(),
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
