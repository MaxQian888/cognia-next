/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

import { PresetListToolbar } from "./preset-list-toolbar"

describe("PresetListToolbar", () => {
  it("renders the search input with the caller's value", () => {
    render(<PresetListToolbar searchValue="hello" onSearchChange={() => undefined} />)
    expect(screen.getByLabelText("Search presets")).toHaveValue("hello")
  })

  it("invokes onSearchChange when the user types", () => {
    const onSearchChange = jest.fn()
    render(<PresetListToolbar searchValue="" onSearchChange={onSearchChange} />)
    fireEvent.change(screen.getByLabelText("Search presets"), { target: { value: "rev" } })
    expect(onSearchChange).toHaveBeenCalledWith("rev")
  })

  it("uses the custom placeholder when provided", () => {
    render(
      <PresetListToolbar
        searchValue=""
        onSearchChange={() => undefined}
        searchPlaceholder="custom placeholder"
      />
    )
    expect(screen.getByPlaceholderText("custom placeholder")).toBeInTheDocument()
  })

  it("falls back to the default English placeholder when none is provided", () => {
    render(<PresetListToolbar searchValue="" onSearchChange={() => undefined} />)
    expect(screen.getByPlaceholderText("Search presets…")).toBeInTheDocument()
  })

  it("renders the right-actions slot when supplied", () => {
    render(
      <PresetListToolbar
        searchValue=""
        onSearchChange={() => undefined}
        rightActions={<button type="button">action</button>}
      />
    )
    expect(screen.getByTestId("preset-list-toolbar-right")).toBeInTheDocument()
    expect(screen.getByText("action")).toBeInTheDocument()
  })

  it("renders the filter chips slot when supplied", () => {
    render(
      <PresetListToolbar
        searchValue=""
        onSearchChange={() => undefined}
        filterChips={<span>chip</span>}
      />
    )
    expect(screen.getByTestId("preset-list-toolbar-filters")).toBeInTheDocument()
    expect(screen.getByText("chip")).toBeInTheDocument()
  })

  it("hides the bulk bar when selectionCount is 0", () => {
    render(<PresetListToolbar searchValue="" onSearchChange={() => undefined} selectionCount={0} />)
    expect(screen.queryByTestId("preset-list-toolbar-bulk")).not.toBeInTheDocument()
  })

  it("shows the bulk bar with selection count and bulk actions when selectionCount > 0", () => {
    render(
      <PresetListToolbar
        searchValue=""
        onSearchChange={() => undefined}
        selectionCount={3}
        bulkActions={<button type="button">bulk</button>}
      />
    )
    expect(screen.getByTestId("preset-list-toolbar-bulk")).toBeInTheDocument()
    expect(screen.getByText("selected:3")).toBeInTheDocument()
    expect(screen.getByText("bulk")).toBeInTheDocument()
  })

  it("invokes onClearSelection when the close button is clicked", () => {
    const onClearSelection = jest.fn()
    render(
      <PresetListToolbar
        searchValue=""
        onSearchChange={() => undefined}
        selectionCount={2}
        onClearSelection={onClearSelection}
      />
    )
    fireEvent.click(screen.getByLabelText("Clear selection"))
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it("omits the bulk divider when bulkActions is missing but bulk bar is visible", () => {
    render(<PresetListToolbar searchValue="" onSearchChange={() => undefined} selectionCount={1} />)
    expect(screen.getByTestId("preset-list-toolbar-bulk")).toBeInTheDocument()
    expect(screen.getByText("selected:1")).toBeInTheDocument()
    expect(screen.getByLabelText("Clear selection")).toBeInTheDocument()
  })

  it("forwards the testId prop", () => {
    render(
      <PresetListToolbar searchValue="" onSearchChange={() => undefined} testId="custom-toolbar" />
    )
    expect(screen.getByTestId("custom-toolbar")).toBeInTheDocument()
  })
})
