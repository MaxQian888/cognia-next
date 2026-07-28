import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

/**
 * The committed evidence snapshot has no tagged release, so `changelog-page.test.tsx`
 * only ever renders the unreleased half of the page. This file mounts the same
 * page against a snapshot that *does* have releases — the state the site enters
 * the first time a version ships, which otherwise reaches production untested.
 *
 * A separate file rather than a `jest.resetModules()` block in that one: reset
 * plus a dynamic import hands the page a second React instance, and its hooks
 * then run with a null dispatcher.
 */
jest.mock("@web/content/generated/evidence.json", () => ({
  ...jest.requireActual("@web/content/generated/evidence.json"),
  releases: [
    {
      tagName: "v0.2.0",
      name: "Cognia 0.2.0",
      prerelease: false,
      publishedAt: "2026-07-01T00:00:00Z",
      htmlUrl: "https://example.test/releases/v0.2.0",
      body: "Ships the notice area.",
      assets: [],
    },
    {
      tagName: "v0.3.0-rc.1",
      name: "Cognia 0.3.0 RC1",
      prerelease: true,
      publishedAt: "2026-07-10T00:00:00Z",
      htmlUrl: "https://example.test/releases/v0.3.0-rc.1",
      body: "Not history yet.",
      assets: [],
    },
    {
      tagName: "v0.1.0",
      name: "Cognia 0.1.0",
      prerelease: false,
      publishedAt: null,
      htmlUrl: "https://example.test/releases/v0.1.0",
      body: null,
      assets: [],
    },
  ],
}))

import { ChangelogPage } from "./changelog-page"

describe("ChangelogPage with a tagged release", () => {
  it("shows the released section once something has been tagged", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getByText(en.changelog.releasedTitle)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Cognia 0.2.0" })).toBeInTheDocument()
  })

  it("leaves prereleases out of the released history", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.queryByRole("heading", { name: "Cognia 0.3.0 RC1" })).toBeNull()
    expect(screen.queryByText("Not history yet.")).toBeNull()
  })

  it("renders release notes when the tag carries them", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getByText("Ships the notice area.")).toBeInTheDocument()
  })

  it("renders a release with no notes without an empty paragraph", () => {
    const { container } = render(<ChangelogPage locale="en" />)
    const heading = screen.getByRole("heading", { name: "Cognia 0.1.0" })
    const row = heading.closest("li")
    expect(row).not.toBeNull()
    expect(container.contains(row!)).toBe(true)
    // Only the title/date line — no body paragraph was rendered for a null body.
    expect(row!.querySelectorAll("p")).toHaveLength(1)
  })

  it("still renders the unreleased feed below the released history", () => {
    render(<ChangelogPage locale="en" />)
    expect(screen.getByText(en.changelog.unreleasedTitle)).toBeInTheDocument()
  })
})
