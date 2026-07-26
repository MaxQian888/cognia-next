import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { CapabilityGrid } from "./capability-grid"

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
})
