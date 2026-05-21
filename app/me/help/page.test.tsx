/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import Page from "./page"

describe("MobileHelpPage", () => {
  it("renders docs and github rows", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-help-page")).toBeInTheDocument()
    expect(screen.getByTestId("help-row-docs")).toHaveAttribute("href", "https://docs.cognia.app")
    expect(screen.getByTestId("help-row-github")).toHaveAttribute(
      "href",
      "https://github.com/anthropics/claude-code"
    )
  })

  it("renders the license info row", () => {
    render(<Page />)
    expect(screen.getByTestId("help-row-license")).toBeInTheDocument()
  })
})
