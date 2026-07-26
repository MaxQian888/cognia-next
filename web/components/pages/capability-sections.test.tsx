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
