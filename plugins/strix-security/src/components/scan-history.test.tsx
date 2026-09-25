/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { ScanHistory, formatDuration } from "./scan-history"
import type { StrixRun } from "../types"
import { en, registerStrixBundle, unregisterStrixBundle } from "../i18n.test-helpers"

beforeEach(() => registerStrixBundle())
afterEach(() => unregisterStrixBundle())

const run = (over: Partial<StrixRun> = {}): StrixRun => ({
  runId: "r1",
  target: "https://x",
  startedAt: 1_700_000_000_000,
  status: "done",
  findingsCount: 3,
  authorizedAt: 1_700_000_000_000,
  ...over,
})

describe("formatDuration", () => {
  it("formats sub-minute, minute and hour durations", () => {
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(134_000)).toBe("2m 14s")
    expect(formatDuration(3_725_000)).toBe("1h 02m")
  })
})

/** Stands in for `ctx.i18n.formatDate`; records what it was asked to format. */
const formatDate = jest.fn((date: Date) => `at:${date.toISOString()}`)

describe("ScanHistory", () => {
  it("shows the empty state", () => {
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[]}
        onView={() => {}}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    expect(screen.getByTestId("strix-history-empty")).toBeInTheDocument()
  })

  it("renders rows and fires the row + clear callbacks", () => {
    const onView = jest.fn()
    const onDelete = jest.fn()
    const onClearAll = jest.fn()
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[run()]}
        onView={onView}
        onDelete={onDelete}
        onClearAll={onClearAll}
      />
    )
    expect(screen.getByTestId("strix-history-row")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("strix-clear-all"))
    expect(onClearAll).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId("strix-history-delete"))
    expect(onDelete).toHaveBeenCalledWith("r1")

    fireEvent.click(screen.getByTestId("strix-history-open"))
    expect(onView).toHaveBeenCalledWith("r1")
  })

  it("opens a run by clicking its target", () => {
    const onView = jest.fn()
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[run()]}
        onView={onView}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    fireEvent.click(screen.getByTestId("strix-history-target"))
    expect(onView).toHaveBeenCalledWith("r1")
  })

  it("shows when each scan started and how long it took", () => {
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[run({ startedAt: 1_700_000_000_000, endedAt: 1_700_000_134_000 })]}
        onView={() => {}}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    const row = screen.getByTestId("strix-history-row")
    expect(row).toHaveTextContent("2m 14s")
    expect(row).toHaveTextContent("3 findings")
    // The start time comes from the app-locale formatter, not toLocaleString.
    expect(row).toHaveTextContent(`at:${new Date(1_700_000_000_000).toISOString()}`)
    expect(formatDate).toHaveBeenCalledWith(
      new Date(1_700_000_000_000),
      expect.objectContaining({ month: "short" })
    )
  })

  it("translates a stored error code in the row", () => {
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[
          run({
            status: "error",
            error: "English detail",
            errorCode: "setupFailed",
            errorParams: { exit: 2 },
          }),
        ]}
        onView={() => {}}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    const error = screen.getByTestId("strix-history-error")
    expect(error).toHaveTextContent(en("run.error.setupFailed", { exit: 2 }))
    expect(error).not.toHaveTextContent("English detail")
  })

  it("keeps row actions at least 36px tall on narrow screens", () => {
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[run()]}
        onView={() => {}}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    expect(screen.getByTestId("strix-history-open").className).toMatch(/(^|\s)h-9(\s|$)/)
    expect(screen.getByTestId("strix-history-delete").className).toMatch(/(^|\s)size-9(\s|$)/)
    expect(screen.getByTestId("strix-clear-all").className).toMatch(/(^|\s)h-9(\s|$)/)
  })

  it("colors status badges by outcome", () => {
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[
          run({ runId: "a", status: "done" }),
          run({ runId: "b", status: "error", error: "boom" }),
          run({ runId: "c", status: "running" }),
        ]}
        onView={() => {}}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    const badges = screen.getAllByTestId("strix-history-status")
    expect(badges[0]).toHaveTextContent("Done")
    expect(badges[1]).toHaveTextContent("Error")
    expect(badges[2]).toHaveTextContent("Running")
    expect(screen.getByTestId("strix-history-error")).toHaveTextContent("boom")
  })

  it("refuses to delete a scan that is still running", () => {
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[run({ status: "running" })]}
        onView={() => {}}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    expect(screen.getByTestId("strix-history-delete")).toBeDisabled()
  })

  it("marks the row opened in the scan tab", () => {
    render(
      <ScanHistory
        formatDate={formatDate}
        runs={[run({ runId: "a" }), run({ runId: "b" })]}
        selectedRunId="b"
        onView={() => {}}
        onDelete={() => {}}
        onClearAll={() => {}}
      />
    )
    const rows = screen.getAllByTestId("strix-history-row")
    expect(rows[0]).not.toHaveAttribute("data-selected")
    expect(rows[1]).toHaveAttribute("data-selected", "true")
  })
})
