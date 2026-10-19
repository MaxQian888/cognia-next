import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { DesktopSection } from "./desktop-section"

jest.mock("motion/react", () => ({
  useReducedMotion: () => true,
  useInView: () => true,
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
}))

describe("DesktopSection", () => {
  it("renders the heading and the reason to install", () => {
    render(<DesktopSection copy={en.home.desktop} locale="en" />)
    expect(screen.getByRole("heading", { name: en.home.desktop.title })).toBeInTheDocument()
    expect(screen.getByText(en.home.desktop.subtitle)).toBeInTheDocument()
  })

  it("lists every desktop capability", () => {
    render(<DesktopSection copy={en.home.desktop} locale="en" />)
    for (const capability of en.home.desktop.capabilities) {
      expect(screen.getByText(capability.label)).toBeInTheDocument()
      expect(screen.getByText(capability.body)).toBeInTheDocument()
    }
  })

  it("shows a described crop of the real shell", () => {
    render(<DesktopSection copy={en.home.desktop} locale="en" />)
    // A captured shell renders a light and a dark screenshot under one description;
    // without a capture the reconstruction carries it once. Either way it is described.
    const images = screen.getAllByRole("img", { name: en.home.desktop.stageAlt })
    expect(images.length).toBeGreaterThanOrEqual(1)
    expect(images.length).toBeLessThanOrEqual(2)
  })

  it("adds the controllable terminal as a flat desktop band", () => {
    render(<DesktopSection copy={en.home.desktop} terminalCopy={en.home.terminal} locale="en" />)
    expect(screen.getByRole("region", { name: en.home.terminal.title })).toBeInTheDocument()
    expect(screen.getByText(en.home.terminal.completeLabel)).toBeInTheDocument()
  })

  it("localises the capability list", () => {
    render(<DesktopSection copy={zh.home.desktop} locale="zh" />)
    for (const capability of zh.home.desktop.capabilities) {
      expect(screen.getByText(capability.label)).toBeInTheDocument()
    }
  })

  it("closes on a strip of the other surfaces, each linking to its block on /surfaces", () => {
    const stations = en.surfaces.entryPoints.stations
    const { container } = render(
      <DesktopSection copy={en.home.desktop} locale="en" stations={stations} />
    )
    const strip = container.querySelector('[data-slot="surfaces-strip"]') as HTMLElement
    expect(within(strip).getByRole("link", { name: /See every surface/ })).toHaveAttribute(
      "href",
      "/surfaces"
    )
    // The desktop is this section; the strip lists only the others.
    const others = stations.filter((station) => station.key !== "desktop")
    expect(within(strip).getAllByRole("listitem")).toHaveLength(others.length)
    for (const station of others) {
      const link = within(strip).getByRole("link", { name: new RegExp(station.name) })
      expect(link).toHaveAttribute("href", `/surfaces#${station.key}`)
      expect(link).toHaveTextContent(station.role)
    }
  })

  it("renders no strip when it is given no stations", () => {
    const { container } = render(<DesktopSection copy={en.home.desktop} locale="en" />)
    expect(container.querySelector('[data-slot="surfaces-strip"]')).toBeNull()
  })

  it("puts the terminal on stage colours so its pass and fail lines stay legible", () => {
    render(<DesktopSection copy={en.home.desktop} terminalCopy={en.home.terminal} locale="en" />)
    const region = screen.getByRole("region", { name: en.home.terminal.title })
    expect(region.closest(".stage-scope")).not.toBeNull()
  })

  it("frames the terminal once: the graphite band, not a bordered box inset in it", () => {
    const { container } = render(
      <DesktopSection copy={en.home.desktop} terminalCopy={en.home.terminal} locale="en" />
    )
    const band = container.querySelector('[data-slot="desktop-terminal-band"]') as HTMLElement
    expect(band).not.toHaveClass("py-6")
    const terminal = band.querySelector(".bg-graphite")
    expect(terminal).toHaveClass("border-0", "md:border-0")
  })
})
