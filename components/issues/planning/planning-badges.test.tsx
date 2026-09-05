/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { render, screen } from "@testing-library/react"
import type { IssuePlanningHint } from "@/lib/issues/planning-hints"
import { PlanningBadges, formatDueDate } from "./planning-badges"

const item = { unifiedId: "local:a", estimate: 3, dueDate: Date.UTC(2026, 8, 6, 12) }

function hint(over: Partial<IssuePlanningHint> = {}): IssuePlanningHint {
  return { blocked: false, blockerIdentifiers: [], due: "none", ...over }
}

describe("PlanningBadges", () => {
  it("renders nothing for a quiet hint", () => {
    const { container } = render(<PlanningBadges item={item} hint={hint()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing without a hint unless the estimate is asked for", () => {
    const { container, rerender } = render(<PlanningBadges item={item} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<PlanningBadges item={item} showEstimate />)
    expect(screen.getByTestId("issue-badge-estimate-local:a")).toHaveTextContent(
      'points:{"count":3}'
    )
  })

  it("names the blockers in the blocked badge's title", () => {
    render(
      <PlanningBadges
        item={item}
        hint={hint({ blocked: true, blockerIdentifiers: ["A-1", "A-2"] })}
      />
    )
    expect(screen.getByTestId("issue-badge-blocked-local:a")).toHaveAttribute(
      "title",
      'blockedByList:{"list":"A-1, A-2"}'
    )
  })

  it("prints sub-issue progress as done over total", () => {
    render(<PlanningBadges item={item} hint={hint({ subIssues: { total: 4, done: 1 } })} />)
    expect(screen.getByTestId("issue-badge-subissues-local:a")).toHaveTextContent("1/4")
  })

  it("shows the due badge only when it says something, with the state as data", () => {
    const { rerender } = render(<PlanningBadges item={item} hint={hint({ due: "later" })} />)
    expect(screen.queryByTestId("issue-badge-due-local:a")).toBeNull()
    rerender(<PlanningBadges item={item} hint={hint({ due: "overdue" })} />)
    expect(screen.getByTestId("issue-badge-due-local:a")).toHaveAttribute("data-due", "overdue")
    rerender(<PlanningBadges item={item} hint={hint({ due: "met" })} />)
    expect(screen.queryByTestId("issue-badge-due-local:a")).toBeNull()
  })
})

describe("formatDueDate", () => {
  it("prints month and day, never the year", () => {
    expect(formatDueDate(Date.UTC(2026, 8, 6, 12), "en-US")).toBe("Sep 6")
  })
})
