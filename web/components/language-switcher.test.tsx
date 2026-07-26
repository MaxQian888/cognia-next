import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { LanguageSwitcher } from "./language-switcher"

describe("LanguageSwitcher", () => {
  it("keeps the reader on the same page when switching to Chinese", () => {
    render(<LanguageSwitcher locale="en" route="/trust" copy={en.nav} docsOrigin="https://d" />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/zh/trust")
  })

  it("keeps the reader on the same page when switching to English", () => {
    render(<LanguageSwitcher locale="zh" route="/trust" copy={zh.nav} docsOrigin="https://d" />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/trust")
  })

  it("handles the homepage in both directions", () => {
    const { unmount } = render(
      <LanguageSwitcher locale="en" route="/" copy={en.nav} docsOrigin="https://d" />
    )
    expect(screen.getByRole("link")).toHaveAttribute("href", "/zh")
    unmount()

    render(<LanguageSwitcher locale="zh" route="/" copy={zh.nav} docsOrigin="https://d" />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/")
  })

  it("labels the destination in its own language", () => {
    render(<LanguageSwitcher locale="en" route="/" copy={en.nav} docsOrigin="https://d" />)
    expect(screen.getByText("中文")).toHaveAttribute("lang", "zh-Hans")
  })

  it("declares the destination's language on the link itself", () => {
    render(<LanguageSwitcher locale="en" route="/" copy={en.nav} docsOrigin="https://d" />)
    expect(screen.getByRole("link")).toHaveAttribute("hreflang", "zh-Hans")
  })

  it("carries a nested route across the switch", () => {
    render(
      <LanguageSwitcher
        locale="en"
        route="/use-cases/research"
        copy={en.nav}
        docsOrigin="https://d"
      />
    )
    expect(screen.getByRole("link")).toHaveAttribute("href", "/zh/use-cases/research")
  })
})
