/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { LogTraceView } from "./log-trace-view"
import type { StructuredLogEntry } from "@/lib/logging"

function makeLog(overrides: Partial<StructuredLogEntry>): StructuredLogEntry {
  return {
    id: overrides.id ?? "id",
    timestamp: overrides.timestamp ?? new Date("2026-01-01T12:00:00Z").toISOString(),
    level: overrides.level ?? "info",
    message: overrides.message ?? "m",
    module: overrides.module ?? "mod",
    ...overrides,
  } as StructuredLogEntry
}

describe("LogTraceView", () => {
  it("renders one row per traceId, sorted by recency", () => {
    const logs = [
      makeLog({ id: "a", traceId: "trace-old-aaaaaaaa", timestamp: "2026-01-01T00:00:00Z" }),
      makeLog({ id: "b", traceId: "trace-new-bbbbbbbb", timestamp: "2026-01-01T05:00:00Z" }),
      makeLog({ id: "c", traceId: "trace-new-bbbbbbbb", timestamp: "2026-01-01T05:01:00Z" }),
    ]
    render(<LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} />)
    const rows = screen.getAllByTestId(/^log-trace-row-/)
    expect(rows).toHaveLength(2)
    // newest first
    expect(rows[0]).toHaveAttribute("data-testid", "log-trace-row-trace-new-bbbbbbbb")
  })

  it("renders empty state with hint when no logs carry traceId", () => {
    const logs = [makeLog({ id: "a" }), makeLog({ id: "b" })]
    render(<LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} />)
    expect(screen.getByTestId("log-trace-view-empty")).toBeInTheDocument()
    expect(screen.getByText("panel.noTraceEventsHint")).toBeInTheDocument()
  })

  it("invokes onSelectTrace with the row's traceId when clicked", () => {
    const handler = jest.fn()
    const logs = [makeLog({ id: "a", traceId: "trace-aaaaaaaa-bb" })]
    render(<LogTraceView filteredLogs={logs} onSelectTrace={handler} />)
    fireEvent.click(screen.getByTestId("log-trace-row-trace-aaaaaaaa-bb"))
    expect(handler).toHaveBeenCalledWith("trace-aaaaaaaa-bb")
  })

  it("surfaces error/warn badges when present", () => {
    const logs = [
      makeLog({ id: "a", traceId: "t-1234567890", level: "error" }),
      makeLog({ id: "b", traceId: "t-1234567890", level: "warn" }),
    ]
    render(<LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} />)
    const row = screen.getByTestId("log-trace-row-t-1234567890")
    expect(row).toHaveTextContent("levels.error")
    expect(row).toHaveTextContent("levels.warn")
  })

  it("displays an overflow notice when more than 50 traces exist", () => {
    const logs: StructuredLogEntry[] = Array.from({ length: 55 }, (_, i) =>
      makeLog({
        id: `l-${i}`,
        traceId: `trace-${String(i).padStart(8, "0")}`,
        timestamp: new Date(2026, 0, 1, 12, i).toISOString(),
      })
    )
    render(<LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} />)
    expect(screen.getByTestId("log-trace-view-overflow")).toHaveTextContent(
      'panel.traceOverflow:{"count":5}'
    )
  })
})
