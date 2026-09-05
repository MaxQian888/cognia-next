import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { CapabilityGrid, asideSpan } from "./capability-grid"

const DOCS = "https://docs.cognia.example"
const entries = en.product.sections[0].entries

describe("CapabilityGrid", () => {
  it("renders one cell per entry", () => {
    render(
      <CapabilityGrid
        entries={entries}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    expect(screen.getAllByRole("listitem")).toHaveLength(entries.length)
  })

  it("renders each entry's name and body", () => {
    render(
      <CapabilityGrid
        entries={entries}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    for (const entry of entries) {
      expect(screen.getByText(entry.name)).toBeInTheDocument()
      expect(screen.getByText(entry.body)).toBeInTheDocument()
    }
  })

  it("links documented entries to the docs origin with the locale prefix", () => {
    render(
      <CapabilityGrid
        entries={entries}
        learnMore={en.common.learnMore}
        locale="zh"
        docsOrigin={DOCS}
      />
    )
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"))
    expect(hrefs[0]).toBe(`${DOCS}/zh${entries[0].docsPath}`)
  })

  it("renders no link for an undocumented entry", () => {
    render(
      <CapabilityGrid
        entries={[{ key: "a", name: "Undocumented", body: "Body" }]}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("matches the surrounding section's tone", () => {
    const { container } = render(
      <CapabilityGrid
        entries={entries}
        learnMore={en.common.learnMore}
        locale="en"
        tone="surface"
        docsOrigin={DOCS}
      />
    )
    expect(container.querySelector("li")).toHaveClass("bg-surface")
  })

  it("fills the cells the entries leave open with the aside, hidden from assistive tech", () => {
    const two = entries.slice(0, 2)
    const { container } = render(
      <CapabilityGrid
        entries={two}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
        aside={<div>filler</div>}
      />
    )
    const aside = container.querySelector('[data-slot="capability-aside"]')
    expect(aside).toHaveAttribute("aria-hidden")
    expect(aside).toHaveClass("md:col-span-2")
    expect(aside).toHaveClass("xl:col-span-1")
    // The list still announces only the real entries.
    expect(screen.getAllByRole("listitem")).toHaveLength(two.length)
  })

  it("renders no filler cell when none is given", () => {
    const { container } = render(
      <CapabilityGrid
        entries={entries}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    expect(container.querySelector('[data-slot="capability-aside"]')).toBeNull()
  })

  it.each([
    [2, "md:col-span-2 xl:col-span-1"],
    [4, "md:col-span-2 xl:col-span-2"],
    [3, "md:col-span-1 xl:col-span-3"],
    [5, "md:col-span-1 xl:col-span-1"],
  ])("closes the grid mathematically for %i entries", (count, expected) => {
    expect(asideSpan(count)).toBe(expected)
  })
})
