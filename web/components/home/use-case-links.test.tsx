import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { UseCaseLinks } from "./use-case-links"

describe("UseCaseLinks", () => {
  it("links to both scenario pages with the navigation's own words", () => {
    render(
      <UseCaseLinks
        label={en.home.signature.useCasesLabel}
        items={en.nav.useCasesMenu.items}
        locale="en"
      />
    )
    expect(screen.getByText(en.home.signature.useCasesLabel)).toBeInTheDocument()
    for (const item of en.nav.useCasesMenu.items) {
      const link = screen.getByRole("link", { name: new RegExp(item.label) })
      expect(link).toHaveAttribute("href", item.route)
      expect(link).toHaveTextContent(item.description)
    }
  })

  it("prefixes the locale on Chinese pages", () => {
    render(
      <UseCaseLinks
        label={zh.home.signature.useCasesLabel}
        items={zh.nav.useCasesMenu.items}
        locale="zh"
      />
    )
    expect(screen.getByRole("link", { name: /软件开发/ })).toHaveAttribute(
      "href",
      "/zh/use-cases/development"
    )
  })
})
