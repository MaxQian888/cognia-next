import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { PluginsPage } from "./plugins-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

describe("PluginsPage", () => {
  it("carries the page heading and both sections", () => {
    render(<PluginsPage locale="en" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.plugins.header.title })
    ).toBeInTheDocument()
    for (const section of en.plugins.sections) {
      expect(screen.getByRole("heading", { name: section.title })).toBeInTheDocument()
    }
  })

  it("closes on authoring steps rather than a plugin count", () => {
    render(<PluginsPage locale="en" />)
    expect(screen.getByRole("heading", { name: en.plugins.authoring.title })).toBeInTheDocument()
    for (const step of en.plugins.authoring.steps) {
      expect(screen.getByText(step)).toBeInTheDocument()
    }
  })

  it("shows how an extension becomes an installable Cognia plugin", () => {
    render(<PluginsPage locale="en" />)
    expect(
      screen.getByRole("heading", { name: "From existing capability to installed extension." })
    ).toBeInTheDocument()
    for (const title of [
      "Bring the source",
      "Declare the contract",
      "Contribute surfaces",
      "Package and install",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument()
    }
  })

  it("numbers the authoring steps as an ordered list", () => {
    const { container } = render(<PluginsPage locale="en" />)
    const lists = [...container.querySelectorAll("ol")]
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.at(-1)?.querySelectorAll("li")).toHaveLength(en.plugins.authoring.steps.length)
  })

  it("localises", () => {
    render(<PluginsPage locale="zh" />)
    expect(screen.getByRole("heading", { name: zh.plugins.authoring.title })).toBeInTheDocument()
  })

  it("states what each connection reads, can do and must ask", () => {
    const { container } = render(<PluginsPage locale="en" />)
    const section = container.querySelector("section#connections") as HTMLElement
    expect(section).toBeInTheDocument()
    for (const item of en.plugins.connections.items) {
      expect(section).toHaveTextContent(item.name)
    }
    expect(screen.getByRole("group", { name: en.plugins.connectionFlow.label })).toBeInTheDocument()
  })

  it("ends on the close band, not on the footer with nowhere to go", () => {
    const { container } = render(<PluginsPage locale="en" />)
    const main = container.querySelector("main") ?? container
    const sections = main.querySelectorAll(":scope > section, :scope > * > section")
    const last = sections[sections.length - 1]
    expect(last?.querySelector('[data-slot="page-close"]')).not.toBeNull()
    expect(
      screen.getByRole("heading", { level: 2, name: en.common.pageClose.title })
    ).toBeInTheDocument()
  })
})
