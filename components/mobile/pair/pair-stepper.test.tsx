/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"

import { PairStepper } from "./pair-stepper"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      discover: "Discover",
      pair: "Pair",
      paired: "Done",
      ariaLabel: "Pairing progress",
    }
    return map[key] ?? key
  },
}))

describe("<PairStepper />", () => {
  it("renders all three steps in order", () => {
    render(<PairStepper current="discover" />)
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent("Discover")
    expect(items[1]).toHaveTextContent("Pair")
    expect(items[2]).toHaveTextContent("Done")
  })

  it("flags the active step with aria-current", () => {
    render(<PairStepper current="pair" />)
    const items = screen.getAllByRole("listitem")
    expect(items[0]).toHaveAttribute("data-status", "done")
    expect(items[1]).toHaveAttribute("data-status", "current")
    expect(items[1]).toHaveAttribute("aria-current", "step")
    expect(items[2]).toHaveAttribute("data-status", "todo")
  })

  it("marks completed steps with the check icon (no number)", () => {
    render(<PairStepper current="paired" />)
    const items = screen.getAllByRole("listitem")
    // Step 1 + Step 2 are done — their badge should be a check, not a digit.
    expect(within(items[0]).queryByText("1")).not.toBeInTheDocument()
    expect(within(items[1]).queryByText("2")).not.toBeInTheDocument()
    // The current step (paired) still shows its number.
    expect(within(items[2]).getByText("3")).toBeInTheDocument()
  })

  it("exposes a stable testid for layout assertions", () => {
    render(<PairStepper current="discover" />)
    expect(screen.getByTestId("pair-stepper")).toBeInTheDocument()
  })
})
