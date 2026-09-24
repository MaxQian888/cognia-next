/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"
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

  // The trailing arrow used to reveal only on hover/focus of the row, so a
  // touch screen could never reach it.
  it("keeps the trailing control reachable without a hover", () => {
    const onOpen = jest.fn()
    renderRow({
      count: 7,
      trailing: (
        <button type="button" data-testid="trailing" onClick={onOpen}>
          open
        </button>
      ),
    })
    const trailing = screen.getByTestId("trailing")
    const wrapper = trailing.parentElement as HTMLElement
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.groupBase) {
      expect(wrapper).toHaveClass(variant)
    }
    expect(wrapper).toHaveClass(
      "group-hover/rail-row:opacity-100",
      "group-focus-within/rail-row:opacity-100"
    )
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(wrapper).not.toHaveClass(forbidden)
    }
    trailing.focus()
    expect(trailing).toHaveFocus()
    fireEvent.click(trailing)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("hides the count wherever the trailing control is shown, so they never overlap", () => {
    renderRow({ count: 7, trailing: <a data-testid="trailing" href="/x" /> })
    expect(screen.getByText("7")).toHaveClass(
      "group-hover/rail-row:invisible",
      "group-focus-within/rail-row:invisible",
      "group-has-[[data-state=open]]/rail-row:invisible",
      "pointer-coarse:invisible"
    )
  })

  it("leaves the count alone when there is no trailing control", () => {
    renderRow({ count: 7 })
    const count = screen.getByText("7")
    expect(count).not.toHaveClass("group-hover/rail-row:invisible")
    expect(count).not.toHaveClass("pointer-coarse:invisible")
  })
})
