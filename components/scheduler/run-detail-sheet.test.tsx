/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub Sheet primitives to render inline so we can assert on contents.
jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children, ...rest }: { children: React.ReactNode }) => (
    <h2 {...rest}>{children}</h2>
  ),
}))

jest.mock("@/components/workflow/runs/run-status-pill", () => ({
  RunStatusPill: ({ status }: { status: string }) => <span data-testid="stub-pill">{status}</span>,
}))

import { RunDetailSheet } from "./run-detail-sheet"

function makeRun(overrides: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  return {
    unifiedId: "app:run-1",
    kind: "app",
    itemUnifiedId: "app:task-1",
    itemName: "Daily summary",
    status: "succeeded",
    startedAt: Date.parse("2026-05-10T09:00:00Z"),
    finishedAt: Date.parse("2026-05-10T09:00:05Z"),
    durationMs: 5_000,
    payload: { prompt: "hi" },
    result: { reply: "ok" },
    logs: [
      { ts: Date.parse("2026-05-10T09:00:01Z"), level: "info", message: "started" },
      { ts: Date.parse("2026-05-10T09:00:02Z"), level: "warn", message: "noted" },
    ],
    origin: { tableName: "schedulerDb.executions", nativeId: "run-1" },
    ...overrides,
  }
}

describe("RunDetailSheet", () => {
  it("renders nothing when run is null", () => {
    const { container } = render(<RunDetailSheet open={true} onOpenChange={() => {}} run={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when open is false", () => {
    const { container } = render(
      <RunDetailSheet open={false} onOpenChange={() => {}} run={makeRun()} />
    )
    expect(container.querySelector("[role='dialog']")).toBeNull()
  })

  it("renders the item name, status pill, payload, result, and timing rows for a successful run", () => {
    render(<RunDetailSheet open={true} onOpenChange={() => {}} run={makeRun()} />)
    expect(screen.getByTestId("run-sheet-title")).toHaveTextContent("Daily summary")
    expect(screen.getByTestId("stub-pill")).toHaveTextContent("succeeded")
    expect(screen.getByTestId("run-sheet-payload")).toHaveTextContent("prompt")
    expect(screen.getByTestId("run-sheet-result")).toHaveTextContent("reply")
  })

  it("hides the result block and shows the error block when the run failed", () => {
    render(
      <RunDetailSheet
        open={true}
        onOpenChange={() => {}}
        run={makeRun({
          status: "failed",
          result: undefined,
          error: { message: "boom", code: "timeout" },
        })}
      />
    )
    expect(screen.queryByTestId("run-sheet-result")).toBeNull()
    const err = screen.getByTestId("run-sheet-error")
    expect(err).toHaveTextContent("boom")
    expect(err).toHaveTextContent("timeout")
  })

  it("logs are collapsed by default and reveal when the toggle is clicked", () => {
    render(<RunDetailSheet open={true} onOpenChange={() => {}} run={makeRun()} />)
    expect(screen.queryByTestId("run-sheet-logs")).toBeNull()
    fireEvent.click(screen.getByTestId("run-sheet-logs-toggle"))
    expect(screen.getByTestId("run-sheet-logs")).toBeInTheDocument()
  })

  it("hides the logs section entirely when the run has no logs", () => {
    render(
      <RunDetailSheet open={true} onOpenChange={() => {}} run={makeRun({ logs: undefined })} />
    )
    expect(screen.queryByTestId("run-sheet-logs-toggle")).toBeNull()
  })

  it("close button fires onOpenChange(false)", () => {
    const onOpenChange = jest.fn()
    render(<RunDetailSheet open={true} onOpenChange={onOpenChange} run={makeRun()} />)
    const closeBtn = screen.getByRole("button", { name: /close/i })
    fireEvent.click(closeBtn)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
