/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { BreakdownMetricToggle } from "./breakdown-metric-toggle"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string) => key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

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
