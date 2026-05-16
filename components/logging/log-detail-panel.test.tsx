/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("@/lib/agent-trace/log-adapter", () => ({
  AGENT_TRACE_MODULE: "agent.trace",
  getAgentTraceLogData: (log: { data?: unknown }) => log.data,
}))

jest.mock("@/lib/agent", () => ({
  LIVE_TRACE_EVENT_ICONS: {
    "tool.call": ({ className }: { className?: string }) => (
      <svg data-testid="trace-icon" className={className} />
    ),
  },
  LIVE_TRACE_EVENT_COLORS: {
    "tool.call": "text-purple-500",
  },
  formatDuration: (ms: number) => `${ms}ms`,
  formatTokens: (n: number) => `${n}t`,
}))

jest.mock("@/lib/agent-trace/cost-estimator", () => ({
  formatCost: (cost: number) => `$${cost.toFixed(4)}`,
}))

import { LogDetailPanel } from "./log-detail-panel"
import type { StructuredLogEntry } from "@/lib/logger"

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(() => {
  jest.clearAllMocks()
})

function makeLog(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "l-1",
    timestamp: "2026-01-01T12:34:56.789Z",
    level: "info",
    module: "test",
    message: "primary log message",
    ...overrides,
  } as StructuredLogEntry
}

function renderPanel(props: Parameters<typeof LogDetailPanel>[0]) {
  return render(
    <TooltipProvider delayDuration={0}>
      <LogDetailPanel {...props} />
    </TooltipProvider>
  )
}

describe("LogDetailPanel — header & metadata", () => {
  it("renders title, level Badge, and message", () => {
    renderPanel({ log: makeLog({ level: "warn" }) })
    expect(screen.getByText("Log Detail")).toBeInTheDocument()
    expect(screen.getByText("WARN")).toBeInTheDocument()
    expect(screen.getByText("primary log message")).toBeInTheDocument()
  })

  it("fires onClose", () => {
    const onClose = jest.fn()
    const { container } = renderPanel({ log: makeLog(), onClose })
    const closeBtn = container.querySelector(".lucide-x")?.closest("button") as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("hides close button when onClose is not provided", () => {
    const { container } = renderPanel({ log: makeLog() })
    expect(container.querySelector(".lucide-x")).toBeNull()
  })

  it("toggles bookmark icon based on isBookmarked", () => {
    const { container, rerender } = renderPanel({
      log: makeLog(),
      onToggleBookmark: jest.fn(),
      isBookmarked: false,
    })
    expect(container.querySelector(".lucide-bookmark")).toBeInTheDocument()
    expect(container.querySelector(".lucide-bookmark-check")).toBeNull()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogDetailPanel log={makeLog()} onToggleBookmark={jest.fn()} isBookmarked={true} />
      </TooltipProvider>
    )
    expect(container.querySelector(".lucide-bookmark-check")).toBeInTheDocument()
  })

  it("fires onToggleBookmark with log.id when bookmark button clicked", () => {
    const onToggleBookmark = jest.fn()
    const { container } = renderPanel({ log: makeLog(), onToggleBookmark })
    const btn = container.querySelector(".lucide-bookmark")?.closest("button") as HTMLButtonElement
    fireEvent.click(btn)
    expect(onToggleBookmark).toHaveBeenCalledWith("l-1")
  })

  it("renders metadata grid (timestamp + module)", () => {
    renderPanel({ log: makeLog({ module: "my-module" }) })
    expect(screen.getByText("Timestamp")).toBeInTheDocument()
    expect(screen.getByText("my-module")).toBeInTheDocument()
  })

  it("renders traceId block with copy button when traceId present", () => {
    renderPanel({ log: makeLog({ traceId: "trace-xyz" }) })
    expect(screen.getByText("trace-xyz")).toBeInTheDocument()
    expect(screen.getByText("Trace ID")).toBeInTheDocument()
  })

  it("renders sessionId block when sessionId present", () => {
    renderPanel({ log: makeLog({ sessionId: "session-1" }) })
    expect(screen.getByText("session-1")).toBeInTheDocument()
  })

  it("renders source block when log.source present", () => {
    renderPanel({
      log: makeLog({
        source: { file: "main.ts", line: 42, function: "boot" },
      }),
    })
    expect(screen.getByText(/main\.ts:42/)).toBeInTheDocument()
    expect(screen.getByText(/\(boot\)/)).toBeInTheDocument()
  })

  it("renders tag Badges when tags present", () => {
    renderPanel({ log: makeLog({ tags: ["api", "boot"] }) })
    expect(screen.getByText("api")).toBeInTheDocument()
    expect(screen.getByText("boot")).toBeInTheDocument()
  })
})

describe("LogDetailPanel — copy buttons", () => {
  it("copies message text and shows transient Check icon", () => {
    jest.useFakeTimers()
    const { container } = renderPanel({ log: makeLog({ message: "boom" }) })
    const copyButtons = container.querySelectorAll(".lucide-copy")
    fireEvent.click(copyButtons[0].closest("button") as HTMLButtonElement)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("boom")
    expect(container.querySelector(".lucide-check")).toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(2000)
    })
    expect(container.querySelector(".lucide-check")).toBeNull()
    jest.useRealTimers()
  })

  it("copyButton with showText renders an outline Button with the label visible", () => {
    renderPanel({
      log: makeLog({ data: { x: 1 } }),
    })
    expect(screen.getByText("Copy JSON")).toBeInTheDocument()
  })
})

describe("LogDetailPanel — data tree", () => {
  it("renders the data JSON tree for non-agent-trace logs", () => {
    renderPanel({ log: makeLog({ data: { foo: "bar" } }) })
    expect(screen.getByText('"foo"')).toBeInTheDocument()
    expect(screen.getByText('"bar"')).toBeInTheDocument()
  })

  it("renders primitives correctly", () => {
    renderPanel({
      log: makeLog({ data: { num: 42, bool: true, nothing: null } }),
    })
    expect(screen.getByText("42")).toBeInTheDocument()
    expect(screen.getByText("true")).toBeInTheDocument()
    expect(screen.getByText("null")).toBeInTheDocument()
  })

  it("does not render the data block when the log is an agent-trace event", () => {
    renderPanel({
      log: makeLog({ module: "agent.trace", data: { foo: "bar" } }),
    })
    // The data section's "Data" label should NOT appear (replaced by agent-trace section)
    expect(screen.queryByText("Data")).not.toBeInTheDocument()
  })

  it("toggles arrays open/close", () => {
    renderPanel({ log: makeLog({ data: [1, 2, 3] as unknown as Record<string, unknown> }) })
    expect(screen.getByText("items")).toBeInTheDocument()
  })
})

describe("LogDetailPanel — stack trace", () => {
  it("parses Chrome-style stack frames", () => {
    const stack = `Error: boom
    at boot (/src/main.ts:10:5)
    at /src/main.ts:1:1`
    renderPanel({ log: makeLog({ stack }) })
    expect(screen.getByText("boot")).toBeInTheDocument()
    expect(screen.getByText("/src/main.ts:10:5")).toBeInTheDocument()
    expect(screen.getByText("<anonymous>")).toBeInTheDocument()
  })

  it("parses Firefox-style stack frames", () => {
    const stack = "boom@/src/main.ts:10:5"
    renderPanel({ log: makeLog({ stack }) })
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("falls back to ScrollArea + <pre> when no frames can be parsed", () => {
    const stack = "totally unparseable lines\nnone matches"
    const { container } = renderPanel({ log: makeLog({ stack }) })
    expect(container.querySelector("pre")?.textContent).toContain("totally unparseable")
  })
})

describe("LogDetailPanel — agent trace section", () => {
  it("renders tool name, duration, token usage, and cost", () => {
    renderPanel({
      log: makeLog({
        module: "agent.trace",
        data: {
          eventType: "tool.call",
          toolName: "search",
          duration: 250,
          tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          costEstimate: { totalCost: 0.01, inputCost: 0.005, outputCost: 0.005 },
        },
      }),
    })
    expect(screen.getByText("search")).toBeInTheDocument()
    expect(screen.getByText("250ms")).toBeInTheDocument()
    expect(screen.getByText("100t")).toBeInTheDocument()
    expect(screen.getByText("150t")).toBeInTheDocument()
    expect(screen.getByText(/in:/)).toBeInTheDocument()
    expect(screen.getByText(/out:/)).toBeInTheDocument()
  })

  it("renders success Badge when success=true", () => {
    renderPanel({
      log: makeLog({
        module: "agent.trace",
        data: { eventType: "tool.call", success: true },
      }),
    })
    expect(screen.getByText("Success")).toBeInTheDocument()
  })

  it("renders failed Badge when success=false", () => {
    renderPanel({
      log: makeLog({
        module: "agent.trace",
        data: { eventType: "tool.call", success: false },
      }),
    })
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  it("renders error inside Alert variant=destructive", () => {
    renderPanel({
      log: makeLog({
        module: "agent.trace",
        data: { eventType: "tool.call", error: "tool crashed" },
      }),
    })
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("tool crashed")
  })

  it("renders response preview, files, step number, and model id", () => {
    renderPanel({
      log: makeLog({
        module: "agent.trace",
        data: {
          eventType: "tool.call",
          responsePreview: "x".repeat(400),
          files: ["a.ts", "b.ts"],
          stepNumber: 3,
          modelId: "claude-sonnet-4-6",
        },
      }),
    })
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
    expect(screen.getByText("b.ts")).toBeInTheDocument()
    expect(screen.getByText("#3")).toBeInTheDocument()
    expect(screen.getByText(/x{300}\.\.\./)).toBeInTheDocument()
  })

  it("renders tool args inside ScrollArea-wrapped pre after expanding the collapsible", () => {
    const { container } = renderPanel({
      log: makeLog({
        module: "agent.trace",
        data: { eventType: "tool.call", toolArgs: '{"k":"v"}' },
      }),
    })
    // The Collapsible defaults closed; click the trigger to expand.
    const trigger = screen.getByText("Arguments").closest("button") as HTMLButtonElement
    fireEvent.click(trigger)
    expect(container.querySelector("pre")?.textContent).toContain('{"k":"v"}')
  })

  it("falls back to 'unknown' badge when eventType is missing", () => {
    renderPanel({
      log: makeLog({ module: "agent.trace", data: {} }),
    })
    expect(screen.getByText("unknown")).toBeInTheDocument()
  })
})

describe("LogDetailPanel — related logs", () => {
  it("renders related-log buttons filtered to exclude the current log", () => {
    const related = [
      makeLog({ id: "l-1", message: "self" }),
      makeLog({ id: "l-2", level: "error", message: "second" }),
    ]
    renderPanel({ log: makeLog({ id: "l-1" }), relatedLogs: related })
    expect(screen.queryByText("self")).not.toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
  })

  it("fires onSelectRelated when a related row is clicked", () => {
    const onSelectRelated = jest.fn()
    const related = [makeLog({ id: "l-2", message: "click me" })]
    renderPanel({ log: makeLog({ id: "l-1" }), relatedLogs: related, onSelectRelated })
    fireEvent.click(screen.getByTestId("related-log-l-2"))
    expect(onSelectRelated).toHaveBeenCalledTimes(1)
    expect(onSelectRelated.mock.calls[0][0].id).toBe("l-2")
  })

  it("caps the related list at 20 entries", () => {
    const related = Array.from({ length: 30 }, (_, i) =>
      makeLog({ id: `l-${i + 2}`, message: `msg-${i}` })
    )
    renderPanel({ log: makeLog({ id: "l-1" }), relatedLogs: related })
    const items = screen.getAllByTestId(/^related-log-/)
    expect(items.length).toBeLessThanOrEqual(20)
  })

  it("omits the related-logs block entirely when filteredRelated is empty", () => {
    renderPanel({ log: makeLog({ id: "l-1" }), relatedLogs: [makeLog({ id: "l-1" })] })
    expect(screen.queryByText(/Related Logs/)).not.toBeInTheDocument()
  })
})

describe("JsonTreeNode — primitive fallback", () => {
  it("renders String(undefined) for unknown primitive types in the data tree", () => {
    renderPanel({
      log: makeLog({
        data: { weird: undefined as unknown as string },
      }),
    })
    // undefined renders via String(value) — matches "undefined" text node
    expect(screen.getByText("undefined")).toBeInTheDocument()
  })

  it("renders array entries without object labels", () => {
    renderPanel({ log: makeLog({ data: ["a", "b"] as unknown as Record<string, unknown> }) })
    expect(screen.getByText('"a"')).toBeInTheDocument()
    expect(screen.getByText('"b"')).toBeInTheDocument()
  })
})
