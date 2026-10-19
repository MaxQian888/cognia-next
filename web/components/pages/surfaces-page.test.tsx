import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { SurfacesPage } from "./surfaces-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

describe("SurfacesPage", () => {
  it("carries the page heading and opens on the station rail", () => {
    const { container } = render(<SurfacesPage locale="en" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.surfaces.header.title })
    ).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: en.surfaces.entryPoints.title })).toBeInTheDocument()
    expect(container.querySelector('[data-slot="handoff"]')).toBeInTheDocument()
  })

  it("gives every station its own block, anchored by its key", () => {
    const { container } = render(<SurfacesPage locale="en" />)
    for (const station of en.surfaces.entryPoints.stations) {
      const block = container.querySelector(`section#${station.key}`) as HTMLElement
      expect(block).toBeInTheDocument()
      const section = en.surfaces.sections.find((s) => s.id === station.key)!
      expect(within(block).getByRole("heading", { name: section.title })).toBeInTheDocument()
      for (const entry of section.entries) {
        expect(within(block).getByText(entry.name)).toBeInTheDocument()
      }
    }
  })

  it("does not number its sections the way the homepage does", () => {
    const { container } = render(<SurfacesPage locale="en" />)
    expect(container.querySelector('[data-slot="section-index"]')).toBeNull()
  })

  it("starts the station blocks on the other tone, so two paper sections never meet", () => {
    const { container } = render(<SurfacesPage locale="en" />)
    expect(container.querySelector("section#desktop")).toHaveClass("bg-surface")
    expect(container.querySelector("section#entries")).toHaveClass("bg-paper")
  })

  it("closes on the lifecycle every surface shares", () => {
    render(<SurfacesPage locale="en" />)
    expect(screen.getByRole("heading", { name: en.surfaces.flow.title })).toBeInTheDocument()
    for (const step of en.surfaces.flow.steps) {
      expect(screen.getByRole("heading", { name: step.label })).toBeInTheDocument()
    }
  })

  it("localises", () => {
    render(<SurfacesPage locale="zh" />)
    expect(
      screen.getByRole("heading", { level: 1, name: zh.surfaces.header.title })
    ).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: zh.surfaces.flow.title })).toBeInTheDocument()
  })

  it("ends on the close band, not on the footer with nowhere to go", () => {
    const { container } = render(<SurfacesPage locale="en" />)
    const main = container.querySelector("main") ?? container
    const sections = main.querySelectorAll(":scope > section, :scope > * > section")
    const last = sections[sections.length - 1]
    expect(last?.querySelector('[data-slot="page-close"]')).not.toBeNull()
    expect(
      screen.getByRole("heading", { level: 2, name: en.common.pageClose.title })
    ).toBeInTheDocument()
  })
})
