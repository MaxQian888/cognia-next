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
    expect(rhythm[0]).toBe("py-20")
  })

  it("draws no rhythm texture and no index numbers on sub-page sections", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    // DESIGN.md: texture only under an instrument, and sub-pages do not number
    // their sections (the homepage's index tags are its own).
    expect(container.querySelectorAll(".rhythm-lines")).toHaveLength(0)
    for (const heading of container.querySelectorAll("section h2")) {
      expect(heading.previousElementSibling).toBeNull()
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

  it("fills the workflow and plugin sections' open cells with the matching reconstruction", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.workflows.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
        reconstruction={en.reconstruction}
      />
    )
    const asides = container.querySelectorAll('[data-slot="capability-aside"]')
    expect(asides).toHaveLength(2)
    expect(screen.getAllByText(en.reconstruction.workflow.triggerName).length).toBe(1)
    expect(screen.getAllByText(en.reconstruction.workflow.runsLabel).length).toBeGreaterThan(0)
  })

  it("renders no filler for sections whose entries already close the grid", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
        reconstruction={en.reconstruction}
      />
    )
    expect(container.querySelector('[data-slot="capability-aside"]')).toBeNull()
  })

  it("sets a section's entries in one column beside its figure, and renders what follows", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
        extras={{
          chat: { figure: <p>chat figure</p>, after: <p>after chat</p> },
        }}
      />
    )
    const chat = container.querySelector("section#chat") as HTMLElement
    const row = chat.querySelector('[data-slot="capability-figure-row"]') as HTMLElement
    expect(row).toHaveTextContent("chat figure")
    expect(row.querySelector("ul")?.className).not.toContain("md:grid-cols-2")
    expect(chat).toHaveTextContent("after chat")
    // Sections without extras keep the three-column grid.
    const agents = container.querySelector("section#agents") as HTMLElement
    expect(agents.querySelector("ul")?.className).toContain("md:grid-cols-2")
  })

  it("can start the alternation on the surface tone", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.product.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
        startTone="surface"
      />
    )
    const sections = container.querySelectorAll("section")
    expect(sections[0]).toHaveClass("bg-surface")
    expect(sections[1]).toHaveClass("bg-paper")
  })

  it("marks each surfaces-page block with its own icon", () => {
    const { container } = render(
      <CapabilitySections
        sections={en.surfaces.sections}
        learnMore={en.common.learnMore}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    for (const section of en.surfaces.sections) {
      expect(container.querySelector(`section#${section.id} h2 svg`)).toBeInTheDocument()
    }
  })
})
