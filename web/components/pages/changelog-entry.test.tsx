import { fireEvent, render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { FOLD_CHARACTERS } from "@web/lib/markdown-inline"
import { ChangelogEntry } from "./changelog-entry"

const short = {
  id: "notice-area",
  bump: "minor" as const,
  summary: "Ships the **notice** area.",
  date: "2026-07-26T00:00:00Z",
}

const long = {
  id: "remote-sessions",
  bump: "patch" as const,
  summary: `${"Stopping a run now says so. ".repeat(3)}\n\n**On upgrade:** ${"x".repeat(FOLD_CHARACTERS)}`,
  date: null,
}

describe("ChangelogEntry", () => {
  it("labels the severity in words and glyph, and dates the entry", () => {
    render(
      <ul>
        <ChangelogEntry entry={short} copy={en.changelog} />
      </ul>
    )
    expect(screen.getByText(en.changelog.bumpLabels.minor)).toBeInTheDocument()
    expect(screen.getByText("2026-07-26")).toBeInTheDocument()
  })

  it("renders the body from its Markdown", () => {
    const { container } = render(
      <ul>
        <ChangelogEntry entry={short} copy={en.changelog} />
      </ul>
    )
    expect(container.querySelector("strong")).toHaveTextContent("notice")
    expect(container.textContent).not.toContain("**")
  })

  it("shows a short entry in full with no toggle", () => {
    const { container } = render(
      <ul>
        <ChangelogEntry entry={short} copy={en.changelog} />
      </ul>
    )
    expect(screen.queryByRole("button")).toBeNull()
    expect(container.querySelector("[data-folded]")).toBeNull()
  })

  it("folds a long entry and expands it on request, exposing the state", () => {
    const { container } = render(
      <ul>
        <ChangelogEntry entry={long} copy={en.changelog} />
      </ul>
    )
    expect(container.querySelector("[data-folded]")).toBeInTheDocument()
    const toggle = screen.getByRole("button", { name: en.changelog.expandEntry })
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(toggle)
    expect(container.querySelector("[data-folded]")).toBeNull()
    expect(screen.getByRole("button", { name: en.changelog.collapseEntry })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  })

  it("keeps the whole body in the document while folded", () => {
    render(
      <ul>
        <ChangelogEntry entry={long} copy={en.changelog} />
      </ul>
    )
    expect(screen.getByText("On upgrade:")).toBeInTheDocument()
  })

  it("shows an undated entry without inventing a date", () => {
    render(
      <ul>
        <ChangelogEntry entry={long} copy={en.changelog} />
      </ul>
    )
    expect(screen.getByText("—")).toBeInTheDocument()
  })

  it("localises the toggle", () => {
    render(
      <ul>
        <ChangelogEntry entry={long} copy={zh.changelog} />
      </ul>
    )
    expect(screen.getByRole("button", { name: zh.changelog.expandEntry })).toBeInTheDocument()
  })
})
