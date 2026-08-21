/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { IssueRailRow } from "./issue-rail-row"

function renderRow(over: Partial<React.ComponentProps<typeof IssueRailRow>> = {}) {
  const props: React.ComponentProps<typeof IssueRailRow> = {
    active: false,
    onSelect: jest.fn(),
    label: "All",
    testId: "row",
    ...over,
  }
  return { props, ...render(<IssueRailRow {...props} />) }
}

describe("IssueRailRow", () => {
  it("renders its label", () => {
    renderRow()
    expect(screen.getByText("All")).toBeInTheDocument()
  })

  it("fires on click", () => {
    const onSelect = jest.fn()
    renderRow({ onSelect })
    fireEvent.click(screen.getByTestId("row"))
    expect(onSelect).toHaveBeenCalled()
  })

  it("expresses active as a toggle, not as navigation — every row is a filter", () => {
    renderRow({ active: true })
    expect(screen.getByTestId("row")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("row")).not.toHaveAttribute("aria-current")
  })

  it("shows a count when given one", () => {
    renderRow({ count: 7 })
    expect(screen.getByText("7")).toBeInTheDocument()
  })

  it("shows a zero count rather than hiding it", () => {
    renderRow({ count: 0 })
    expect(screen.getByText("0")).toBeInTheDocument()
  })

  it("omits the count entirely when it is unknown", () => {
    const { container } = renderRow()
    expect(container.querySelector(".tabular-nums")).toBeNull()
  })

  it("renders an icon and a detail slot", () => {
    renderRow({ icon: <span data-testid="icon" />, detail: <span data-testid="detail" /> })
    expect(screen.getByTestId("icon")).toBeInTheDocument()
    expect(screen.getByTestId("detail")).toBeInTheDocument()
  })

  it("keeps the trailing control outside the button, so it is separately clickable", () => {
    renderRow({ trailing: <a data-testid="trailing" href="/x" /> })
    const trailing = screen.getByTestId("trailing")
    expect(screen.getByTestId("row").contains(trailing)).toBe(false)
  })
})
