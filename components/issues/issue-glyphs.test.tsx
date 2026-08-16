/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/types/issues"
import { IssuePriorityIcon, IssueStatusIcon, STATUS_COLUMN_TINT } from "./issue-glyphs"

describe("IssueStatusIcon", () => {
  it.each(ISSUE_STATUSES)("renders a distinct glyph for %s", (status) => {
    render(<IssueStatusIcon status={status} />)
    expect(screen.getByTestId(`issue-status-icon-${status}`)).toBeInTheDocument()
  })

  it("is decorative — the status name is rendered as text elsewhere", () => {
    render(<IssueStatusIcon status="todo" />)
    expect(screen.getByTestId("issue-status-icon-todo")).toHaveAttribute("aria-hidden", "true")
  })

  it("merges a caller className without dropping the status colour", () => {
    render(<IssueStatusIcon status="done" className="size-6" />)
    const icon = screen.getByTestId("issue-status-icon-done")
    expect(icon.getAttribute("class")).toContain("size-6")
    expect(icon.getAttribute("class")).toContain("text-blue-500")
  })
})

describe("IssuePriorityIcon", () => {
  it.each(ISSUE_PRIORITIES)("renders a distinct glyph for %s", (priority) => {
    render(<IssuePriorityIcon priority={priority} />)
    expect(screen.getByTestId(`issue-priority-icon-${priority}`)).toBeInTheDocument()
  })

  it("flags urgent in red so it reads at a glance on a dense board", () => {
    render(<IssuePriorityIcon priority="urgent" />)
    expect(screen.getByTestId("issue-priority-icon-urgent").getAttribute("class")).toContain(
      "text-red-500"
    )
  })
})

describe("STATUS_COLUMN_TINT", () => {
  it("covers every status, so no column can render untinted", () => {
    for (const status of ISSUE_STATUSES) {
      expect(STATUS_COLUMN_TINT[status]).toBeTruthy()
    }
  })
})
