/** @jest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react"

import { GuideStepper } from "./guide-stepper"

const items = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
]

const renderStepper = (props: Partial<Parameters<typeof GuideStepper>[0]> = {}) =>
  render(
    <GuideStepper
      items={items}
      current="b"
      ariaLabel="Progress"
      testId="stepper"
      itemTestIdPrefix="step"
      {...props}
    />
  )

describe("GuideStepper", () => {
  it("is a labelled navigation landmark holding an ordered list", () => {
    renderStepper()
    const nav = screen.getByRole("navigation", { name: "Progress" })
    expect(nav).toHaveAttribute("data-testid", "stepper")
    expect(within(nav).getAllByRole("listitem")).toHaveLength(3)
  })

  it("reports done / current / todo on each step and marks the current one for AT", () => {
    renderStepper()
    const [a, b, c] = screen.getAllByRole("listitem")
    expect(a).toHaveAttribute("data-status", "done")
    expect(b).toHaveAttribute("data-status", "current")
    expect(b).toHaveAttribute("aria-current", "step")
    expect(c).toHaveAttribute("data-status", "todo")
    expect(a).not.toHaveAttribute("aria-current")
  })

  it("draws a check instead of a number on completed steps", () => {
    renderStepper({ current: "c" })
    const [a, b, c] = screen.getAllByRole("listitem")
    expect(within(a).queryByText("1")).toBeNull()
    expect(within(b).queryByText("2")).toBeNull()
    expect(within(c).getByText("3")).toBeInTheDocument()
  })

  it("only lets completed steps be revisited", () => {
    // Moving forward has to run the current step's own submit.
    const onSelect = jest.fn()
    renderStepper({ onSelect })
    fireEvent.click(screen.getByTestId("step-a"))
    expect(onSelect).toHaveBeenCalledWith("a")
    onSelect.mockClear()
    fireEvent.click(screen.getByTestId("step-c"))
    fireEvent.click(screen.getByTestId("step-b"))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByTestId("step-c").tagName).not.toBe("BUTTON")
  })

  it("is read-only without a handler, and locked while busy", () => {
    const { unmount } = renderStepper()
    expect(screen.getByTestId("step-a").tagName).not.toBe("BUTTON")
    unmount()

    const onSelect = jest.fn()
    renderStepper({ onSelect, busy: true })
    fireEvent.click(screen.getByTestId("step-a"))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("keeps only the current label below `sm`, where the markers carry position", () => {
    renderStepper()
    expect(screen.getByText("Bravo")).not.toHaveClass("hidden")
    expect(screen.getByText("Alpha")).toHaveClass("hidden", "sm:inline")
    expect(screen.getByText("Charlie")).toHaveClass("hidden", "sm:inline")
  })

  it("draws a hairline between steps, lit only behind completed ones", () => {
    const { container } = renderStepper()
    const hairlines = container.querySelectorAll("li > span[aria-hidden]")
    expect(hairlines).toHaveLength(2)
    expect(hairlines[0]).toHaveClass("bg-brand-action/50")
    expect(hairlines[1]).toHaveClass("bg-border")
  })

  it("marks every step todo when the current id is not in the row", () => {
    renderStepper({ current: "welcome" })
    for (const li of screen.getAllByRole("listitem")) {
      expect(li).toHaveAttribute("data-status", "todo")
    }
  })

  it("renders nothing for an empty row", () => {
    const { container } = renderStepper({ items: [] })
    expect(container).toBeEmptyDOMElement()
  })
})
