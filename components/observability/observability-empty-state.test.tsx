/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { ObservabilityEmptyState, ObservabilityLoadError } from "./observability-empty-state"

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

describe("ObservabilityEmptyState", () => {
  it("renders the title and hint", () => {
    render(<ObservabilityEmptyState />)
    expect(screen.getByTestId("observability-empty")).toBeInTheDocument()
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("hint")).toBeInTheDocument()
  })

  it("shows the widen button only when a handler is given, and fires it", () => {
    const onWidenRange = jest.fn()
    const { rerender } = render(<ObservabilityEmptyState />)
    expect(screen.queryByTestId("empty-widen")).not.toBeInTheDocument()

    rerender(<ObservabilityEmptyState onWidenRange={onWidenRange} />)
    fireEvent.click(screen.getByTestId("empty-widen"))
    expect(onWidenRange).toHaveBeenCalledTimes(1)
  })

  it("renders a load error as an alert with its message and a retry", () => {
    const onRetry = jest.fn()
    render(<ObservabilityLoadError error={new Error("quota")} onRetry={onRetry} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("title")
    expect(alert).toHaveTextContent("quota")
    fireEvent.click(screen.getByTestId("observability-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
