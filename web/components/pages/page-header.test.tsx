import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { PageHeader } from "./page-header"

describe("PageHeader", () => {
  it("renders the eyebrow, title and subtitle", () => {
    render(<PageHeader copy={en.product.header} />)
    expect(screen.getByText(en.product.header.eyebrow)).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { level: 1, name: en.product.header.title })
    ).toBeInTheDocument()
    expect(screen.getByText(en.product.header.subtitle)).toBeInTheDocument()
  })

  it("uses h1 exactly once, so search results land on the page's own name", () => {
    const { container } = render(<PageHeader copy={en.trust.header} />)
    expect(container.querySelectorAll("h1")).toHaveLength(1)
  })

  it("localises", () => {
    render(<PageHeader copy={zh.product.header} />)
    expect(
      screen.getByRole("heading", { level: 1, name: zh.product.header.title })
    ).toBeInTheDocument()
  })
})
