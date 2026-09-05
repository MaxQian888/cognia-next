import { fireEvent, render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { ChangesetEntry } from "@web/lib/evidence"
import { CHANGELOG_PAGE_SIZE as PAGE_SIZE, monthAnchor } from "@web/lib/evidence"
import { ChangelogMonth } from "./changelog-month"

function entries(count: number): ChangesetEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    bump: "patch" as const,
    summary: `Entry number ${index}.`,
    date: "2026-07-10T00:00:00Z",
  }))
}

describe("ChangelogMonth", () => {
  it("names the month and counts its entries", () => {
    render(
      <ChangelogMonth
        group={{ key: "2026-07", entries: entries(3) }}
        copy={en.changelog}
        locale="en"
      />
    )
    expect(screen.getByRole("heading", { level: 3, name: "July 2026" })).toBeInTheDocument()
    expect(screen.getByText("3 entries")).toBeInTheDocument()
  })

  it("carries the anchor the month index links to", () => {
    const { container } = render(
      <ChangelogMonth
        group={{ key: "2026-07", entries: entries(1) }}
        copy={en.changelog}
        locale="en"
      />
    )
    expect(container.querySelector(`#${monthAnchor("2026-07")}`)).toBeInTheDocument()
  })

  it("opens the newest month and leaves older ones closed", () => {
    const { container, rerender } = render(
      <ChangelogMonth
        group={{ key: "2026-07", entries: entries(1) }}
        copy={en.changelog}
        locale="en"
        defaultOpen
      />
    )
    expect(container.querySelector("details")).toHaveAttribute("open")
    rerender(
      <ChangelogMonth
        group={{ key: "2026-06", entries: entries(1) }}
        copy={en.changelog}
        locale="en"
      />
    )
    expect(container.querySelector("details")).not.toHaveAttribute("open")
  })

  it("shows one page of entries and offers the rest on request", () => {
    render(
      <ChangelogMonth
        group={{ key: "2026-07", entries: entries(PAGE_SIZE + 5) }}
        copy={en.changelog}
        locale="en"
        defaultOpen
      />
    )
    expect(screen.getAllByRole("listitem")).toHaveLength(PAGE_SIZE)
    const more = screen.getByRole("button", { name: "Show 5 more" })
    fireEvent.click(more)
    expect(screen.getAllByRole("listitem")).toHaveLength(PAGE_SIZE + 5)
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull()
  })

  it("asks for at most one page at a time", () => {
    render(
      <ChangelogMonth
        group={{ key: "2026-07", entries: entries(PAGE_SIZE * 3) }}
        copy={en.changelog}
        locale="en"
        defaultOpen
      />
    )
    expect(screen.getByRole("button", { name: `Show ${PAGE_SIZE} more` })).toBeInTheDocument()
  })

  it("localises the month and the count", () => {
    render(
      <ChangelogMonth
        group={{ key: "2026-07", entries: entries(2) }}
        copy={zh.changelog}
        locale="zh"
      />
    )
    expect(screen.getByRole("heading", { level: 3 }).textContent).toMatch(/2026 年 7 月/)
    expect(screen.getByText("2 条")).toBeInTheDocument()
  })
})
