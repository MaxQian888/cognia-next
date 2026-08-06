import { render, screen } from "@testing-library/react"
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
    expect(screen.getByRole("img", { name: en.home.desktop.stageAlt })).toBeInTheDocument()
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
})
