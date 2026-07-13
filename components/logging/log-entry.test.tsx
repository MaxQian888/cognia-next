/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { useTranslations } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("@cognia/agent-trace/log-adapter", () => ({
  AGENT_TRACE_MODULE: "agent.trace",
}))

jest.mock("@/lib/agent", () => ({
  LIVE_TRACE_EVENT_ICONS: {
    "tool.start": ({ className }: { className?: string }) => (
      <svg data-testid="agent-trace-icon" className={className} />
    ),
  },
  LIVE_TRACE_EVENT_COLORS: {
    "tool.start": "text-purple-500",
  },
}))

import {
  LogEntry,
  TraceGroup,
  MemoizedLogEntry,
  HighlightedText,
  splitByQuery,
  LEVEL_THEME,
  ALL_LEVELS,
} from "./log-entry"
import type { StructuredLogEntry, LogLevel } from "@cognia/logging"

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(() => {
  jest.clearAllTimers()
  ;(navigator.clipboard.writeText as jest.Mock).mockClear()
})

function makeLog(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "log-1",
    timestamp: "2026-01-01T12:34:56.789Z",
    level: "info",
    module: "test-module",
    source: undefined,
    message: "hello world",
    ...overrides,
  } as StructuredLogEntry
}

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)
}

function LogHarness(props: {
  log: StructuredLogEntry
  isExpanded?: boolean
  isBookmarked?: boolean
  onToggle?: (id: string) => void
  onSelect?: (log: StructuredLogEntry) => void
  onFocusTrace?: (traceId: string, log: StructuredLogEntry) => void
  onFocusSession?: (sessionId: string, log: StructuredLogEntry) => void
  onToggleBookmark?: (id: string) => void
  searchQuery?: string
  useRegex?: boolean
  isSelected?: boolean
}) {
  const t = useTranslations("logging")
  return (
    <LogEntry
      log={props.log}
      isExpanded={props.isExpanded ?? false}
      onToggle={props.onToggle ?? jest.fn()}
      onSelect={props.onSelect}
      onFocusTrace={props.onFocusTrace}
      onFocusSession={props.onFocusSession}
      searchQuery={props.searchQuery ?? ""}
      useRegex={props.useRegex ?? false}
      isBookmarked={props.isBookmarked ?? false}
      onToggleBookmark={props.onToggleBookmark}
      isSelected={props.isSelected}
      t={t}
    />
  )
}

function TraceHarness(props: {
  logs: StructuredLogEntry[]
  traceId?: string
  onFocusTrace?: (traceId: string, log: StructuredLogEntry) => void
  onFocusSession?: (sessionId: string, log: StructuredLogEntry) => void
  onToggleBookmark?: (id: string) => void
}) {
  const t = useTranslations("logging")
  return (
    <TraceGroup
      traceId={props.traceId ?? "abc-123"}
      logs={props.logs}
      expandedIds={new Set()}
      toggleExpanded={jest.fn()}
      onFocusTrace={props.onFocusTrace}
      onFocusSession={props.onFocusSession}
      searchQuery=""
      useRegex={false}
      bookmarkedIds={new Set()}
      onToggleBookmark={props.onToggleBookmark}
      t={t}
    />
  )
}

describe("splitByQuery", () => {
  it("returns null on empty query", () => {
    expect(splitByQuery("hello", "", false)).toBeNull()
  })

  it("returns parts and regex for literal query", () => {
    const result = splitByQuery("hello world", "world", false)
    expect(result).not.toBeNull()
    expect(result!.parts.length).toBeGreaterThan(1)
  })

  it("escapes regex special chars in literal mode", () => {
    const result = splitByQuery("a.b.c", ".", false)
    expect(result).not.toBeNull()
    expect(result!.parts.length).toBeGreaterThan(1)
  })

  it("treats query as regex when isRegex=true", () => {
    const result = splitByQuery("Error 500 occurred", "\\d+", true)
    expect(result).not.toBeNull()
    expect(result!.parts.some((p) => p === "500")).toBe(true)
  })

  it("returns null on invalid regex", () => {
    expect(splitByQuery("hello", "[", true)).toBeNull()
  })

  it("is case-insensitive", () => {
    const result = splitByQuery("Hello World", "hello", false)
    expect(result).not.toBeNull()
  })
})

describe("HighlightedText", () => {
  it("renders raw text when no match", () => {
    const { container } = render(<HighlightedText text="hello" query="" useRegex={false} />)
    expect(container.textContent).toBe("hello")
    expect(container.querySelector("mark")).toBeNull()
  })

  it("wraps matches in <mark>", () => {
    const { container } = render(
      <HighlightedText text="hello world" query="world" useRegex={false} />
    )
    const marks = container.querySelectorAll("mark")
    expect(marks.length).toBeGreaterThan(0)
    expect(marks[0].textContent?.toLowerCase()).toBe("world")
  })

  it("renders raw text when regex is invalid", () => {
    const { container } = render(<HighlightedText text="hello" query="[" useRegex={true} />)
    expect(container.textContent).toBe("hello")
    expect(container.querySelector("mark")).toBeNull()
  })
})

describe("LEVEL_THEME / ALL_LEVELS", () => {
  it("exposes theme for every level in ALL_LEVELS", () => {
    expect(ALL_LEVELS).toEqual(["trace", "debug", "info", "warn", "error", "fatal"])
    for (const level of ALL_LEVELS) {
      const theme = LEVEL_THEME[level]
      expect(theme).toBeTruthy()
      expect(theme.icon).toBeDefined()
      expect(typeof theme.iconColor).toBe("string")
      expect(typeof theme.badgeClass).toBe("string")
      expect(typeof theme.bgClass).toBe("string")
      expect(typeof theme.gutterClass).toBe("string")
    }
  })
})

describe("LogEntry rendering", () => {
  it("renders module Badge, time, and message", () => {
    renderWithTooltip(<LogHarness log={makeLog({ message: "boot complete" })} />)
    expect(screen.getByText("test-module")).toBeInTheDocument()
    expect(screen.getByText("boot complete")).toBeInTheDocument()
    expect(screen.getByTestId("log-entry-row")).toHaveAttribute("data-level", "info")
  })

  it("renders truncated traceId Badge when traceId is present", () => {
    renderWithTooltip(<LogHarness log={makeLog({ traceId: "0123456789abcdef" })} />)
    expect(screen.getByText("01234567")).toBeInTheDocument()
  })

  it("uses ChevronRight when collapsed, ChevronDown when expanded", () => {
    const { container, rerender } = renderWithTooltip(
      <LogHarness log={makeLog({ data: { x: 1 } })} isExpanded={false} />
    )
    expect(container.querySelector(".lucide-chevron-right")).toBeInTheDocument()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogHarness log={makeLog({ data: { x: 1 } })} isExpanded={true} />
      </TooltipProvider>
    )
    expect(container.querySelector(".lucide-chevron-down")).toBeInTheDocument()
  })

  it("renders a blank gutter when there are no details", () => {
    const { container } = renderWithTooltip(<LogHarness log={makeLog()} />)
    expect(container.querySelector(".lucide-chevron-right")).toBeNull()
    expect(container.querySelector(".lucide-chevron-down")).toBeNull()
  })

  it("uses agent-trace icon when module matches AGENT_TRACE_MODULE", () => {
    renderWithTooltip(
      <LogHarness log={makeLog({ module: "agent.trace", eventId: "tool.start" })} />
    )
    expect(screen.getByTestId("agent-trace-icon")).toBeInTheDocument()
  })
})

describe("LogEntry interactions", () => {
  it("fires onToggle when row clicked", () => {
    const onToggle = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog()} onToggle={onToggle} />)
    fireEvent.click(screen.getByTestId("log-entry-row").firstChild as Element)
    expect(onToggle).toHaveBeenCalledWith("log-1")
  })

  it("fires onToggle on Enter and Space keydown", () => {
    const onToggle = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog()} onToggle={onToggle} />)
    const row = screen.getByTestId("log-entry-row")
    fireEvent.keyDown(row, { key: "Enter" })
    fireEvent.keyDown(row, { key: " " })
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it("ignores non-toggle keys", () => {
    const onToggle = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog()} onToggle={onToggle} />)
    fireEvent.keyDown(screen.getByTestId("log-entry-row"), { key: "Tab" })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("fires onSelect via PanelRightOpen button and stops propagation", () => {
    const onSelect = jest.fn()
    const onToggle = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog()} onSelect={onSelect} onToggle={onToggle} />)
    fireEvent.click(screen.getByTestId("log-entry-open-details"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("fires onFocusTrace when traceId present and button clicked", () => {
    const onFocusTrace = jest.fn()
    renderWithTooltip(
      <LogHarness log={makeLog({ traceId: "trace-1" })} onFocusTrace={onFocusTrace} />
    )
    fireEvent.click(screen.getByLabelText("Focus this trace"))
    expect(onFocusTrace).toHaveBeenCalledWith("trace-1", expect.objectContaining({ id: "log-1" }))
  })

  it("does not render focus-trace button when traceId is absent", () => {
    renderWithTooltip(<LogHarness log={makeLog()} onFocusTrace={jest.fn()} />)
    expect(screen.queryByLabelText("Focus this trace")).not.toBeInTheDocument()
  })

  it("fires onFocusSession when sessionId present", () => {
    const onFocusSession = jest.fn()
    renderWithTooltip(
      <LogHarness log={makeLog({ sessionId: "sess-1" })} onFocusSession={onFocusSession} />
    )
    fireEvent.click(screen.getByLabelText("Focus this session"))
    expect(onFocusSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({ id: "log-1" }))
  })

  it("toggles bookmark via the bookmark button", () => {
    const onToggleBookmark = jest.fn()
    const { container } = renderWithTooltip(
      <LogHarness log={makeLog()} onToggleBookmark={onToggleBookmark} />
    )
    const bookmarkBtn = container.querySelector(".lucide-bookmark")?.closest("button")
    expect(bookmarkBtn).not.toBeNull()
    fireEvent.click(bookmarkBtn!)
    expect(onToggleBookmark).toHaveBeenCalledWith("log-1")
  })

  it("uses BookmarkCheck icon when isBookmarked=true", () => {
    const { container } = renderWithTooltip(
      <LogHarness log={makeLog()} isBookmarked onToggleBookmark={jest.fn()} />
    )
    expect(container.querySelector(".lucide-bookmark-check")).toBeInTheDocument()
  })

  it("copies log JSON to clipboard and shows the Check icon transiently", () => {
    jest.useFakeTimers()
    const { container } = renderWithTooltip(<LogHarness log={makeLog()} />)
    const copyBtn = container.querySelector(".lucide-copy")?.closest("button") as HTMLButtonElement
    fireEvent.click(copyBtn)
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(container.querySelector(".lucide-check")).toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(2000)
    })
    expect(container.querySelector(".lucide-check")).toBeNull()
    jest.useRealTimers()
  })
})

describe("LogEntry expanded body", () => {
  it("renders data, stack trace, and source location when expanded", () => {
    renderWithTooltip(
      <LogHarness
        log={makeLog({
          data: { count: 5 },
          stack: "Error: boom\n  at line 1",
          source: { file: "log-entry.tsx", line: 42, function: "boom" },
        })}
        isExpanded
      />
    )
    expect(screen.getByText(/"count": 5/)).toBeInTheDocument()
    expect(screen.getByText(/Error: boom/)).toBeInTheDocument()
    expect(screen.getByText(/log-entry\.tsx:42/)).toBeInTheDocument()
    expect(screen.getByText(/\(boom\)/)).toBeInTheDocument()
  })

  it("does not render expanded body when no details", () => {
    renderWithTooltip(<LogHarness log={makeLog()} isExpanded />)
    expect(screen.queryByText("Data:")).not.toBeInTheDocument()
  })
})

describe("MemoizedLogEntry", () => {
  it("is the memoized variant of LogEntry", () => {
    expect(typeof MemoizedLogEntry).toBe("object")
  })
})

describe("TraceGroup", () => {
  function info(id: string): StructuredLogEntry {
    return makeLog({ id, level: "info" })
  }
  function warn(id: string): StructuredLogEntry {
    return makeLog({ id, level: "warn" })
  }
  function err(id: string): StructuredLogEntry {
    return makeLog({ id, level: "error" })
  }

  it("renders default-open with traceId and log count", () => {
    renderWithTooltip(<TraceHarness logs={[info("a"), info("b")]} traceId="t-1" />)
    expect(screen.getByText("t-1")).toBeInTheDocument()
    // Count Badge contains "2 logs"
    const countBadge = screen
      .getAllByText((_content, node) => node?.textContent === "2 logs")
      .find((el) => el.tagName === "DIV" || el.tagName === "SPAN" || el.tagName === "P")
    expect(countBadge).toBeDefined()
  })

  it('shows "No Trace ID" when traceId equals "no-trace"', () => {
    renderWithTooltip(<TraceHarness logs={[info("a")]} traceId="no-trace" />)
    expect(screen.getByText("No Trace ID")).toBeInTheDocument()
  })

  it("renders destructive Badge when any log is error/fatal", () => {
    renderWithTooltip(<TraceHarness logs={[info("a"), err("b")]} />)
    expect(screen.getByText("Error")).toBeInTheDocument()
  })

  it("renders warning Badge when only warnings present", () => {
    renderWithTooltip(<TraceHarness logs={[info("a"), warn("b")]} />)
    expect(screen.getByText("Warning")).toBeInTheDocument()
    expect(screen.queryByText("Error")).not.toBeInTheDocument()
  })

  it("renders neither severity Badge when only info logs", () => {
    renderWithTooltip(<TraceHarness logs={[info("a")]} />)
    expect(screen.queryByText("Error")).not.toBeInTheDocument()
    expect(screen.queryByText("Warning")).not.toBeInTheDocument()
  })

  it("collapses when trigger clicked", () => {
    renderWithTooltip(<TraceHarness logs={[info("a")]} />)
    const trigger = screen.getByText("abc-123").closest("button") as HTMLButtonElement
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute("data-state", "closed")
  })
})

// Keep type-import alive so unused-imports linter doesn't strip it.
const _logLevelGuard: LogLevel | undefined = undefined
void _logLevelGuard

describe("LogEntry — selected state", () => {
  it("marks the row with data-selected and highlight classes when isSelected", () => {
    renderWithTooltip(<LogHarness log={makeLog()} isSelected />)
    const row = screen.getByTestId("log-entry-row")
    expect(row).toHaveAttribute("data-selected", "true")
    expect(row.className).toContain("border-l-primary")
  })

  it("omits data-selected when not selected", () => {
    renderWithTooltip(<LogHarness log={makeLog()} />)
    expect(screen.getByTestId("log-entry-row")).not.toHaveAttribute("data-selected")
  })
})
