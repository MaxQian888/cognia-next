/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { VariableFilterBar, toggleFilterValue } from "./variable-filter-bar"
import { makeSpan } from "@/lib/observability/fixtures"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("toggleFilterValue", () => {
  it("adds a value to an empty dimension", () => {
    expect(toggleFilterValue({}, "model", "opus")).toEqual({ model: ["opus"] })
  })
  it("removes a value, dropping the empty dimension", () => {
    expect(toggleFilterValue({ model: ["opus"] }, "model", "opus")).toEqual({})
  })
  it("appends without disturbing other dimensions", () => {
    const out = toggleFilterValue({ surface: ["chat"], model: ["opus"] }, "model", "sonnet")
    expect(out).toEqual({ surface: ["chat"], model: ["opus", "sonnet"] })
  })
})

describe("VariableFilterBar", () => {
  const spans = [
    makeSpan({ responseModel: "opus", surface: "chat" }),
    makeSpan({ responseModel: "sonnet", surface: "workflow" }),
  ]

  it("renders a dropdown per dimension", () => {
    render(<VariableFilterBar windowSpans={spans} filters={{}} onChange={jest.fn()} />)
    expect(screen.getByTestId("filter-model")).toBeInTheDocument()
    expect(screen.getByTestId("filter-surface")).toBeInTheDocument()
    expect(screen.getByTestId("filter-tool")).toBeInTheDocument()
  })

  it("shows a count badge for active selections", () => {
    render(
      <VariableFilterBar windowSpans={spans} filters={{ model: ["opus"] }} onChange={jest.fn()} />
    )
    expect(screen.getByTestId("filter-model")).toHaveTextContent("1")
  })

  it("toggles an option from the popover", () => {
    const onChange = jest.fn()
    render(<VariableFilterBar windowSpans={spans} filters={{}} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("filter-model"))
    fireEvent.click(screen.getByTestId("filter-model-option-opus"))
    expect(onChange).toHaveBeenCalledWith({ model: ["opus"] })
  })

  it("filters options by the search query", () => {
    render(<VariableFilterBar windowSpans={spans} filters={{}} onChange={jest.fn()} />)
    fireEvent.click(screen.getByTestId("filter-model"))
    fireEvent.change(screen.getByTestId("filter-search-model"), { target: { value: "son" } })
    expect(screen.queryByTestId("filter-model-option-opus")).not.toBeInTheDocument()
    expect(screen.getByTestId("filter-model-option-sonnet")).toBeInTheDocument()
  })

  it("clears all filters", () => {
    const onChange = jest.fn()
    render(
      <VariableFilterBar windowSpans={spans} filters={{ model: ["opus"] }} onChange={onChange} />
    )
    fireEvent.click(screen.getByTestId("filter-clear"))
    expect(onChange).toHaveBeenCalledWith({})
  })
})
