/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { VariableFilterBar, activeFilterCount, toggleFilterValue } from "./variable-filter-bar"
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

describe("activeFilterCount", () => {
  it("counts values, not dimensions", () => {
    expect(activeFilterCount({})).toBe(0)
    expect(activeFilterCount({ model: ["a", "b"], provider: ["anthropic"] })).toBe(3)
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

  describe("collapsed", () => {
    it("folds every dimension behind one trigger carrying the active count", async () => {
      const user = userEvent.setup()
      render(
        <VariableFilterBar
          windowSpans={spans}
          filters={{ model: ["opus"], surface: ["chat"] }}
          onChange={jest.fn()}
          collapsed
        />
      )
      const trigger = screen.getByTestId("filter-collapsed-trigger")
      expect(trigger).toHaveTextContent("2")
      // The seven dropdowns are NOT in the toolbar row — that is the point.
      expect(screen.queryByTestId("filter-model")).not.toBeInTheDocument()

      await user.click(trigger)
      expect(screen.getByTestId("filter-dimension-index")).toBeInTheDocument()
      expect(screen.getByTestId("filter-model")).toBeInTheDocument()
      expect(screen.getByTestId("filter-session")).toBeInTheDocument()
    })

    it("drills into one dimension and back without nesting a second popover", async () => {
      const user = userEvent.setup()
      const onChange = jest.fn()
      render(<VariableFilterBar windowSpans={spans} filters={{}} onChange={onChange} collapsed />)
      await user.click(screen.getByTestId("filter-collapsed-trigger"))
      await user.click(screen.getByTestId("filter-model"))

      // The index is replaced, not stacked on top of.
      expect(screen.queryByTestId("filter-dimension-index")).not.toBeInTheDocument()
      expect(screen.getByTestId("filter-search-model")).toBeInTheDocument()

      await user.click(screen.getByTestId("filter-model-option-opus"))
      expect(onChange).toHaveBeenCalledWith({ model: ["opus"] })

      await user.click(screen.getByTestId("filter-drill-back"))
      expect(screen.getByTestId("filter-dimension-index")).toBeInTheDocument()
    })

    it("clears everything from inside the popover", async () => {
      const user = userEvent.setup()
      const onChange = jest.fn()
      render(
        <VariableFilterBar
          windowSpans={spans}
          filters={{ model: ["opus"] }}
          onChange={onChange}
          collapsed
        />
      )
      await user.click(screen.getByTestId("filter-collapsed-trigger"))
      await user.click(screen.getByTestId("filter-clear"))
      expect(onChange).toHaveBeenCalledWith({})
    })
  })
})
