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

  it.each([
    ["flush", "py-0"],
    ["tight", "py-12"],
    ["normal", "py-24"],
    ["open", "py-32"],
  ] as const)("gives %s sections their own vertical rhythm", (density, expected) => {
    const { container } = render(<Section density={density}>content</Section>)
    expect(container.querySelector("section > div")).toHaveClass(expected)
  })

  it("makes `flush` genuinely zero rather than a smaller ramp step", () => {
    // The whole point of the density scale is alternation: a section that reads
    // as a breath between two tall ones has to be able to drop its padding
    // entirely, not merely take the smallest rung.
    const { container } = render(<Section density="flush">content</Section>)
    const shell = container.querySelector("section > div")
    expect(shell?.className).not.toMatch(/py-(?!0\b)/)
    expect(shell?.className).not.toMatch(/(md|lg):py-/)
  })

  it("opens a left channel only from lg when offset", () => {
    const { container } = render(<Section align="offset">content</Section>)
    const tokens = container.querySelector("section > div")!.className.split(/\s+/)
    expect(tokens.some((t) => t.startsWith("lg:pl-["))).toBe(true)
    // Below lg the section is already narrow; indenting it there would only
    // cost line length, so no unprefixed `pl-` may appear.
    expect(tokens.some((t) => t.startsWith("pl-"))).toBe(false)
  })

  it("stays centred by default", () => {
    const { container } = render(<Section>content</Section>)
    const tokens = container.querySelector("section > div")!.className.split(/\s+/)
    expect(tokens.some((t) => t.startsWith("lg:pl-["))).toBe(false)
  })

  it("draws the rhythm lines only when asked, and hides them from assistive tech", () => {
    const { container: without } = render(<Section>content</Section>)
    expect(without.querySelector(".rhythm-lines")).toBeNull()

    const { container: with_ } = render(<Section rule>content</Section>)
    const lines = with_.querySelector(".rhythm-lines")
    expect(lines).toBeInTheDocument()
    expect(lines).toHaveAttribute("aria-hidden")
    // Decorative and behind the content — it must never swallow a click.
    expect(lines).toHaveClass("pointer-events-none")
  })

  it("keeps the shell above the rhythm lines", () => {
    // Both are positioned; without `relative` on the shell the absolutely
    // positioned rule layer would paint over the content.
    const { container } = render(<Section rule>content</Section>)
    expect(container.querySelector("section")).toHaveClass("relative")
    expect(container.querySelector("section > div")).toHaveClass("relative")
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
