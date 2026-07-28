import { render, screen } from "@testing-library/react"
import { SectionIndexRail } from "./section-index-rail"

const SECTIONS = ["hero", "task", "trust"] as const
const LABELS = { hero: "Start", task: "One task", trust: "Trust" }

describe("SectionIndexRail", () => {
  beforeEach(() => {
    document.body.innerHTML = SECTIONS.map((id) => `<section id="${id}"></section>`).join("")
  })

  it("is a labelled navigation landmark", () => {
    render(<SectionIndexRail sections={SECTIONS} labels={LABELS} label="Sections" />)
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument()
  })

  it("links to every section by anchor, so it works without JavaScript", () => {
    render(<SectionIndexRail sections={SECTIONS} labels={LABELS} label="Sections" />)
    expect(screen.getByRole("link", { name: "Start" })).toHaveAttribute("href", "#hero")
    expect(screen.getByRole("link", { name: "One task" })).toHaveAttribute("href", "#task")
    expect(screen.getByRole("link", { name: "Trust" })).toHaveAttribute("href", "#trust")
  })

  it("marks the reader's position with aria-current=location, not page", () => {
    // `page` would claim this is the current route; the reader has not
    // navigated anywhere.
    render(<SectionIndexRail sections={SECTIONS} labels={LABELS} label="Sections" />)
    const current = screen.getByRole("link", { name: "Start" })
    expect(current).toHaveAttribute("aria-current", "location")
    expect(screen.getByRole("link", { name: "Trust" })).not.toHaveAttribute("aria-current")
  })

  it("does not carry the position in colour alone", () => {
    // The active entry's mark is wider as well as accented, so the state
    // survives a reader who cannot distinguish the two colours.
    const { container } = render(
      <SectionIndexRail sections={SECTIONS} labels={LABELS} label="Sections" />
    )
    expect(container.querySelector(".w-6.bg-action")).toBeInTheDocument()
    expect(container.querySelectorAll(".w-3.bg-hairline-strong")).toHaveLength(2)
  })

  it("is hidden until the viewport is wider than the shell plus a gutter", () => {
    // A named breakpoint is not enough: the shell is 1480px, so at `xl`
    // (1280px) — and at `2xl` (1536px) — the page fills the window and a fixed
    // rail would render on top of the hero instead of beside it.
    const { container } = render(
      <SectionIndexRail sections={SECTIONS} labels={LABELS} label="Sections" />
    )
    const nav = container.querySelector("nav")
    expect(nav?.className).toContain("hidden")
    expect(nav?.className).toContain("min-[1760px]:block")
    expect(nav?.className).not.toContain("xl:block")
  })
})
