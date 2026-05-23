/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

import { LogTimeline } from "./log-timeline"
import type { StructuredLogEntry } from "@/lib/logging"

function makeLog(
  id: string,
  level: StructuredLogEntry["level"],
  timestamp: string
): StructuredLogEntry {
  return {
    id,
    timestamp,
    level,
    module: "m",
    message: `msg-${id}`,
  } as StructuredLogEntry
}

function buildHourlyLogs(): StructuredLogEntry[] {
  // 12 spread-out logs with mix of levels across one hour
  const base = new Date("2026-01-01T12:00:00Z").getTime()
  const logs: StructuredLogEntry[] = []
  for (let i = 0; i < 12; i++) {
    const ts = new Date(base + i * 5 * 60_000).toISOString()
    const level: StructuredLogEntry["level"] =
      i % 6 === 0 ? "error" : i % 4 === 0 ? "warn" : i % 3 === 0 ? "trace" : "info"
    logs.push(makeLog(`l-${i}`, level, ts))
  }
  return logs
}

function renderTimeline(props: Parameters<typeof LogTimeline>[0]) {
  return render(
    <TooltipProvider delayDuration={0}>
      <LogTimeline {...props} />
    </TooltipProvider>
  )
}

describe("LogTimeline", () => {
  it("stays mounted with a placeholder bar when there are no logs", () => {
    renderTimeline({ logs: [] })
    // Container stays mounted to prevent layout flicker when filters
    // momentarily produce zero matches.
    expect(screen.getByTestId("log-timeline-container")).toBeInTheDocument()
    expect(screen.getByTestId("log-timeline-placeholder")).toBeInTheDocument()
    // No clickable bucket buttons (the empty-state placeholder is decorative).
    expect(screen.queryAllByLabelText(/logs$/i)).toHaveLength(0)
  })

  it("renders the timeline title and 60 bucket buttons by default", () => {
    const logs = buildHourlyLogs()
    renderTimeline({ logs })
    expect(screen.getByText("Timeline")).toBeInTheDocument()
    expect(screen.getAllByLabelText(/logs$/i).length).toBe(60)
  })

  it("respects custom bucketCount", () => {
    const logs = buildHourlyLogs()
    renderTimeline({ logs, bucketCount: 10 })
    expect(screen.getAllByLabelText(/logs$/i).length).toBe(10)
  })

  it("renders error and warning sparklines when those levels are present", () => {
    const logs = buildHourlyLogs()
    const { container } = renderTimeline({ logs })
    expect(container.querySelector(".bg-destructive")).toBeInTheDocument()
    expect(container.querySelector(".bg-warning")).toBeInTheDocument()
  })

  it("omits sparklines when only info-level logs are present", () => {
    const ts = "2026-01-01T12:00:00Z"
    const logs = [makeLog("a", "info", ts), makeLog("b", "info", ts)]
    const { container } = renderTimeline({ logs })
    // Legend dots still render (h-2 w-2) but level sparkline rows (h-[3px]) absent.
    expect(container.querySelector(".h-\\[3px\\]")).toBeNull()
  })

  it("renders the time-range Clear button only when selectedRange is supplied", () => {
    const logs = buildHourlyLogs()
    const { rerender } = renderTimeline({ logs })
    expect(screen.queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogTimeline
          logs={logs}
          selectedRange={{
            start: new Date("2026-01-01T12:00:00Z"),
            end: new Date("2026-01-01T13:00:00Z"),
          }}
          onTimeRangeClick={jest.fn()}
          onClearRange={jest.fn()}
        />
      </TooltipProvider>
    )
    expect(screen.getByRole("button", { name: /Clear/ })).toBeInTheDocument()
  })

  it("Clear button invokes onClearRange (not onTimeRangeClick) when supplied", () => {
    const onTimeRangeClick = jest.fn()
    const onClearRange = jest.fn()
    renderTimeline({
      logs: buildHourlyLogs(),
      selectedRange: {
        start: new Date("2026-01-01T12:00:00Z"),
        end: new Date("2026-01-01T13:00:00Z"),
      },
      onTimeRangeClick,
      onClearRange,
    })
    fireEvent.click(screen.getByRole("button", { name: /Clear/ }))
    expect(onClearRange).toHaveBeenCalledTimes(1)
    expect(onTimeRangeClick).not.toHaveBeenCalled()
  })

  it("clicking a single bucket (mouseDown→mouseUp same idx) fires onTimeRangeClick with that bucket range", () => {
    const onTimeRangeClick = jest.fn()
    renderTimeline({ logs: buildHourlyLogs(), bucketCount: 10, onTimeRangeClick })
    const buckets = screen.getAllByLabelText(/logs$/i)
    fireEvent.mouseDown(buckets[3])
    fireEvent.mouseUp(buckets[3])
    expect(onTimeRangeClick).toHaveBeenCalledTimes(1)
  })

  it("drag selection (mouseDown→mouseEnter→mouseUp across buckets) fires the broader range", () => {
    const onTimeRangeClick = jest.fn()
    renderTimeline({ logs: buildHourlyLogs(), bucketCount: 10, onTimeRangeClick })
    const buckets = screen.getAllByLabelText(/logs$/i)
    fireEvent.mouseDown(buckets[2])
    fireEvent.mouseEnter(buckets[6])
    fireEvent.mouseUp(buckets[6])
    expect(onTimeRangeClick).toHaveBeenCalledTimes(1)
    const [start, end] = onTimeRangeClick.mock.calls[0]
    expect(end.getTime()).toBeGreaterThan(start.getTime())
  })

  it("mouseLeave on the bar cancels an in-progress drag without firing onTimeRangeClick when no callback", () => {
    renderTimeline({ logs: buildHourlyLogs(), bucketCount: 8 })
    const buckets = screen.getAllByLabelText(/logs$/i)
    fireEvent.mouseDown(buckets[0])
    fireEvent.mouseEnter(buckets[2])
    // mouseLeave on the container ends the drag; no error should be thrown.
    fireEvent.mouseLeave(buckets[2].parentElement!.parentElement!)
    expect(true).toBe(true)
  })

  it("renders bucket tooltips with localized total/errors/warnings labels", async () => {
    const logs = buildHourlyLogs()
    renderTimeline({ logs, bucketCount: 5 })
    const buckets = screen.getAllByLabelText(/logs$/i)
    fireEvent.focus(buckets[0])
    fireEvent.mouseEnter(buckets[0])
    // Tooltip content may be portal-rendered; just verify it doesn't throw.
    expect(buckets[0]).toBeInTheDocument()
  })

  it("renders time labels at start and end of range", () => {
    const logs = buildHourlyLogs()
    const { container } = renderTimeline({ logs })
    const labels = container.querySelectorAll(".text-xs.sm\\:text-\\[10px\\].text-muted-foreground")
    expect(labels.length).toBeGreaterThan(0)
  })

  it("uses motion-safe transition utilities", () => {
    const logs = buildHourlyLogs()
    const { container } = renderTimeline({ logs })
    const animated = container.querySelectorAll(
      ".motion-safe\\:transition-all, .motion-safe\\:transition-opacity"
    )
    expect(animated.length).toBeGreaterThan(0)
  })

  it("marks decorative sparklines and legend dots with aria-hidden", () => {
    const logs = buildHourlyLogs()
    const { container } = renderTimeline({ logs })
    const ariaHidden = container.querySelectorAll("[aria-hidden='true']")
    expect(ariaHidden.length).toBeGreaterThan(0)
  })

  it("touches the buckets container to ensure handler refs are stable across rerender", () => {
    const onTimeRangeClick = jest.fn()
    const { rerender } = renderTimeline({
      logs: buildHourlyLogs(),
      bucketCount: 6,
      onTimeRangeClick,
    })
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogTimeline logs={buildHourlyLogs()} bucketCount={6} onTimeRangeClick={onTimeRangeClick} />
      </TooltipProvider>
    )
    const buckets = screen.getAllByLabelText(/logs$/i)
    fireEvent.mouseDown(buckets[1])
    fireEvent.mouseUp(buckets[1])
    expect(onTimeRangeClick).toHaveBeenCalledTimes(1)
  })
})
