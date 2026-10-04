/**
 * @jest-environment jsdom
 */

import React, { createRef } from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { useTranslations } from "next-intl"

const mockVirtualizerOptions: Array<{ getItemKey?: (index: number) => string | number }> = []
const mockScrollToIndex = jest.fn()

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number
    estimateSize: () => number
    getScrollElement: () => HTMLElement | null
    getItemKey?: (index: number) => string | number
  }) => {
    const { count, estimateSize, getScrollElement } = options
    mockVirtualizerOptions.push(options)
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
      scrollToIndex: mockScrollToIndex,
    }
  },
}))

jest.mock("./log-entry", () => ({
  MemoizedLogEntry: ({
    log,
    isSelected,
    isFocused,
    isTabStop,
    setSize,
    index,
    onActivate,
    onFocusRow,
  }: {
    log: { id: string; message: string }
    isSelected?: boolean
    isFocused?: boolean
    isTabStop?: boolean
    setSize?: number
    index?: number
    onActivate?: (log: { id: string }, index: number) => void
    onFocusRow?: (index: number) => void
  }) => (
    <div
      role="option"
      aria-selected={Boolean(isSelected)}
      aria-setsize={setSize}
      data-index={index}
      tabIndex={isTabStop ? 0 : -1}
      data-testid={`memoized-log-${log.id}`}
      data-selected={isSelected || undefined}
      data-focused={isFocused || undefined}
      onFocus={() => onFocusRow?.(index ?? -1)}
      onClick={() => onActivate?.(log, index ?? -1)}
    >
      {log.message}
    </div>
  ),
}))

import { VirtualizedLogList } from "./log-virtualized-list"
import type { StructuredLogEntry } from "@cognia/logging"

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
  emptyContext?: {
    activeFilterLabels: string[]
    onClearFilters?: () => void
    onOpenPresets?: () => void
    windowCappedCount?: number
  }
  onRetry?: () => void
  bookmarkedIds?: Set<string>
  selectedLogId?: string | null
  focusedIndex?: number
  onActivateRow?: (log: StructuredLogEntry, index: number) => void
  onFocusRow?: (index: number) => void
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
      expandedIds={new Set()}
      toggleExpanded={jest.fn()}
      searchQuery=""
      useRegex={false}
      bookmarkedIds={props.bookmarkedIds ?? new Set()}
      toggleBookmark={jest.fn()}
      handleSelectLog={jest.fn()}
      handleFocusTrace={jest.fn()}
      handleFocusSession={jest.fn()}
      selectedLogId={props.selectedLogId}
      focusedIndex={props.focusedIndex}
      onActivateRow={props.onActivateRow}
      onFocusRow={props.onFocusRow}
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

    it("builds its bars from the shared Skeleton primitive", () => {
      // Was `motion-safe:animate-pulse`, which SUPPRESSED the pulse under
      // reduced motion — leaving those users a frozen grey block with no sign
      // the log stream was still loading. `data-slot="skeleton"` is what the
      // tiered reduce-motion rule in globals.css keys its exemption off, so
      // routing through the primitive is what keeps the bars breathing.
      const { container } = render(<Harness isLoading />)
      const bars = container.querySelectorAll('[data-slot="skeleton"]')
      expect(bars.length).toBeGreaterThan(0)
      expect(bars[0]).toHaveClass("animate-pulse")
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

  describe("flat virtualized view", () => {
    it("renders up to 5 mocked log rows (one MemoizedLogEntry per virtual item)", () => {
      const logs = Array.from({ length: 12 }, (_, i) => makeLog(String(i)))
      render(<Harness filteredLogs={logs} />)
      expect(screen.getByTestId("memoized-log-0")).toBeInTheDocument()
      expect(screen.getByTestId("memoized-log-4")).toBeInTheDocument()
      expect(screen.queryByTestId("memoized-log-5")).not.toBeInTheDocument()
    })

    it("keys the measurement cache by log id, not by index", () => {
      // Newest-first: a new entry shifts every row down one index. Index keys
      // would hand each row its predecessor's measured height (rows overlap).
      const logs = [makeLog("newest"), makeLog("older"), makeLog("oldest")]
      mockVirtualizerOptions.length = 0
      render(<Harness filteredLogs={logs} />)
      const options = mockVirtualizerOptions[mockVirtualizerOptions.length - 1]
      expect(options.getItemKey?.(0)).toBe("newest")
      expect(options.getItemKey?.(2)).toBe("oldest")
      // Out-of-range lookups (the virtualizer may probe during a shrink) fall
      // back to the index instead of throwing.
      expect(options.getItemKey?.(7)).toBe(7)
    })

    it("is a labelled listbox with one tab stop", () => {
      const logs = Array.from({ length: 3 }, (_, i) => makeLog(String(i)))
      render(<Harness filteredLogs={logs} />)
      const list = screen.getByRole("listbox", { name: "Log entries" })
      expect(list).toHaveAttribute("data-log-list", "true")
      const options = screen.getAllByRole("option")
      expect(options.filter((o) => o.getAttribute("tabindex") === "0")).toHaveLength(1)
      // Without a cursor the first row on screen is the tab stop.
      expect(options[0]).toHaveAttribute("tabindex", "0")
      expect(options[0]).toHaveAttribute("aria-setsize", "3")
    })
  })
})

describe("VirtualizedLogList — selected row", () => {
  it("marks only the row matching selectedLogId as selected", () => {
    const logs = [makeLog("a"), makeLog("b"), makeLog("c")]
    render(<Harness filteredLogs={logs} selectedLogId="b" />)
    expect(screen.getByTestId("memoized-log-b")).toHaveAttribute("data-selected", "true")
    expect(screen.getByTestId("memoized-log-a")).not.toHaveAttribute("data-selected")
    expect(screen.getByTestId("memoized-log-c")).not.toHaveAttribute("data-selected")
  })
})

describe("VirtualizedLogList — keyboard cursor and activation", () => {
  beforeEach(() => mockScrollToIndex.mockClear())
  const logs = ["a", "b", "c"].map((id) => makeLog(id))

  it("marks the cursor row and scrolls it into view only when needed", () => {
    render(<Harness filteredLogs={logs} focusedIndex={2} />)
    expect(screen.getByTestId("memoized-log-c")).toHaveAttribute("data-focused", "true")
    expect(screen.getByTestId("memoized-log-a")).not.toHaveAttribute("data-focused")
    expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: "auto" })
  })

  it("does not scroll without a cursor, or with a cursor past the end", () => {
    const { rerender } = render(<Harness filteredLogs={logs} focusedIndex={-1} />)
    rerender(<Harness filteredLogs={logs} focusedIndex={9} />)
    expect(mockScrollToIndex).not.toHaveBeenCalled()
  })

  it("hands a row's activation back with its index", () => {
    const onActivateRow = jest.fn()
    render(<Harness filteredLogs={logs} onActivateRow={onActivateRow} />)
    fireEvent.click(screen.getByTestId("memoized-log-b"))
    expect(onActivateRow).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), 1)
  })

  it("puts the tab stop on the cursor row", () => {
    render(<Harness filteredLogs={logs} focusedIndex={1} />)
    expect(screen.getByTestId("memoized-log-b")).toHaveAttribute("tabindex", "0")
    expect(screen.getByTestId("memoized-log-a")).toHaveAttribute("tabindex", "-1")
  })

  it("reports a focused row so the cursor follows a click or Tab", () => {
    const onFocusRow = jest.fn()
    render(<Harness filteredLogs={logs} onFocusRow={onFocusRow} />)
    act(() => screen.getByTestId("memoized-log-c").focus())
    expect(onFocusRow).toHaveBeenCalledWith(2)
  })

  it("moves DOM focus with the cursor while focus is inside the list", () => {
    jest.useFakeTimers()
    try {
      const { rerender } = render(<Harness filteredLogs={logs} focusedIndex={0} />)
      act(() => screen.getByTestId("memoized-log-a").focus())
      rerender(<Harness filteredLogs={logs} focusedIndex={2} />)
      act(() => {
        jest.runOnlyPendingTimers()
      })
      expect(screen.getByTestId("memoized-log-c")).toHaveFocus()
    } finally {
      jest.useRealTimers()
    }
  })

  it("leaves focus alone when it is outside the list", () => {
    jest.useFakeTimers()
    try {
      const outside = document.createElement("button")
      document.body.appendChild(outside)
      outside.focus()
      const { rerender } = render(<Harness filteredLogs={logs} focusedIndex={0} />)
      rerender(<Harness filteredLogs={logs} focusedIndex={2} />)
      act(() => {
        jest.runOnlyPendingTimers()
      })
      expect(outside).toHaveFocus()
      outside.remove()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("VirtualizedLogList — empty state over a full window", () => {
  it("says only the newest entries were searched", () => {
    render(
      <Harness emptyContext={{ activeFilterLabels: ["Search: boom"], windowCappedCount: 1000 }} />
    )
    expect(screen.getByTestId("log-virtualized-list-empty-window")).toHaveTextContent("1000")
  })

  it("does not mention the window when it is not full", () => {
    render(<Harness emptyContext={{ activeFilterLabels: ["Search: boom"] }} />)
    expect(screen.queryByTestId("log-virtualized-list-empty-window")).not.toBeInTheDocument()
  })
})
