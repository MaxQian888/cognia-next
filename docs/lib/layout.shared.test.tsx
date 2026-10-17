/** @jest-environment jsdom */

jest.mock("fumadocs-ui/i18n", () => ({
  defineI18nUI: jest.fn(() => ({})),
}))
jest.mock("../../lib/i18n", () => ({ i18n: {} }), { virtual: true })

import { render, screen } from "@testing-library/react"
import { baseOptions } from "./layout.shared"

describe("docs layout branding", () => {
  it("uses the Cognia product name beside the brand mark in navigation", () => {
    const { container } = render(<>{baseOptions("en").nav?.title}</>)
    expect(screen.getByText("Cognia")).toBeInTheDocument()
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })

  it("sends the brand link to the locale's landing page", () => {
    expect(baseOptions("en").nav?.url).toBe("/en")
    expect(baseOptions("zh").nav?.url).toBe("/zh")
  })

  it("links the repository", () => {
    expect(baseOptions("en").githubUrl).toBe("https://github.com/MaxQian888/cognia-next")
  })
})
