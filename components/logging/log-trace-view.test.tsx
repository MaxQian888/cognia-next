/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@cognia/agent-trace/log-adapter", () => ({
  AGENT_TRACE_MODULE: "agent.trace",
}))

import { LogTraceView, formatTraceDuration } from "./log-trace-view"
import type { StructuredLogEntry } from "@cognia/logging"

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

  it("pages through more than 50 traces with Show more", () => {
    const logs: StructuredLogEntry[] = Array.from({ length: 105 }, (_, i) =>
      makeLog({
        id: `l-${i}`,
        traceId: `trace-${String(i).padStart(8, "0")}`,
        timestamp: new Date(2026, 0, 1, 12, i).toISOString(),
      })
    )
    render(<LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} />)
    expect(screen.getAllByTestId(/^log-trace-row-/)).toHaveLength(50)
    expect(screen.getByTestId("log-trace-view-overflow")).toHaveTextContent(
      'panel.traceOverflow:{"count":55}'
    )
    const more = screen.getByTestId("log-trace-view-show-more")
    expect(more).toBeEnabled()
    fireEvent.click(more)
    expect(screen.getAllByTestId(/^log-trace-row-/)).toHaveLength(100)
    fireEvent.click(screen.getByTestId("log-trace-view-show-more"))
    expect(screen.getAllByTestId(/^log-trace-row-/)).toHaveLength(105)
    expect(screen.queryByTestId("log-trace-view-show-more")).not.toBeInTheDocument()
  })

  it("offers Open in Traces only on traces with agent spans, and only with a host handler", () => {
    const onOpenTrace = jest.fn()
    const logs = [
      makeLog({ id: "a", traceId: "t-agent", module: "agent.trace" }),
      makeLog({ id: "b", traceId: "t-agent", module: "chat" }),
      makeLog({ id: "c", traceId: "t-plain", module: "chat" }),
    ]
    const { rerender } = render(
      <LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} onOpenTrace={onOpenTrace} />
    )
    expect(screen.queryByTestId("log-trace-open-t-plain")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("log-trace-open-t-agent"))
    expect(onOpenTrace).toHaveBeenCalledWith("t-agent")

    rerender(<LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} />)
    expect(screen.queryByTestId("log-trace-open-t-agent")).not.toBeInTheDocument()
  })

  it("names each row with its id, size and duration instead of an English svg label", () => {
    const logs = [makeLog({ id: "a", traceId: "t-1" })]
    render(<LogTraceView filteredLogs={logs} onSelectTrace={jest.fn()} />)
    const row = screen.getByTestId("log-trace-row-t-1")
    expect(row.getAttribute("aria-label")).toContain("panel.traceRowAria")
    expect(row.querySelector("svg[aria-hidden]")).not.toBeNull()
    expect(row.querySelector("svg[role='img']")).toBeNull()
  })
})

describe("formatTraceDuration", () => {
  const t = ((key: string, vars?: Record<string, unknown>) =>
    `${key}:${JSON.stringify(vars)}`) as unknown as Parameters<typeof formatTraceDuration>[1]

  it("picks the unit from the message bundle", () => {
    expect(formatTraceDuration(850, t)).toBe('panel.durationUnits.ms:{"value":850}')
    expect(formatTraceDuration(1_250, t)).toBe('panel.durationUnits.s:{"value":"1.3"}')
    expect(formatTraceDuration(120_000, t)).toBe('panel.durationUnits.m:{"value":2}')
    expect(formatTraceDuration(7_200_000, t)).toBe('panel.durationUnits.h:{"value":2}')
  })
})
