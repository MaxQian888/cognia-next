import { render, screen, within } from "@testing-library/react"
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
      const [path, anchor] = item.route.split("#")
      // `/surfaces` is its own page, not a block of this one.
      if (path !== "/product") continue
      expect(container.querySelector(`section#${anchor}`)).toBeInTheDocument()
    }
  })

  it("sets each capability section beside the surface it is about", () => {
    const { container } = render(<ProductPage locale="en" />)
    for (const id of ["chat", "agents", "knowledge", "desktop"]) {
      const section = container.querySelector(`section#${id}`) as HTMLElement
      expect(section.querySelector('[data-slot="capability-figure-row"]')).toBeInTheDocument()
      expect(section.querySelector("figure")).toBeInTheDocument()
    }
    // Everything but the chat capture is a labelled reconstruction.
    for (const id of ["agents", "knowledge", "desktop"]) {
      const section = container.querySelector(`section#${id}`) as HTMLElement
      expect(within(section).getByText(en.reconstruction.label)).toBeInTheDocument()
      expect(
        within(section).getByText(
          en.product.figureCaptions[id as keyof typeof en.product.figureCaptions]
        )
      ).toBeInTheDocument()
    }
  })

  it("leaves the agent interop index to the homepage", () => {
    const { container } = render(<ProductPage locale="en" />)
    expect(container.querySelector('[data-slot="agent-interop"]')).toBeNull()
  })

  it("shows the chat capture once, not a second crop of it for the desktop", () => {
    const { container } = render(<ProductPage locale="en" />)
    const desktop = container.querySelector("section#desktop") as HTMLElement
    expect(desktop.querySelector('[data-reconstruction="frame"]')).toBeInTheDocument()
  })

  it("closes on the subsystem map that used to sit on the homepage", () => {
    const { container } = render(<ProductPage locale="en" />)
    const map = container.querySelector("section#system") as HTMLElement
    expect(
      within(map).getByRole("heading", { name: en.product.panorama.title })
    ).toBeInTheDocument()
    expect(map.querySelectorAll("[data-lane]")).toHaveLength(4)
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

  it("ends on the close band, not on the footer with nowhere to go", () => {
    const { container } = render(<ProductPage locale="en" />)
    const main = container.querySelector("main") ?? container
    const sections = main.querySelectorAll(":scope > section, :scope > * > section")
    const last = sections[sections.length - 1]
    expect(last?.querySelector('[data-slot="page-close"]')).not.toBeNull()
    expect(
      screen.getByRole("heading", { level: 2, name: en.common.pageClose.title })
    ).toBeInTheDocument()
  })
})
