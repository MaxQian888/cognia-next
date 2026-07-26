import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { SiteFooter } from "./site-footer"

const DOCS = "https://docs.cognia.example"

describe("SiteFooter", () => {
  it("renders the three documented columns", () => {
    render(<SiteFooter locale="en" copy={en} docsOrigin={DOCS} />)
    for (const column of en.footer.columns) {
      expect(screen.getByText(column.title)).toBeInTheDocument()
    }
  })

  it("resolves every link to a destination — no empty entries ship", () => {
    render(<SiteFooter locale="en" copy={en} docsOrigin={DOCS} />)
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).toBeTruthy()
    }
  })

  it("omits Roadmap and Community, which are not public surfaces", () => {
    render(<SiteFooter locale="en" copy={en} docsOrigin={DOCS} />)
    expect(screen.queryByRole("link", { name: "Roadmap" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Community" })).toBeNull()
  })

  it("links the license to the file in the repository", () => {
    render(<SiteFooter locale="en" copy={en} docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: "AGPL-3.0-or-later" })).toHaveAttribute(
      "href",
      "https://github.com/MaxQian888/cognia-next/blob/master/LICENSE"
    )
  })

  it("sends docs entries to the documentation origin with the locale prefix", () => {
    render(<SiteFooter locale="zh" copy={zh} docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: "文档" })).toHaveAttribute("href", `${DOCS}/zh/docs`)
  })

  it("prefixes site routes with the current locale", () => {
    render(<SiteFooter locale="zh" copy={zh} docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: "变更日志" })).toHaveAttribute("href", "/zh/changelog")
  })

  it("keeps product anchors pointing into the product page", () => {
    render(<SiteFooter locale="en" copy={en} docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("href", "/product#chat")
  })

  it("uses native disclosure elements so the accordion needs no JavaScript", () => {
    const { container } = render(<SiteFooter locale="en" copy={en} docsOrigin={DOCS} />)
    expect(container.querySelectorAll("details.footer-accordion")).toHaveLength(
      en.footer.columns.length
    )
  })

  it("carries the colophon, which makes no unverifiable claim", () => {
    render(<SiteFooter locale="en" copy={en} docsOrigin={DOCS} />)
    expect(screen.getByText(en.footer.colophon)).toBeInTheDocument()
  })
})
