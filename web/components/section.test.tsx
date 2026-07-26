import { render, screen } from "@testing-library/react"
import { Section, SectionHeading } from "./section"

describe("Section", () => {
  it("renders its children inside a landmark", () => {
    const { container } = render(<Section>content</Section>)
    expect(container.querySelector("section")).toBeInTheDocument()
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("carries an id so navigation anchors can target it", () => {
    const { container } = render(<Section id="chat">content</Section>)
    expect(container.querySelector("section#chat")).toBeInTheDocument()
  })

  it("defaults to the paper reading layer", () => {
    const { container } = render(<Section>content</Section>)
    expect(container.querySelector("section")).toHaveClass("bg-paper")
  })

  it("switches to the dark execution stage on request", () => {
    const { container } = render(<Section tone="stage">content</Section>)
    const section = container.querySelector("section")
    expect(section).toHaveClass("bg-stage")
    // `ink` flips with the theme; the stage stays dark in both modes, so its
    // text must come from the on-stage tokens instead.
    expect(section).toHaveClass("text-on-stage")
    expect(section).not.toHaveClass("text-ink")
  })

  it("applies one shared max width and rhythm to every section", () => {
    const { container } = render(<Section>content</Section>)
    const shell = container.querySelector("section > div")
    expect(shell).toHaveClass("max-w-shell")
    expect(shell?.className).toMatch(/lg:py-40/)
  })
})

describe("SectionHeading", () => {
  it("renders the title as a heading", () => {
    render(<SectionHeading title="One task. Every step visible." />)
    expect(
      screen.getByRole("heading", { name: "One task. Every step visible." })
    ).toBeInTheDocument()
  })

  it("renders the eyebrow and subtitle when supplied", () => {
    render(<SectionHeading eyebrow="Product" title="Title" subtitle="Subtitle" />)
    expect(screen.getByText("Product")).toBeInTheDocument()
    expect(screen.getByText("Subtitle")).toBeInTheDocument()
  })

  it("omits the eyebrow and subtitle when not supplied", () => {
    const { container } = render(<SectionHeading title="Title" />)
    expect(container.querySelectorAll("p")).toHaveLength(0)
  })

  it("keeps headings at medium weight rather than stacking ultra-bold lines", () => {
    render(<SectionHeading title="Title" />)
    expect(screen.getByRole("heading", { name: "Title" })).toHaveClass("font-medium")
  })

  it("uses the on-stage text tokens in the dark stage", () => {
    render(<SectionHeading title="Title" subtitle="Subtitle" tone="stage" />)
    expect(screen.getByRole("heading", { name: "Title" })).toHaveClass("text-on-stage")
    expect(screen.getByText("Subtitle")).toHaveClass("text-on-stage-muted")
  })
})
