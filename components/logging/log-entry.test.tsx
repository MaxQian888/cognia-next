/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, act, within } from "@testing-library/react"
import { useTranslations } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import { HOVER_REVEAL_REQUIRED_VARIANTS } from "@/lib/ui/hover-reveal"

const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), { error: (...args: unknown[]) => mockToastError(...args) }),
}))

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
  onActivate?: (log: StructuredLogEntry, index: number) => void
  index?: number
  isFocused?: boolean
  isTabStop?: boolean
  onFocusRow?: (index: number) => void
  setSize?: number
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
      onActivate={props.onActivate}
      index={props.index}
      isFocused={props.isFocused}
      isTabStop={props.isTabStop}
      onFocusRow={props.onFocusRow}
      setSize={props.setSize}
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

  it("keeps the message on one line with the metadata, and lets it drop below on a narrow row", () => {
    // The timestamp and both badges are `shrink-0`. On a 375px row that left
    // the message roughly ninety pixels and it broke at every hyphen, one
    // fragment per line. They now share a wrapper that wraps below `sm`, so
    // the message takes a full-width line of its own instead.
    renderWithTooltip(<LogHarness log={makeLog({ message: "boot complete" })} />)
    const message = screen.getByText("boot complete")
    const wrapper = message.closest(".flex-wrap")
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass("sm:flex-nowrap")
    expect(within(wrapper as HTMLElement).getByText("test-module")).toBeInTheDocument()
    expect(message).toHaveClass("w-full", "sm:w-auto")
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

  it("without a host activation, Enter falls back to expanding; Space expands an entry with details", () => {
    const onToggle = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog({ data: { a: 1 } })} onToggle={onToggle} />)
    const row = screen.getByTestId("log-entry-row")
    fireEvent.keyDown(row, { key: "Enter" })
    fireEvent.keyDown(row, { key: " " })
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it("Space does nothing on an entry with no details to expand", () => {
    const onToggle = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog()} onToggle={onToggle} />)
    fireEvent.keyDown(screen.getByTestId("log-entry-row"), { key: " " })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("a row click and Enter open the entry when the host passes onActivate", () => {
    const onActivate = jest.fn()
    const onToggle = jest.fn()
    renderWithTooltip(
      <LogHarness
        log={makeLog({ data: { a: 1 } })}
        onToggle={onToggle}
        onActivate={onActivate}
        index={4}
      />
    )
    const row = screen.getByTestId("log-entry-row")
    fireEvent.click(row.firstChild as Element)
    fireEvent.keyDown(row, { key: "Enter" })
    expect(onActivate).toHaveBeenCalledTimes(2)
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "log-1" }), 4)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("the chevron expands in place without opening the entry", () => {
    const onActivate = jest.fn()
    const onToggle = jest.fn()
    renderWithTooltip(
      <LogHarness log={makeLog({ data: { a: 1 } })} onToggle={onToggle} onActivate={onActivate} />
    )
    const chevron = screen.getByTestId("log-entry-expand")
    expect(chevron).toHaveAccessibleName("Expand entry")
    expect(chevron).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(chevron)
    expect(onToggle).toHaveBeenCalledWith("log-1")
    expect(onActivate).not.toHaveBeenCalled()
  })

  it("names the chevron for collapsing once expanded", () => {
    renderWithTooltip(<LogHarness log={makeLog({ data: { a: 1 } })} isExpanded />)
    expect(screen.getByTestId("log-entry-expand")).toHaveAccessibleName("Collapse entry")
    expect(screen.getByTestId("log-entry-expand")).toHaveAttribute("aria-expanded", "true")
  })

  it("ignores Enter aimed at a button inside the row", () => {
    const onActivate = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog()} onActivate={onActivate} onSelect={jest.fn()} />)
    fireEvent.keyDown(screen.getByTestId("log-entry-copy"), { key: "Enter" })
    expect(onActivate).not.toHaveBeenCalled()
  })

  it("is an option of the list with roving tabindex", () => {
    const onFocusRow = jest.fn()
    const { rerender } = renderWithTooltip(
      <LogHarness
        log={makeLog()}
        index={4}
        setSize={10}
        isTabStop={false}
        onFocusRow={onFocusRow}
      />
    )
    const row = screen.getByRole("option")
    expect(row).toHaveAttribute("tabindex", "-1")
    expect(row).toHaveAttribute("aria-posinset", "5")
    expect(row).toHaveAttribute("aria-setsize", "10")
    expect(row).toHaveAttribute("aria-selected", "false")

    rerender(
      <TooltipProvider delayDuration={0}>
        <LogHarness
          log={makeLog()}
          index={4}
          setSize={10}
          isTabStop
          isSelected
          onFocusRow={onFocusRow}
        />
      </TooltipProvider>
    )
    expect(row).toHaveAttribute("tabindex", "0")
    expect(row).toHaveAttribute("aria-selected", "true")
    act(() => row.focus())
    expect(onFocusRow).toHaveBeenCalledWith(4)
  })

  it("keeps the row's own controls out of the tab order", () => {
    renderWithTooltip(
      <LogHarness
        log={makeLog({ traceId: "trace-1234567890", sessionId: "s", data: { a: 1 } })}
        onToggleBookmark={jest.fn()}
        onFocusTrace={jest.fn()}
        onFocusSession={jest.fn()}
      />
    )
    const row = screen.getByTestId("log-entry-row")
    for (const button of within(row).getAllByRole("button", { hidden: true })) {
      expect(button).toHaveAttribute("tabindex", "-1")
    }
  })

  it("names the trace badge with the full id and lets it take focus for its tooltip", () => {
    renderWithTooltip(<LogHarness log={makeLog({ traceId: "trace-1234567890" })} />)
    const badge = screen.getByTestId("log-entry-trace-badge")
    expect(badge.tagName).toBe("BUTTON")
    expect(badge).toHaveAccessibleName("Trace ID: trace-1234567890")
    badge.focus()
    expect(badge).toHaveFocus()
  })

  it("no longer renders a separate 'open details' icon; the row and its menu open the entry", () => {
    renderWithTooltip(<LogHarness log={makeLog()} onSelect={jest.fn()} />)
    expect(screen.queryByTestId("log-entry-open-details")).not.toBeInTheDocument()
  })

  it("shows the keyboard cursor", () => {
    renderWithTooltip(<LogHarness log={makeLog()} isFocused />)
    expect(screen.getByTestId("log-entry-row")).toHaveAttribute("data-focused", "true")
  })

  it("prefixes the date on entries from another day", () => {
    renderWithTooltip(<LogHarness log={makeLog({ timestamp: "2020-02-03T10:00:00.000Z" })} />)
    // In the app locale's own order and separator ("en" → 02/03).
    expect(screen.getByTestId("log-entry-row")).toHaveTextContent(/02\/0[34]/)
  })

  it("prints only the time for today's entries", () => {
    renderWithTooltip(<LogHarness log={makeLog({ timestamp: new Date().toISOString() })} />)
    expect(screen.getByTestId("log-entry-row").textContent).not.toMatch(/\d{2}-\d{2}\s?\d{2}:/)
  })

  it("ignores non-toggle keys", () => {
    const onToggle = jest.fn()
    renderWithTooltip(<LogHarness log={makeLog()} onToggle={onToggle} />)
    fireEvent.keyDown(screen.getByTestId("log-entry-row"), { key: "Tab" })
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

  it("keeps the row actions reachable without a hover", () => {
    const onToggleBookmark = jest.fn()
    const onSelect = jest.fn()
    renderWithTooltip(
      <LogHarness log={makeLog()} onToggleBookmark={onToggleBookmark} onSelect={onSelect} />
    )
    const actions = screen.getByTestId("log-entry-actions")
    // Focus, an open popup and touch reveal the cluster too; it only fades.
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.group) {
      expect(actions).toHaveClass(variant)
    }
    expect(actions).not.toHaveClass("invisible", "hidden", "pointer-events-none")

    // The cluster is the only gate: the bookmark button no longer fades a
    // second time on hover, which hid it under keyboard focus.
    const bookmark = screen.getByTestId("log-entry-bookmark")
    expect(bookmark).not.toHaveClass("opacity-0")
    expect(bookmark.querySelector(".lucide-bookmark")).not.toHaveClass("opacity-0")
    expect(bookmark).toHaveAccessibleName()
    bookmark.focus()
    expect(bookmark).toHaveFocus()
    fireEvent.click(bookmark)
    expect(onToggleBookmark).toHaveBeenCalledWith("log-1")
  })

  it("uses BookmarkCheck icon when isBookmarked=true", () => {
    const { container } = renderWithTooltip(
      <LogHarness log={makeLog()} isBookmarked onToggleBookmark={jest.fn()} />
    )
    expect(container.querySelector(".lucide-bookmark-check")).toBeInTheDocument()
  })

  it("copies log JSON to clipboard and shows the Check icon transiently", async () => {
    jest.useFakeTimers()
    const { container } = renderWithTooltip(<LogHarness log={makeLog()} />)
    const copyBtn = screen.getByTestId("log-entry-copy")
    expect(copyBtn).toHaveAccessibleName("Copy log entry")
    await act(async () => {
      fireEvent.click(copyBtn)
    })
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

describe("LogEntry copy failure", () => {
  it("reports a clipboard rejection instead of showing a false check mark", async () => {
    ;(navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(new Error("denied"))
    const { container } = renderWithTooltip(<LogHarness log={makeLog()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("log-entry-copy"))
    })
    expect(container.querySelector(".lucide-check")).toBeNull()
    expect(mockToastError).toHaveBeenCalledWith("Couldn't copy to the clipboard")
  })
})
