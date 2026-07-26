import { render, screen } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { DesktopReconstruction } from "./desktop-reconstruction"

const desktop = en.reconstruction.desktop

describe("DesktopReconstruction", () => {
  it("carries the reconstruction marker", () => {
    render(<DesktopReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("shows the command palette with its query and results", () => {
    render(<DesktopReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(desktop.paletteLabel)).toBeInTheDocument()
    expect(screen.getByText(desktop.paletteQuery)).toBeInTheDocument()
    for (const item of desktop.paletteItems) {
      expect(screen.getByText(item)).toBeInTheDocument()
    }
  })

  it("depicts the palette without a focusable input that cannot be used", () => {
    render(<DesktopReconstruction copy={en.reconstruction} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("shows the integrated terminal running the project's real command", () => {
    render(<DesktopReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(desktop.terminalLabel)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.test.command)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.check)).toBeInTheDocument()
  })

  it("shows the notification a long task uses to come back for the human", () => {
    render(<DesktopReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(desktop.notificationTitle)).toBeInTheDocument()
    expect(screen.getByText(desktop.notificationBody)).toBeInTheDocument()
  })

  it("puts the terminal on the graphite execution substrate", () => {
    const { container } = render(<DesktopReconstruction copy={en.reconstruction} />)
    expect(container.querySelector(".bg-graphite")).toBeInTheDocument()
  })

  it("localises every label", () => {
    render(<DesktopReconstruction copy={zh.reconstruction} />)
    expect(screen.getByText(zh.reconstruction.desktop.paletteLabel)).toBeInTheDocument()
    expect(screen.getByText(zh.reconstruction.desktop.notificationTitle)).toBeInTheDocument()
  })

  it("passes a layout class through", () => {
    const { container } = render(
      <DesktopReconstruction copy={en.reconstruction} className="my-class" />
    )
    expect(container.querySelector(".my-class")).toBeInTheDocument()
  })
})
