import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { ProductPage } from "./product-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

describe("ProductPage", () => {
  it("renders inside the shared shell", () => {
    render(<ProductPage locale="en" />)
    expect(screen.getByRole("navigation")).toBeInTheDocument()
    expect(screen.getByRole("contentinfo")).toBeInTheDocument()
  })

  it("carries the page's own h1", () => {
    render(<ProductPage locale="en" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.product.header.title })
    ).toBeInTheDocument()
  })

  it("renders every surface section", () => {
    render(<ProductPage locale="en" />)
    for (const section of en.product.sections) {
      expect(screen.getByRole("heading", { name: section.title, level: 2 })).toBeInTheDocument()
    }
  })

  it("provides the anchors the navigation dropdown links to", () => {
    const { container } = render(<ProductPage locale="en" />)
    for (const item of en.nav.productMenu.items) {
      const anchor = item.route.split("#")[1]
      expect(container.querySelector(`section#${anchor}`)).toBeInTheDocument()
    }
  })

  it("keeps the language switcher on the product route", () => {
    render(<ProductPage locale="en" />)
    expect(screen.getAllByRole("link", { name: "中文" })[0]).toHaveAttribute("href", "/zh/product")
  })

  it("localises", () => {
    render(<ProductPage locale="zh" />)
    expect(
      screen.getByRole("heading", { level: 1, name: zh.product.header.title })
    ).toBeInTheDocument()
  })
})
