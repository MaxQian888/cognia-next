import type { UIMessage } from "ai"
import {
  IDLE_TIMING,
  activeElapsedMs,
  formatRunElapsed,
  formatToolLine,
  nextRunTiming,
  selectActiveToolLines,
  selectRunningSubagentChip,
  summarizeToolCall,
  toolDisplayName,
  type RunTiming,
} from "./run-status"

describe("nextRunTiming", () => {
  it("starts a fresh clock when entering streaming from idle", () => {
    expect(nextRunTiming(IDLE_TIMING, "streaming", 1000)).toEqual({
      startedAt: 1000,
      pausedAt: null,
      pausedAccumMs: 0,
    })
  })

  it("is a no-op when already streaming", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: null, pausedAccumMs: 0 }
    expect(nextRunTiming(t, "streaming", 5000)).toBe(t)
  })

  it("opens a pause stopwatch on awaiting_approval", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: null, pausedAccumMs: 0 }
    expect(nextRunTiming(t, "awaiting_approval", 4000)).toEqual({
      startedAt: 1000,
      pausedAt: 4000,
      pausedAccumMs: 0,
    })
  })

  it("opens the pause clock straight from idle (no prior streaming tick)", () => {
    expect(nextRunTiming(IDLE_TIMING, "awaiting_approval", 5000)).toEqual({
      startedAt: 5000,
      pausedAt: 5000,
      pausedAccumMs: 0,
    })
  })

  it("keeps the first pause timestamp on a repeated awaiting_approval", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: 4000, pausedAccumMs: 0 }
    expect(nextRunTiming(t, "awaiting_approval", 9000)).toBe(t)
  })

  it("banks the paused span when resuming streaming from approval", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: 4000, pausedAccumMs: 500 }
    expect(nextRunTiming(t, "streaming", 6000)).toEqual({
      startedAt: 1000,
      pausedAt: null,
      pausedAccumMs: 2500, // 500 + (6000 - 4000)
    })
  })

  it("clears the clock on idle and on error", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: null, pausedAccumMs: 0 }
    expect(nextRunTiming(t, "idle", 9000)).toEqual(IDLE_TIMING)
    expect(nextRunTiming(t, "error", 9000)).toEqual(IDLE_TIMING)
  })
})

describe("activeElapsedMs", () => {
  it("returns null when no turn is running", () => {
    expect(activeElapsedMs(IDLE_TIMING, "idle", 1000)).toBeNull()
  })

  it("counts wall time minus banked pauses while streaming", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: null, pausedAccumMs: 2000 }
    expect(activeElapsedMs(t, "streaming", 6000)).toBe(3000) // 5000 - 2000
  })

  it("freezes during an open approval pause", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: 4000, pausedAccumMs: 0 }
    // wall = 9000-1000 = 8000; minus open pause (9000-4000=5000) = 3000
    expect(activeElapsedMs(t, "awaiting_approval", 9000)).toBe(3000)
    // …and stays frozen as wall time advances
    expect(activeElapsedMs(t, "awaiting_approval", 12000)).toBe(3000)
  })

  it("never goes negative", () => {
    const t: RunTiming = { startedAt: 5000, pausedAt: null, pausedAccumMs: 0 }
    expect(activeElapsedMs(t, "streaming", 1000)).toBe(0)
  })

  it("ignores a null pausedAt even while awaiting_approval", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: null, pausedAccumMs: 0 }
    expect(activeElapsedMs(t, "awaiting_approval", 4000)).toBe(3000)
  })
})

describe("formatRunElapsed", () => {
  it.each([
    [0, "0s"],
    [47_000, "47s"],
    [247_000, "4m 07s"],
    [3_729_000, "1h 02m 09s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatRunElapsed(ms)).toBe(expected)
  })

  it("treats undefined as 0s", () => {
    expect(formatRunElapsed(undefined as unknown as number)).toBe("0s")
  })

  it("guards against a non-finite input", () => {
    expect(formatRunElapsed(Infinity)).toBe("0s")
  })
})

describe("activeElapsedMs pause clamp", () => {
  it("never lets a future pause timestamp inflate the elapsed", () => {
    const t: RunTiming = { startedAt: 1000, pausedAt: 20_000, pausedAccumMs: 0 }
    // now (9000) < pausedAt (20000): the open-pause subtraction clamps to 0.
    expect(activeElapsedMs(t, "awaiting_approval", 9000)).toBe(8000)
  })
})

describe("toolDisplayName / summarizeToolCall / formatToolLine", () => {
  it("collapses mcp/plugin names", () => {
    expect(toolDisplayName("mcp__github__create_issue")).toBe("github:create_issue")
    expect(toolDisplayName("plugin__web-tools__fetch")).toBe("web-tools:fetch")
    expect(toolDisplayName("Bash")).toBe("Bash")
  })

  it("summarizes by tool", () => {
    expect(summarizeToolCall("Bash", { command: "npm test" })).toBe("npm test")
    expect(summarizeToolCall("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts")
    expect(summarizeToolCall("Grep", { pattern: "TODO", path: "src" })).toBe("TODO  src")
  })

  it("formats a tool line, dropping the tail when there's no summary", () => {
    expect(formatToolLine("Bash", { command: "ls" })).toBe("Bash: ls")
    expect(formatToolLine("TodoWrite", {})).toBe("TodoWrite")
  })

  it("summarizes glob / webfetch / task and tolerates non-object input", () => {
    expect(summarizeToolCall("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts")
    expect(summarizeToolCall("WebFetch", { url: "https://x.dev" })).toBe("https://x.dev")
    expect(summarizeToolCall("Task", { subagent_type: "reviewer" })).toBe("reviewer")
    expect(summarizeToolCall("Bash", null)).toBe("")
  })

  it("falls back to a later candidate key when the first is absent", () => {
    // file_path missing → firstString walks to filePath
    expect(summarizeToolCall("Read", { filePath: "/y" })).toBe("/y")
  })

  it("recognizes tool-name aliases", () => {
    expect(summarizeToolCall("shell", { command: "ls" })).toBe("ls")
    expect(summarizeToolCall("search", { query: "TODO" })).toBe("TODO")
    expect(summarizeToolCall("fetch", { url: "u" })).toBe("u")
    expect(summarizeToolCall("agent", { description: "d" })).toBe("d")
  })

  it("returns empty string for tools called with no recognizable args", () => {
    expect(summarizeToolCall("glob", {})).toBe("")
    expect(summarizeToolCall("read", {})).toBe("")
    expect(summarizeToolCall("webfetch", {})).toBe("")
    expect(summarizeToolCall("task", {})).toBe("")
  })

  it("truncates an over-long summary with an ellipsis", () => {
    const long = "x".repeat(120)
    const out = summarizeToolCall("Bash", { command: long })
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBe(80)
  })
})

describe("selectActiveToolLines", () => {
  const msg = (role: string, parts: unknown[]): UIMessage =>
    ({ id: `${role}-${Math.random()}`, role, parts }) as unknown as UIMessage

  it("returns running tool parts of the last assistant message", () => {
    const messages = [
      msg("user", [{ type: "text", text: "hi" }]),
      msg("assistant", [
        {
          type: "tool-Bash",
          state: "input-available",
          input: { command: "npm test" },
          toolCallId: "t1",
        },
        {
          type: "tool-Read",
          state: "output-available",
          input: { file_path: "/x" },
          toolCallId: "t2",
        },
      ]),
    ]
    expect(selectActiveToolLines(messages)).toEqual([{ id: "t1", label: "Bash: npm test" }])
  })

  it("ignores completed/errored tools", () => {
    const messages = [
      msg("assistant", [
        { type: "tool-Read", state: "output-available", input: {}, toolCallId: "a" },
        { type: "tool-Grep", state: "output-error", input: {}, toolCallId: "b" },
      ]),
    ]
    expect(selectActiveToolLines(messages)).toEqual([])
  })

  it("caps at max, keeping the most recent", () => {
    const messages = [
      msg("assistant", [
        { type: "tool-Bash", state: "input-available", input: { command: "1" }, toolCallId: "a" },
        { type: "tool-Bash", state: "input-available", input: { command: "2" }, toolCallId: "b" },
        { type: "tool-Bash", state: "input-available", input: { command: "3" }, toolCallId: "c" },
      ]),
    ]
    expect(selectActiveToolLines(messages, 2).map((l) => l.id)).toEqual(["b", "c"])
  })

  it("treats a stateless tool part as running and falls back on a missing toolCallId", () => {
    const messages = [
      msg("assistant", [
        { type: "text", text: "" },
        { type: "tool-Read", input: { file_path: "/x" } }, // no state, no toolCallId
      ]),
    ]
    expect(selectActiveToolLines(messages)).toEqual([{ id: "0-0", label: "Read: /x" }])
  })

  it("tolerates a message with no parts", () => {
    expect(selectActiveToolLines([{ id: "a", role: "assistant" } as unknown as UIMessage])).toEqual(
      []
    )
  })

  it("skips trailing non-assistant messages to reach the last assistant turn", () => {
    const messages = [
      msg("assistant", [
        { type: "tool-Bash", state: "input-available", input: { command: "go" }, toolCallId: "t" },
      ]),
      msg("user", [{ type: "text", text: "wait" }]),
    ]
    expect(selectActiveToolLines(messages)).toEqual([{ id: "t", label: "Bash: go" }])
  })
})

describe("nextRunTiming edge — resume when startedAt was never set", () => {
  it("anchors startedAt to now when resuming a paused-from-start clock", () => {
    // awaiting_approval reached before any streaming tick: startedAt stayed null.
    const paused: RunTiming = { startedAt: null, pausedAt: 4000, pausedAccumMs: 0 }
    expect(nextRunTiming(paused, "streaming", 6000)).toEqual({
      startedAt: 6000,
      pausedAt: null,
      pausedAccumMs: 2000,
    })
  })

  it("clamps a negative pause span when resume time precedes the pause", () => {
    const paused: RunTiming = { startedAt: 1000, pausedAt: 8000, pausedAccumMs: 0 }
    expect(nextRunTiming(paused, "streaming", 5000).pausedAccumMs).toBe(0)
  })
})

describe("selectRunningSubagentChip", () => {
  it("returns null when nothing is running", () => {
    expect(selectRunningSubagentChip({ a: { name: "x", status: "completed" } })).toBeNull()
  })

  it("counts running subagents and names the most recent", () => {
    expect(
      selectRunningSubagentChip({
        a: { name: "reviewer", status: "running" },
        b: { name: "tester", status: "completed" },
        c: { name: "writer", status: "running" },
      })
    ).toEqual({ name: "writer", count: 2 })
  })
})
