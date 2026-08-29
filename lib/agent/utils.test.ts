import {
  formatBytes,
  formatDuration,
  formatToolName,
  parseReplayEvent,
  TOOL_STATE_CONFIG,
  TASK_BOARD_COLUMNS,
} from "./utils"
import type { DBAgentTrace } from "@/lib/db"

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      agent: { ...child, child: () => child },
    },
  }
})

describe("formatBytes", () => {
  it("formats undefined / zero as 0 B", () => {
    expect(formatBytes(undefined)).toBe("0 B")
    expect(formatBytes(0)).toBe("0 B")
  })

  it("formats KB / MB / GB", () => {
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1024 * 1024)).toBe("1 MB")
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB")
  })

  it("rounds to one decimal", () => {
    expect(formatBytes(1500)).toBe("1.5 KB")
  })
})

describe("formatDuration", () => {
  it("renders ms under one second", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  it("renders seconds with one decimal between 1s and 60s", () => {
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(59999)).toBe("60.0s")
  })

  it("renders minutes for >= 60s", () => {
    expect(formatDuration(60000)).toBe("1.0m")
    expect(formatDuration(150000)).toBe("2.5m")
  })
})

describe("formatToolName", () => {
  it("title-cases snake_case", () => {
    expect(formatToolName("read_file")).toBe("Read File")
    expect(formatToolName("multi_word_tool_name")).toBe("Multi Word Tool Name")
  })

  it("title-cases kebab-case", () => {
    expect(formatToolName("write-file")).toBe("Write File")
  })

  it("preserves single tokens", () => {
    expect(formatToolName("bash")).toBe("Bash")
  })
})

describe("parseReplayEvent", () => {
  it("returns a populated ReplayEvent for a well-formed row", () => {
    const record = {
      id: "trace-1",
      timestamp: 1_700_000_000_000,
      eventType: "tool_call",
      stepId: "step-7",
      duration: 1234,
      costEstimate: { totalCost: 0.0042 },
      files: [{ path: "src/foo.ts" }, { path: "" }],
      metadata: {
        toolName: "read",
        success: true,
        responsePreview: "ok",
        error: undefined,
        tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      },
    }

    const row: DBAgentTrace = {
      id: "row-1",
      sessionId: "sess-1",
      record: JSON.stringify(record),
    } as unknown as DBAgentTrace

    const event = parseReplayEvent(row)
    expect(event).not.toBeNull()
    expect(event!.toolName).toBe("read")
    expect(event!.success).toBe(true)
    expect(event!.cost).toBe(0.0042)
    expect(event!.duration).toBe(1234)
    expect(event!.files).toEqual(["src/foo.ts"]) // empty path filtered
  })

  it("returns null on malformed JSON and does not throw", () => {
    const row: DBAgentTrace = {
      id: "row-bad",
      sessionId: "sess",
      record: "{not json",
    } as unknown as DBAgentTrace
    expect(parseReplayEvent(row)).toBeNull()
  })
})

describe("static configs", () => {
  it("TOOL_STATE_CONFIG covers all expected ToolState values", () => {
    const expected = [
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied",
    ]
    for (const state of expected) {
      expect(TOOL_STATE_CONFIG[state as keyof typeof TOOL_STATE_CONFIG]).toBeDefined()
    }
  })

  it("TASK_BOARD_COLUMNS uses i18n labelKeys, not literal labels", () => {
    for (const col of TASK_BOARD_COLUMNS) {
      expect(col.labelKey).toMatch(/^taskBoard\.column[A-Z]/)
      expect(col.statuses.length).toBeGreaterThan(0)
    }
  })
})
