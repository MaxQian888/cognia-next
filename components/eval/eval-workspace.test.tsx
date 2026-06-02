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

  it("switches back to datasets", () => {
    render(<EvalWorkspace />)
    fireEvent.click(screen.getByText("tabs.annotate"))
    fireEvent.click(screen.getByText("tabs.datasets"))
    expect(screen.getByText("DASHBOARD")).toBeInTheDocument()
  })
})
