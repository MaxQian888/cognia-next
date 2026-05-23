/**
 * @jest-environment jsdom
 */

import React, { createRef } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { useTranslations } from "next-intl"

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getScrollElement,
  }: {
    count: number
    estimateSize: () => number
    getScrollElement: () => HTMLElement | null
  }) => {
    // Invoke the inline arrow callbacks so they register coverage.
    estimateSize?.()
    getScrollElement?.()
    const items = Array.from({ length: Math.min(count, 5) }, (_, i) => ({
      index: i,
      start: i * 44,
      size: 44,
      end: (i + 1) * 44,
      key: i,
      lane: 0,
    }))
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * 44,
      measureElement: jest.fn(),
    }
  },
}))

jest.mock("./log-entry", () => ({
  MemoizedLogEntry: ({ log }: { log: { id: string; message: string } }) => (
    <div data-testid={`memoized-log-${log.id}`}>{log.message}</div>
  ),
  TraceGroup: ({ traceId, logs }: { traceId: string; logs: Array<{ id: string }> }) => (
    <div data-testid={`trace-group-${traceId}`}>{logs.length} logs</div>
  ),
}))

import { VirtualizedLogList } from "./log-virtualized-list"
import type { StructuredLogEntry } from "@/lib/logging"

function makeLog(id: string, overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id,
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    level: "info",
    module: "test",
    source: "frontend",
    message: `log-${id}`,
    ...overrides,
  } as StructuredLogEntry
}

function Harness(props: {
  isLoading?: boolean
  error?: Error | null
  filteredLogs?: StructuredLogEntry[]
  groupByTraceId?: boolean
  groupedLogs?: Map<string, StructuredLogEntry[]>
  emptyContext?: {
    activeFilterLabels: string[]
    onClearFilters?: () => void
    onOpenPresets?: () => void
  }
  onRetry?: () => void
  bookmarkedIds?: Set<string>
}) {
  const t = useTranslations("logging")
  const scrollRef = createRef<HTMLDivElement>()
  const containerRef = createRef<HTMLDivElement>()
  return (
    <VirtualizedLogList
      scrollRef={scrollRef}
      containerRef={containerRef}
      isLoading={props.isLoading ?? false}
      error={props.error ?? null}
      filteredLogs={props.filteredLogs ?? []}
      groupByTraceId={props.groupByTraceId ?? false}
      groupedLogs={props.groupedLogs ?? new Map()}
      expandedIds={new Set()}
      toggleExpanded={jest.fn()}
      searchQuery=""
      useRegex={false}
      bookmarkedIds={props.bookmarkedIds ?? new Set()}
      toggleBookmark={jest.fn()}
      handleSelectLog={jest.fn()}
      handleFocusTrace={jest.fn()}
      handleFocusSession={jest.fn()}
      t={t}
      onRetry={props.onRetry}
      emptyStateContext={props.emptyContext}
    />
  )
}

describe("VirtualizedLogList", () => {
  describe("loading state", () => {
    it("renders 8 skeleton rows while isLoading and no logs", () => {
      render(<Harness isLoading />)
      const skeletons = screen.getAllByTestId("log-virtualized-list-skeleton-row")
      expect(skeletons).toHaveLength(8)
      expect(screen.getByTestId("log-virtualized-list-loading")).toHaveAttribute(
        "aria-busy",
        "true"
      )
    })

    it("uses motion-safe animate-pulse on skeleton bars", () => {
      const { container } = render(<Harness isLoading />)
      const animated = container.querySelectorAll(".motion-safe\\:animate-pulse")
      expect(animated.length).toBeGreaterThan(0)
    })
  })

  describe("error state", () => {
    it("renders Alert with localized title", () => {
      render(<Harness error={new Error("boom")} />)
      expect(screen.getByText("Failed to load logs")).toBeInTheDocument()
      expect(screen.getByRole("alert")).toBeInTheDocument()
    })

    it("renders Retry button and fires onRetry on click", () => {
      const onRetry = jest.fn()
      render(<Harness error={new Error("boom")} onRetry={onRetry} />)
      fireEvent.click(screen.getByTestId("log-virtualized-list-error-retry"))
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it("hides Retry button when onRetry is not provided", () => {
      render(<Harness error={new Error("boom")} />)
      expect(screen.queryByTestId("log-virtualized-list-error-retry")).not.toBeInTheDocument()
    })

    it("toggles error details pane", () => {
      render(<Harness error={new Error("kaboom")} />)
      const toggle = screen.getByTestId("log-virtualized-list-error-details-toggle")
      expect(screen.queryByTestId("log-virtualized-list-error-details")).not.toBeInTheDocument()
      fireEvent.click(toggle)
      expect(screen.getByTestId("log-virtualized-list-error-details")).toHaveTextContent("kaboom")
      fireEvent.click(toggle)
      expect(screen.queryByTestId("log-virtualized-list-error-details")).not.toBeInTheDocument()
    })

    it("falls back to String(error) when error.message is empty", () => {
      const err = new Error()
      render(<Harness error={err} />)
      fireEvent.click(screen.getByTestId("log-virtualized-list-error-details-toggle"))
      expect(screen.getByTestId("log-virtualized-list-error-details").textContent).toContain(
        "Error"
      )
    })
  })

  describe("empty state", () => {
    it("shows description when no filters active", () => {
      render(<Harness emptyContext={{ activeFilterLabels: [] }} />)
      expect(screen.getByText("No logs collected yet")).toBeInTheDocument()
      expect(screen.getByText(/Logs appear here automatically/)).toBeInTheDocument()
    })

    it("defaults activeLabels to [] when emptyStateContext is undefined", () => {
      render(<Harness />)
      expect(screen.getByTestId("log-virtualized-list-empty")).toBeInTheDocument()
      expect(screen.queryByTestId("log-virtualized-list-empty-filters")).not.toBeInTheDocument()
      expect(screen.getByText("No logs collected yet")).toBeInTheDocument()
    })

    it("renders filter labels as Badges and offers clear / presets", () => {
      const onClearFilters = jest.fn()
      const onOpenPresets = jest.fn()
      render(
        <Harness
          emptyContext={{
            activeFilterLabels: ["level:error", "module:foo"],
            onClearFilters,
            onOpenPresets,
          }}
        />
      )
      expect(screen.getByText("No logs match the active filters:")).toBeInTheDocument()
      const labelChips = screen.getByTestId("log-virtualized-list-empty-filters")
      expect(labelChips).toHaveTextContent("level:error")
      expect(labelChips).toHaveTextContent("module:foo")

      fireEvent.click(screen.getByTestId("log-virtualized-list-empty-clear"))
      expect(onClearFilters).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByTestId("log-virtualized-list-empty-presets"))
      expect(onOpenPresets).toHaveBeenCalledTimes(1)
    })

    it("renders only the buttons whose callbacks are wired", () => {
      render(<Harness emptyContext={{ activeFilterLabels: ["x"], onClearFilters: jest.fn() }} />)
      expect(screen.getByTestId("log-virtualized-list-empty-clear")).toBeInTheDocument()
      expect(screen.queryByTestId("log-virtualized-list-empty-presets")).not.toBeInTheDocument()
    })
  })

  describe("grouped view", () => {
    it("renders one TraceGroup per group entry", () => {
      const groupedLogs = new Map<string, StructuredLogEntry[]>([
        ["trace-1", [makeLog("a"), makeLog("b")]],
        ["trace-2", [makeLog("c")]],
      ])
      render(
        <Harness
          filteredLogs={[makeLog("a"), makeLog("b"), makeLog("c")]}
          groupByTraceId
          groupedLogs={groupedLogs}
        />
      )
      expect(screen.getByTestId("trace-group-trace-1")).toHaveTextContent("2 logs")
      expect(screen.getByTestId("trace-group-trace-2")).toHaveTextContent("1 logs")
    })
  })

  describe("flat virtualized view", () => {
    it("renders up to 5 mocked log rows (one MemoizedLogEntry per virtual item)", () => {
      const logs = Array.from({ length: 12 }, (_, i) => makeLog(String(i)))
      render(<Harness filteredLogs={logs} />)
      expect(screen.getByTestId("memoized-log-0")).toBeInTheDocument()
      expect(screen.getByTestId("memoized-log-4")).toBeInTheDocument()
      expect(screen.queryByTestId("memoized-log-5")).not.toBeInTheDocument()
    })

    it("ignores groupedLogs when groupByTraceId is false", () => {
      const logs = [makeLog("only")]
      const grouped = new Map<string, StructuredLogEntry[]>([["t", logs]])
      render(<Harness filteredLogs={logs} groupedLogs={grouped} />)
      expect(screen.queryByTestId("trace-group-t")).not.toBeInTheDocument()
      expect(screen.getByTestId("memoized-log-only")).toBeInTheDocument()
    })
  })
})
