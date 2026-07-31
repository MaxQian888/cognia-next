import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { CapabilitySections } from "./capability-sections"

const DOCS = "https://docs.cognia.example"

describe("CapabilitySections", () => {
  it("renders every section and every entry", () => {
    render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    for (const section of en.product.sections) {
      expect(screen.getByRole("heading", { name: section.title })).toBeInTheDocument()
      for (const entry of section.entries) {
        expect(screen.getByText(entry.name)).toBeInTheDocument()
        expect(screen.getByText(entry.body)).toBeInTheDocument()
      }
    }
  })

  it("gives each section the anchor id the navigation targets", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    for (const id of ["chat", "agents", "knowledge", "desktop"]) {
      expect(container.querySelector(`section#${id}`)).toBeInTheDocument()
    }
  })

  it("alternates the vertical rhythm so no two adjacent sections match", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    const shells = [...container.querySelectorAll("section > div")]
    expect(shells.length).toBeGreaterThan(1)

    // Tone alone gives a boundary; it does not give a cadence, because both
    // blocks stay the same height. The rhythm has to alternate too.
    const rhythm = shells.map((shell) => {
      const base = [...shell.classList].find((c) => /^py-\d+$/.test(c))
      if (!base) throw new Error(`section shell carries no base rhythm: ${shell.className}`)
      return base
    })
    for (let i = 1; i < rhythm.length; i += 1) {
      expect(rhythm[i]).not.toBe(rhythm[i - 1])
    }
    // The opening block is the page's upper bound.
    expect(rhythm[0]).toBe("py-32")
  })

  it("draws the rhythm lines on the opening block only", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    // A structural mark for where the index begins, not a texture to repeat.
    expect(container.querySelectorAll(".rhythm-lines")).toHaveLength(1)
    expect(container.querySelector("section")?.querySelector(".rhythm-lines")).toBeInTheDocument()
  })

  it("links every documented entry to the docs site with the locale prefix", () => {
    render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="zh"
        docsOrigin={DOCS}
      />
    )
    const hrefs = screen
      .getAllByRole("link", { name: en.common.learnMore })
      .map((link) => link.getAttribute("href"))
    for (const section of en.product.sections) {
      for (const entry of section.entries) {
        if (!entry.docsPath) continue
        expect(hrefs).toContain(`${DOCS}/zh${entry.docsPath}`)
      }
    }
  })

  it("renders no link for an entry with no documentation rather than a dead one", () => {
    render(
      <CapabilitySections
        sections={[
          {
            title: "Section",
            subtitle: "Subtitle",
            entries: [{ key: "a", name: "Undocumented", body: "Body" }],
          },
        ]}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("alternates section tones so a long page keeps its rhythm", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    const sections = [...container.querySelectorAll("section")]
    expect(sections[0]).toHaveClass("bg-paper")
    expect(sections[1]).toHaveClass("bg-surface")
  })

  it("localises", () => {
    render(
      <CapabilitySections
        sections={zh.product.sections}
        learnMore={zh.common.learnMore}
        locale="zh"
        docsOrigin={DOCS}
      />
    )
    expect(screen.getByRole("heading", { name: zh.product.sections[0].title })).toBeInTheDocument()
  })
})
