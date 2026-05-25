/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { PerformanceTierFields } from "./performance-tier-popover"

function renderFields(props: Partial<React.ComponentProps<typeof PerformanceTierFields>> = {}) {
  const onChange = jest.fn()
  const utils = render(
    <PerformanceTierFields
      value={props.value ?? "auto"}
      effective={props.effective ?? "balanced"}
      onChange={props.onChange ?? onChange}
    />
  )
  return { ...utils, onChange: props.onChange ?? onChange }
}

describe("PerformanceTierFields", () => {
  it("lists all four tier options", () => {
    renderFields()
    expect(screen.getAllByText("Auto").length).toBeGreaterThan(0)
    expect(screen.getByText("High")).toBeInTheDocument()
    expect(screen.getByText("Balanced")).toBeInTheDocument()
    expect(screen.getByText("Reduced")).toBeInTheDocument()
  })

  it("renders the 'effective: …' footer when value is auto", () => {
    renderFields({ value: "auto", effective: "balanced" })
    const footer = screen.getByTestId("perf-tier-effective-footer")
    expect(footer.textContent).toContain("Balanced")
  })

  it("hides the 'effective: …' footer when value is an explicit tier", () => {
    renderFields({ value: "high", effective: "high" })
    expect(screen.queryByTestId("perf-tier-effective-footer")).toBeNull()
  })

  it("emits onChange when a different radio is selected", () => {
    const onChange = jest.fn()
    renderFields({ value: "auto", effective: "high", onChange })
    fireEvent.click(screen.getByLabelText("Reduced"))
    expect(onChange).toHaveBeenCalledWith("reduced")
  })
})
