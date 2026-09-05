import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { evidence } from "@web/components/site-shell"
import { groupChangelog } from "@web/lib/evidence"
import { ChangelogPage } from "./changelog-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

describe("ChangelogPage", () => {
  it("carries the page heading", () => {
    render(<ChangelogPage locale="en" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.changelog.header.title })
    ).toBeInTheDocument()
  })

  it("renders the unreleased feed from the repository's changeset entries", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getByText(en.changelog.unreleasedTitle)).toBeInTheDocument()
    // The body is rendered from its Markdown now, so match on the entry's id,
    // which every record prints verbatim. The newest month's first entry is
    // the one guaranteed to be on the opening page.
    expect(
      screen.getByText(groupChangelog(evidence.changesets)[0].entries[0].id)
    ).toBeInTheDocument()
  })

  it("prints no literal Markdown markers", () => {
    const { container } = render(<ChangelogPage locale="en" />)
    expect(container.textContent).not.toMatch(/\*\*[^*]+\*\*/)
  })

  it("opens only the newest month and pages the rest of its entries", () => {
    const { container } = render(<ChangelogPage locale="en" />)
    const months = [...container.querySelectorAll("details")]
    expect(months.length).toBeGreaterThan(1)
    expect(months[0]).toHaveAttribute("open")
    expect(months[1]).not.toHaveAttribute("open")
    expect(screen.getAllByRole("button", { name: /more/ }).length).toBeGreaterThan(0)
  })

  it("shows how the pending changes divide across bump levels, with counts in words", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getByText(en.changelog.distributionLabel)).toBeInTheDocument()
    const bar = screen.getByRole("img", { name: new RegExp(en.changelog.bumpLabels.minor) })
    expect(bar).toBeInTheDocument()
  })

  it("indexes every month with a live anchor", () => {
    const { container } = render(<ChangelogPage locale="en" />)
    const nav = screen.getByRole("navigation", { name: en.changelog.monthIndexLabel })
    for (const link of nav.querySelectorAll("a")) {
      const href = link.getAttribute("href") ?? ""
      expect(container.querySelector(href)).toBeInTheDocument()
    }
  })

  it("states how many entries there are instead of hand-writing a number", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getByText(`${evidence.changesets.length} entries`)).toBeInTheDocument()
  })

  it("omits the released section while nothing has been tagged", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.queryByText(en.changelog.releasedTitle)).toBeNull()
  })

  it("explains that these changes are awaiting the first release", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getByText(en.changelog.unreleasedNote)).toBeInTheDocument()
  })

  it("labels each entry's severity in words, not only by colour", () => {
    render(<ChangelogPage locale="en" />)
    const labels = [
      en.changelog.bumpLabels.major,
      en.changelog.bumpLabels.minor,
      en.changelog.bumpLabels.patch,
    ]
    expect(labels.some((label) => screen.queryAllByText(label).length > 0)).toBe(true)
  })

  it("groups entries under month headings", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0)
  })

  it("states how many entries are pending, not how many are mounted", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getAllByRole("listitem").length).toBeLessThan(evidence.changesets.length)
  })

  it("localises the month headings and the labels", () => {
    render(<ChangelogPage locale="zh" />)
    expect(screen.getByText(zh.changelog.unreleasedTitle)).toBeInTheDocument()
    expect(screen.getAllByRole("heading", { level: 3 })[0].textContent).toMatch(/年|无日期/)
  })
})
