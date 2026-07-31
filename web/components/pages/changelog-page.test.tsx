import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { evidence } from "@web/components/site-shell"
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
    expect(screen.getByText(evidence.changesets[0].summary)).toBeInTheDocument()
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

  it("localises the month headings and the labels", () => {
    render(<ChangelogPage locale="zh" />)
    expect(screen.getByText(zh.changelog.unreleasedTitle)).toBeInTheDocument()
    expect(screen.getAllByRole("heading", { level: 3 })[0].textContent).toMatch(/年|无日期/)
  })
})
