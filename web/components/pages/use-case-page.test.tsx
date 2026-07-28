import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { UseCasePage } from "./use-case-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

describe("UseCasePage — development", () => {
  it("carries the page heading", () => {
    render(<UseCasePage locale="en" variant="development" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.useCases.development.header.title })
    ).toBeInTheDocument()
  })

  it("says outright that it is dogfooding rather than a customer story", () => {
    render(<UseCasePage locale="en" variant="development" />)
    expect(screen.getByText(en.useCases.development.provenance)).toBeInTheDocument()
  })

  it("renders the script as an ordered list of steps", () => {
    const { container } = render(<UseCasePage locale="en" variant="development" />)
    const steps = container.querySelector("ol")?.querySelectorAll("li")
    expect(steps).toHaveLength(en.useCases.development.steps.length)
  })

  // Scoped to the script list on purpose. The page now also renders a
  // `ProductStage` whose own labels overlap the rail vocabulary ("Artifact"),
  // so a page-wide `getByText` matches twice and says nothing about whether
  // the step actually rendered.
  it("names every step's rail label, title and detail", () => {
    const { container } = render(<UseCasePage locale="en" variant="development" />)
    const list = container.querySelector("ol")
    expect(list).not.toBeNull()
    const steps = within(list!)
    for (const step of en.useCases.development.steps) {
      expect(steps.getByText(step.rail)).toBeInTheDocument()
      expect(steps.getByRole("heading", { name: step.title })).toBeInTheDocument()
      expect(steps.getByText(step.detail)).toBeInTheDocument()
    }
  })

  it("links every capability the script uses to its documentation", () => {
    render(<UseCasePage locale="en" variant="development" />)
    const hrefs = screen
      .getAllByRole("link", { name: en.common.learnMore })
      .map((link) => link.getAttribute("href"))
    for (const entry of en.useCases.development.capabilities.entries) {
      expect(hrefs.some((href) => href?.endsWith(entry.docsPath ?? "###"))).toBe(true)
    }
  })

  it("routes the language switcher to the same use case", () => {
    render(<UseCasePage locale="en" variant="development" />)
    expect(screen.getAllByRole("link", { name: "中文" })[0]).toHaveAttribute(
      "href",
      "/zh/use-cases/development"
    )
  })
})

describe("UseCasePage — research", () => {
  it("renders a different script from the development page", () => {
    render(<UseCasePage locale="en" variant="research" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.useCases.research.header.title })
    ).toBeInTheDocument()
    expect(screen.getByText(en.useCases.research.provenance)).toBeInTheDocument()
  })

  it("describes what the tools do, not what a researcher achieved", () => {
    render(<UseCasePage locale="en" variant="research" />)
    for (const step of en.useCases.research.steps) {
      expect(screen.getByRole("heading", { name: step.title })).toBeInTheDocument()
    }
  })

  it("localises", () => {
    render(<UseCasePage locale="zh" variant="research" />)
    expect(screen.getByText(zh.useCases.research.provenance)).toBeInTheDocument()
  })
})
