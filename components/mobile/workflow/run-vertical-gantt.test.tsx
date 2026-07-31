/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

afterEach(cleanup)

import { RunVerticalGantt } from "./run-vertical-gantt"
import type { WorkflowRunRow } from "@/types/workflow/visual"

jest.mock("next/link", () => {
  const Link = ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      noRuns: "No runs yet.",
      runsHeader: "Recent runs",
      statusRunning: "Running",
      statusSucceeded: "Succeeded",
      statusFailed: "Failed",
      statusCancelled: "Cancelled",
      statusSkipped: "Skipped",
      statusWaiting: "Waiting",
    }
    return map[key] ?? key
  },
}))

function makeRun(over: Partial<WorkflowRunRow>): WorkflowRunRow {
  return {
    id: over.id ?? "run-1",
    workflowId: over.workflowId ?? "wf-1",
    status: over.status ?? "succeeded",
    triggerKind: "trigger.manual" as never,
    triggerPayload: undefined,
    startedAt: over.startedAt ?? 1_000,
    completedAt: over.completedAt ?? 5_000,
    workflowSnapshot: { id: "wf-1", name: "x", nodes: [], edges: [] } as never,
    error: over.error,
  }
}

describe("<RunVerticalGantt />", () => {
  it("renders empty state", () => {
    render(<RunVerticalGantt runs={[]} />)
    expect(screen.getByTestId("run-vertical-gantt-empty")).toHaveTextContent("No runs yet.")
  })

  it("renders one row per run with status badge + duration", () => {
    // ms = 1500 - 1000 = 500ms (sub-second branch).
    render(<RunVerticalGantt runs={[makeRun({ id: "r1", completedAt: 1_500 })]} />)
    expect(screen.getByTestId("run-row-r1")).toBeInTheDocument()
    expect(screen.getByTestId("run-status-succeeded")).toHaveTextContent("Succeeded")
    expect(screen.getByText("500ms")).toBeInTheDocument()
  })

  it("formats sub-minute durations as fractional seconds", () => {
    render(<RunVerticalGantt runs={[makeRun({ id: "r-sec", startedAt: 0, completedAt: 2_500 })]} />)
    expect(screen.getByText("2.5s")).toBeInTheDocument()
  })

  it("formats minute-scale durations", () => {
    render(<RunVerticalGantt runs={[makeRun({ id: "r2", startedAt: 0, completedAt: 90_000 })]} />)
    expect(screen.getByText("1m 30s")).toBeInTheDocument()
  })

  it("shows the error message for failed runs", () => {
    render(
      <RunVerticalGantt
        runs={[
          makeRun({
            id: "r3",
            status: "failed",
            error: { message: "boom", code: "x" } as never,
          }),
        ]}
      />
    )
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.getByTestId("run-status-failed")).toBeInTheDocument()
  })

  it("shows a cancel affordance on active runs and calls back without navigating", () => {
    const onCancelRun = jest.fn()
    render(
      <RunVerticalGantt
        runs={[
          makeRun({ id: "r-live", status: "running", completedAt: undefined }),
          makeRun({ id: "r-done", status: "succeeded" }),
        ]}
        onCancelRun={onCancelRun}
      />
    )
    // Terminal run gets no cancel button.
    expect(screen.queryByTestId("run-cancel-r-done")).toBeNull()
    fireEvent.click(screen.getByTestId("run-cancel-r-live"))
    expect(onCancelRun).toHaveBeenCalledWith(expect.objectContaining({ id: "r-live" }))
  })

  it("renders no cancel affordance when onCancelRun is absent", () => {
    render(
      <RunVerticalGantt runs={[makeRun({ id: "r-live", status: "running", completedAt: undefined })]} />
    )
    expect(screen.queryByTestId("run-cancel-r-live")).toBeNull()
  })

  it("uses custom hrefForRun when provided", () => {
    render(
      <RunVerticalGantt runs={[makeRun({ id: "r4" })]} hrefForRun={(r) => `/custom/${r.id}`} />
    )
    const link = screen.getByTestId("run-row-r4") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/custom/r4")
  })
})
