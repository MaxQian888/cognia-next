/**
 * @jest-environment jsdom
 */
import { useState } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  GoalsMobileSectionPanel,
  GoalsMobileSectionSwitcher,
  type GoalMobileSection,
} from "./goals-mobile-section-switcher"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

function Harness({ onSelect }: { onSelect?: (section: GoalMobileSection) => void }) {
  const [section, setSection] = useState<GoalMobileSection>("overview")
  return (
    <GoalsMobileSectionSwitcher
      active={section}
      onSelect={(next) => {
        onSelect?.(next)
        setSection(next)
      }}
    >
      <GoalsMobileSectionPanel section={section} data-testid="panel">
        {section}
      </GoalsMobileSectionPanel>
    </GoalsMobileSectionSwitcher>
  )
}

describe("<GoalsMobileSectionSwitcher />", () => {
  it("renders the three sections as tabs in a labelled tab list", () => {
    render(<GoalsMobileSectionSwitcher active="overview" onSelect={jest.fn()} />)
    const list = screen.getByTestId("mobile-goals-switcher")
    expect(list).toHaveAttribute("role", "tablist")
    expect(list).toHaveAccessibleName()
    expect(screen.getAllByRole("tab")).toHaveLength(3)
    expect(screen.getByTestId("mobile-goals-section-overview")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goals-section-history")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goals-section-analytics")).toBeInTheDocument()
  })

  it("marks the active section and reports selection", async () => {
    const user = userEvent.setup()
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
    await user.click(screen.getByTestId("mobile-goals-section-analytics"))
    expect(onSelect).toHaveBeenCalledWith("analytics")
  })

  // The audit reproduced ArrowRight doing nothing on the old Button strip.
  it("moves focus and selection with the arrow keys", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    render(<Harness onSelect={onSelect} />)
    const overview = screen.getByTestId("mobile-goals-section-overview")
    const history = screen.getByTestId("mobile-goals-section-history")
    const analytics = screen.getByTestId("mobile-goals-section-analytics")

    act(() => overview.focus())
    await user.keyboard("{ArrowRight}")
    expect(history).toHaveFocus()
    expect(history).toHaveAttribute("aria-selected", "true")
    expect(onSelect).toHaveBeenLastCalledWith("history")

    await user.keyboard("{End}")
    expect(analytics).toHaveFocus()
    expect(analytics).toHaveAttribute("aria-selected", "true")

    await user.keyboard("{ArrowRight}")
    expect(overview).toHaveFocus()
    expect(overview).toHaveAttribute("aria-selected", "true")
  })

  it("associates the active tab with the panel the caller renders", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const overview = screen.getByTestId("mobile-goals-section-overview")
    const panel = screen.getByRole("tabpanel")
    expect(panel).toBe(screen.getByTestId("panel"))
    expect(overview).toHaveAttribute("aria-controls", panel.id)
    expect(panel).toHaveAttribute("aria-labelledby", overview.id)
    expect(panel).toHaveTextContent("overview")

    await user.click(screen.getByTestId("mobile-goals-section-history"))
    const next = screen.getByRole("tabpanel")
    expect(next).toHaveTextContent("history")
    expect(screen.getByTestId("mobile-goals-section-history")).toHaveAttribute(
      "aria-controls",
      next.id
    )
  })
})
