/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("./eval-dashboard", () => ({ EvalDashboard: () => <div>DASHBOARD</div> }))
jest.mock("./runs-compare-panel", () => ({ RunsComparePanel: () => <div>COMPARE</div> }))
jest.mock("./trace-annotation-panel", () => ({ TraceAnnotationPanel: () => <div>ANNOTATE</div> }))
jest.mock("./calibration-panel", () => ({ CalibrationPanel: () => <div>CALIBRATE</div> }))

import { EvalWorkspace } from "./eval-workspace"
import { useEvalRunStore } from "@/stores/eval/eval-run-store"

afterEach(() => useEvalRunStore.setState({ active: null, controller: null }))

describe("EvalWorkspace", () => {
  beforeEach(() => push.mockClear())

  it("deep-links to the eval settings section", () => {
    render(<EvalWorkspace />)
    fireEvent.click(screen.getByLabelText("settings.title"))
    expect(push).toHaveBeenCalledWith("/settings?section=eval")
  })

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

  it("frosts the shared feature header so it reads over a wallpaper", () => {
    render(<EvalWorkspace />)
    const header = screen.getByRole("banner")
    expect(header).toHaveClass("bg-background/88", "backdrop-blur-xl")
    expect(header).toContainElement(screen.getByText("tabs.datasets"))
  })

  describe("run bar", () => {
    it("stays hidden with nothing running", () => {
      render(<EvalWorkspace />)
      expect(screen.queryByTestId("eval-run-bar")).not.toBeInTheDocument()
    })

    it("shows an in-flight run from any tab and can cancel it there", () => {
      // Progress used to live inside the run dialog, so switching tabs hid a
      // run that was still spending tokens.
      const controller = new AbortController()
      useEvalRunStore.getState().start({ datasetId: "d1", label: "opus", controller })
      render(<EvalWorkspace />)
      fireEvent.click(screen.getByText("tabs.calibrate"))
      const bar = screen.getByTestId("eval-run-bar")
      expect(bar).toHaveTextContent("runBar.label")
      // No progress tick yet — cancel must still be available.
      expect(bar).toHaveTextContent("runConfig.starting")
      fireEvent.click(screen.getByText("runConfig.cancelRun"))
      expect(controller.signal.aborted).toBe(true)
    })

    it("reports progress and disables cancel once cancelling", () => {
      useEvalRunStore.getState().start({
        datasetId: "d1",
        label: "opus",
        controller: new AbortController(),
      })
      useEvalRunStore.getState().updateProgress({ done: 4, total: 10, passing: 3, ungraded: 1 })
      const { rerender } = render(<EvalWorkspace />)
      expect(screen.getByTestId("eval-run-bar")).toHaveTextContent("4/10")
      act(() => useEvalRunStore.getState().cancel())
      rerender(<EvalWorkspace />)
      expect(screen.getByText("runConfig.cancelRun")).toBeDisabled()
    })
  })
})
