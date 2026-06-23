/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("./eval-dashboard", () => ({ EvalDashboard: () => <div>DASHBOARD</div> }))
jest.mock("./runs-compare-panel", () => ({ RunsComparePanel: () => <div>COMPARE</div> }))
jest.mock("./trace-annotation-panel", () => ({ TraceAnnotationPanel: () => <div>ANNOTATE</div> }))
jest.mock("./calibration-panel", () => ({ CalibrationPanel: () => <div>CALIBRATE</div> }))

import { EvalWorkspace } from "./eval-workspace"

describe("EvalWorkspace", () => {
  it("shows the dashboard by default", () => {
    render(<EvalWorkspace />)
    expect(screen.getByText("DASHBOARD")).toBeInTheDocument()
    expect(screen.queryByText("ANNOTATE")).not.toBeInTheDocument()
  })

  it("switches to the runs & compare panel", () => {
    render(<EvalWorkspace />)
    fireEvent.click(screen.getByText("tabs.compare"))
    expect(screen.getByText("COMPARE")).toBeInTheDocument()
    expect(screen.queryByText("DASHBOARD")).not.toBeInTheDocument()
  })

  it("switches to the trace-analysis panel", () => {
    render(<EvalWorkspace />)
    fireEvent.click(screen.getByText("tabs.annotate"))
    expect(screen.getByText("ANNOTATE")).toBeInTheDocument()
    expect(screen.queryByText("DASHBOARD")).not.toBeInTheDocument()
  })

  it("switches to the calibration panel", () => {
    render(<EvalWorkspace />)
    fireEvent.click(screen.getByText("tabs.calibrate"))
    expect(screen.getByText("CALIBRATE")).toBeInTheDocument()
    expect(screen.queryByText("DASHBOARD")).not.toBeInTheDocument()
  })

  it("switches back to datasets", () => {
    render(<EvalWorkspace />)
    fireEvent.click(screen.getByText("tabs.annotate"))
    fireEvent.click(screen.getByText("tabs.datasets"))
    expect(screen.getByText("DASHBOARD")).toBeInTheDocument()
  })

  it("frosts the tab bar so it reads over a wallpaper", () => {
    render(<EvalWorkspace />)
    // The segmented tab strip is the header that sits over the wallpaper — it
    // must carry the same translucent + blur treatment as the shared
    // feature-shell toolbar so it stays legible against an image background.
    const header = screen.getByText("tabs.datasets").closest("div")
    expect(header).toHaveClass("bg-background/80", "backdrop-blur")
  })
})
