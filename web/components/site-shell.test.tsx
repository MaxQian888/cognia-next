import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { SiteShell } from "./site-shell"

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: jest.fn() }),
}))

describe("SiteShell", () => {
  it("wraps the page in navigation, a main landmark and a footer", () => {
    render(
      <SiteShell locale="en" route="/trust">
        <p>page body</p>
      </SiteShell>
    )
    expect(screen.getByRole("navigation")).toBeInTheDocument()
    expect(screen.getByRole("main")).toBeInTheDocument()
    expect(screen.getByRole("contentinfo")).toBeInTheDocument()
    expect(screen.getByText("page body")).toBeInTheDocument()
  })

  it("gives main the id the skip link targets", () => {
    render(
      <SiteShell locale="en" route="/">
        <p>body</p>
      </SiteShell>
    )
    expect(screen.getByRole("main")).toHaveAttribute("id", "main")
    expect(screen.getByRole("link", { name: en.nav.skipToContent })).toHaveAttribute(
      "href",
      "#main"
    )
  })

  it("clips horizontal paint without creating a sticky-breaking scroll container", () => {
    render(
      <SiteShell locale="en" route="/">
        <p>body</p>
      </SiteShell>
    )
    expect(screen.getByRole("main")).toHaveClass("overflow-x-clip")
    expect(screen.getByRole("main")).not.toHaveClass("overflow-x-hidden")
  })

  it("resolves the download wording once, so the nav and the page agree", () => {
    // The committed evidence snapshot has no release, so both surfaces must
    // show the build-from-source wording rather than one of each.
    render(
      <SiteShell locale="en" route="/">
        <p>body</p>
      </SiteShell>
    )
    expect(
      screen.getAllByRole("link", { name: en.common.download.unavailable }).length
    ).toBeGreaterThan(0)
    expect(screen.queryByRole("link", { name: en.common.download.available })).toBeNull()
  })

  it("passes the current route to the language switcher", () => {
    render(
      <SiteShell locale="en" route="/use-cases/research">
        <p>body</p>
      </SiteShell>
    )
    expect(screen.getAllByRole("link", { name: "中文" })[0]).toHaveAttribute(
      "href",
      "/zh/use-cases/research"
    )
  })

  it("renders the Chinese shell", () => {
    render(
      <SiteShell locale="zh" route="/">
        <p>body</p>
      </SiteShell>
    )
    expect(screen.getAllByRole("link", { name: "English" })[0]).toHaveAttribute("href", "/")
  })
})
