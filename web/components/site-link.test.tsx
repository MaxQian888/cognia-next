import { render, screen } from "@testing-library/react"
import { SiteLink } from "./site-link"

const DOCS = "https://docs.cognia.example"

describe("SiteLink", () => {
  it("renders an internal route with its locale prefix", () => {
    render(<SiteLink target={{ label: "Trust", route: "/trust" }} locale="zh" docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: "Trust" })).toHaveAttribute("href", "/zh/trust")
  })

  it("does not open internal routes in a new tab", () => {
    render(<SiteLink target={{ label: "Trust", route: "/trust" }} locale="en" docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: "Trust" })).not.toHaveAttribute("target")
  })

  it("opens external destinations in a new tab with rel=noreferrer", () => {
    render(
      <SiteLink
        target={{ label: "Source", href: "https://github.com/x/y" }}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    const link = screen.getByRole("link", { name: "Source" })
    expect(link).toHaveAttribute("href", "https://github.com/x/y")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer")
  })

  it("treats the docs site as external and carries the locale across", () => {
    render(<SiteLink target={{ label: "Docs", docsPath: "/docs" }} locale="zh" docsOrigin={DOCS} />)
    const link = screen.getByRole("link", { name: "Docs" })
    expect(link).toHaveAttribute("href", `${DOCS}/zh/docs`)
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("marks an external destination as leaving the origin", () => {
    const { container } = render(
      <SiteLink
        target={{ label: "Source", href: "https://github.com/x/y" }}
        locale="en"
        docsOrigin={DOCS}
      />
    )
    const svg = container.querySelector("a svg")
    expect(svg).toBeInTheDocument()
    // Inside the anchor and hidden, so the accessible name stays exactly the
    // label — this is what lets ~40 links gain a mark without touching a single
    // `getByRole(…, { name })` assertion anywhere on the site.
    expect(svg).toHaveAttribute("aria-hidden", "true")
    expect(screen.getByRole("link", { name: "Source" })).toBeInTheDocument()
  })

  it("does not mark internal routes, which stay in this tab", () => {
    const { container } = render(
      <SiteLink target={{ label: "Trust", route: "/trust" }} locale="en" docsOrigin={DOCS} />
    )
    expect(container.querySelector("a svg")).toBeNull()
  })

  it("renders children in place of the label when given", () => {
    render(
      <SiteLink target={{ label: "Trust", route: "/trust" }} locale="en" docsOrigin={DOCS}>
        <span>Custom</span>
      </SiteLink>
    )
    expect(screen.getByRole("link", { name: "Custom" })).toBeInTheDocument()
  })

  it("passes a class name through for layout-specific styling", () => {
    render(
      <SiteLink
        target={{ label: "Trust", route: "/trust" }}
        locale="en"
        docsOrigin={DOCS}
        className="test-class"
      />
    )
    expect(screen.getByRole("link", { name: "Trust" })).toHaveClass("test-class")
  })
})
