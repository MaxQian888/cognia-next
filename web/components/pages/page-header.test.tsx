import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { PageHeader } from "./page-header"

const DOCS = "https://docs.example.test"

describe("PageHeader", () => {
  it("renders the eyebrow, title and subtitle", () => {
    render(<PageHeader copy={en.product.header} common={en.common} locale="en" />)
    expect(screen.getByText(en.product.header.eyebrow)).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { level: 1, name: en.product.header.title })
    ).toBeInTheDocument()
    expect(screen.getByText(en.product.header.subtitle)).toBeInTheDocument()
  })

  it("uses h1 exactly once, so search results land on the page's own name", () => {
    const { container } = render(
      <PageHeader copy={en.trust.header} common={en.common} locale="en" />
    )
    expect(container.querySelectorAll("h1")).toHaveLength(1)
  })

  it("localises", () => {
    render(<PageHeader copy={zh.product.header} common={zh.common} locale="zh" />)
    expect(
      screen.getByRole("heading", { level: 1, name: zh.product.header.title })
    ).toBeInTheDocument()
  })

  it("offers a way back to the homepage", () => {
    render(<PageHeader copy={en.product.header} common={en.common} locale="en" docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: en.common.breadcrumbHome })).toHaveAttribute(
      "href",
      "/"
    )
  })

  it("prefixes the breadcrumb for a non-default locale", () => {
    render(<PageHeader copy={zh.product.header} common={zh.common} locale="zh" docsOrigin={DOCS} />)
    expect(screen.getByRole("link", { name: zh.common.breadcrumbHome })).toHaveAttribute(
      "href",
      "/zh"
    )
  })

  it("indexes the page's anchored sections", () => {
    render(
      <PageHeader
        copy={en.product.header}
        common={en.common}
        locale="en"
        sections={en.product.sections}
        docsOrigin={DOCS}
      />
    )
    expect(screen.getByText(en.common.onThisPage)).toBeInTheDocument()

    const anchored = en.product.sections.filter((s) => s.id)
    expect(anchored.length).toBeGreaterThan(0)
    for (const section of anchored) {
      expect(screen.getByRole("link", { name: section.title })).toHaveAttribute(
        "href",
        `#${section.id}`
      )
    }
  })

  it("omits a section with no anchor rather than listing a dead entry", () => {
    render(
      <PageHeader
        copy={en.product.header}
        common={en.common}
        locale="en"
        sections={[
          { id: "real", title: "Anchored", subtitle: "s", entries: [] },
          { title: "Not anchored", subtitle: "s", entries: [] },
        ]}
        docsOrigin={DOCS}
      />
    )
    expect(screen.getByRole("link", { name: "Anchored" })).toBeInTheDocument()
    expect(screen.queryByText("Not anchored")).toBeNull()
  })

  it("renders no index at all when the page has no anchored sections", () => {
    render(
      <PageHeader copy={en.changelog.header} common={en.common} locale="en" docsOrigin={DOCS} />
    )
    expect(screen.queryByText(en.common.onThisPage)).toBeNull()
  })

  it("renders a page-specific meta slot", () => {
    render(
      <PageHeader
        copy={en.download.header}
        common={en.common}
        locale="en"
        meta={<p>Latest release</p>}
        docsOrigin={DOCS}
      />
    )
    expect(screen.getByText("Latest release")).toBeInTheDocument()
  })
})
