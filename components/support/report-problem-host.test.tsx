/** @jest-environment jsdom */

jest.mock("./report-problem-dialog", () => ({
  ReportProblemDialog: ({
    context,
    open,
    onOpenChange,
  }: {
    context: { surface: string; sessionId?: string }
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => (
    <button
      data-testid="report-dialog"
      data-open={String(open)}
      data-surface={context.surface}
      data-session={context.sessionId}
      onClick={() => onOpenChange(false)}
    >
      close
    </button>
  ),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"

import { useUIStore } from "@/stores/ui"

import { ReportProblemHost } from "./report-problem-host"

beforeEach(() => {
  act(() => useUIStore.getState().clearPendingReport())
})

it("renders nothing until a report is requested, then opens the dialog for that context", () => {
  render(<ReportProblemHost />)
  expect(screen.queryByTestId("report-dialog")).toBeNull()

  act(() => useUIStore.getState().requestReportProblem({ surface: "chat", sessionId: "s1" }))
  const dialog = screen.getByTestId("report-dialog")
  expect(dialog).toHaveAttribute("data-open", "true")
  expect(dialog).toHaveAttribute("data-surface", "chat")
  expect(dialog).toHaveAttribute("data-session", "s1")
})

it("clears the request when the dialog closes", () => {
  render(<ReportProblemHost />)
  act(() => useUIStore.getState().requestReportProblem({ surface: "tray" }))
  fireEvent.click(screen.getByTestId("report-dialog"))
  expect(useUIStore.getState().pendingReportRequest).toBeNull()
  expect(screen.queryByTestId("report-dialog")).toBeNull()
})
