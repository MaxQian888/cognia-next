/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

import { GoalsMobileSectionSwitcher } from "./goals-mobile-section-switcher"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

describe("<GoalsMobileSectionSwitcher />", () => {
  it("renders the three sections as tabs", () => {
    render(<GoalsMobileSectionSwitcher active="overview" onSelect={jest.fn()} />)
    expect(screen.getByTestId("mobile-goals-switcher")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goals-section-overview")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goals-section-history")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goals-section-analytics")).toBeInTheDocument()
  })

  it("marks the active section and reports selection", () => {
    const onSelect = jest.fn()
    render(<GoalsMobileSectionSwitcher active="overview" onSelect={onSelect} />)
    expect(screen.getByTestId("mobile-goals-section-overview")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByTestId("mobile-goals-section-history")).toHaveAttribute(
      "aria-selected",
      "false"
    )
    fireEvent.click(screen.getByTestId("mobile-goals-section-analytics"))
    expect(onSelect).toHaveBeenCalledWith("analytics")
  })
})
