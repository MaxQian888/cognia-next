/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { ObservabilityEmptyState } from "./observability-empty-state"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

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
})
