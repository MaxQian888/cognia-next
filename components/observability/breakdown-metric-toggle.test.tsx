/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { BreakdownMetricToggle } from "./breakdown-metric-toggle"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("BreakdownMetricToggle", () => {
  it("renders the three measures and marks the active one", () => {
    render(<BreakdownMetricToggle value="cost" onChange={jest.fn()} panelId="bd-model" />)
    expect(screen.getByTestId("metric-toggle-bd-model-cost")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.getByTestId("metric-toggle-bd-model-spans")).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("emits the picked measure", () => {
    const onChange = jest.fn()
    render(<BreakdownMetricToggle value="spans" onChange={onChange} panelId="bd-model" />)
    fireEvent.click(screen.getByTestId("metric-toggle-bd-model-errors"))
    expect(onChange).toHaveBeenCalledWith("errors")
  })
})
