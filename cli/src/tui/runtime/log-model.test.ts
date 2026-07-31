import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { expandPastes } from "@/lib/paste-collapse"

import { bufferFromText, bufferText } from "../input/buffer"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import type { LogEntry, McpLogEntry, TuiState } from "../state/types"
import {
  LOG_MESSAGE_CLAMP,
  LOG_PANEL_FOOTER_ACTIONS,
  LOG_PANEL_FOOTER_KEYS,
  buildLogInjection,
  channelLabel,
  clampMessage,
  classifyAgentStderr,
  collapseLogBlock,
  composerInsertText,
  describeLogFilter,
  filterLogs,
  formatLogRowText,
  formatLogsForCopy,
  logCounts,
  logInjectionActions,
  mcpLogToLogEntry,
  mergeLogSources,
  nextChannelFilter,
  nextLevelFilter,
  nextLogPasteSeq,
  presentChannels,
  toLogLines,
} from "./log-model"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

let seq = 0
function entry(p: Partial<LogEntry> = {}): LogEntry {
  seq += 1
  return {
    id: `l${seq}`,
    ts: p.ts ?? seq,
    level: p.level ?? "info",
    channel: p.channel ?? "agent",
    message: p.message ?? "msg",
    ...(p.origin ? { origin: p.origin } : {}),
  }
}

const ALL: LogFilterShape = { query: "", level: "all", channel: "all" }
type LogFilterShape = Parameters<typeof filterLogs>[1]

describe("clampMessage", () => {
  it("leaves a line at exactly the limit untouched", () => {
    const msg = "x".repeat(LOG_MESSAGE_CLAMP)
    expect(clampMessage(msg)).toBe(msg)
  })

  it("truncates past the limit and states how much was dropped", () => {
    const out = clampMessage("x".repeat(LOG_MESSAGE_CLAMP + 5))
    expect(out).toContain("…[+5 chars]")
    expect(out.startsWith("x".repeat(LOG_MESSAGE_CLAMP))).toBe(true)
  })
})

describe("toLogLines", () => {
  it("passes a single readline-delivered line through unchanged", () => {
    expect(toLogLines("one line")).toEqual(["one line"])
  })

  it("splits the multi-line spawn-error payload and drops blank lines", () => {
    expect(toLogLines("a\n\nb\r\nc")).toEqual(["a", "b", "c"])
  })

  it("returns nothing for whitespace-only payloads", () => {
    expect(toLogLines("  \n\n")).toEqual([])
  })

  it("caps a pathological payload", () => {
    const data = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n")
    expect(toLogLines(data, 10)).toHaveLength(10)
  })
})

describe("classifyAgentStderr", () => {
  it("promotes real fault markers to error", () => {
    expect(classifyAgentStderr("spawn ENOENT")).toBe("error")
    expect(classifyAgentStderr("Traceback (most recent call last)")).toBe("error")
    expect(classifyAgentStderr("FATAL: bad")).toBe("error")
  })

  it("floors ordinary noise at warn", () => {
    expect(classifyAgentStderr("downloading 40%")).toBe("warn")
    expect(classifyAgentStderr("DeprecationWarning: x")).toBe("warn")
  })
})

describe("mcpLogToLogEntry", () => {
  const mcp = (p: Partial<McpLogEntry>): McpLogEntry => ({
    id: "m1",
    ts: 5,
    level: "error",
    source: "stderr",
    message: "boom",
    ...p,
  })

  it("prefers the server name as origin and namespaces the row key", () => {
    const out = mcpLogToLogEntry(mcp({ server: "github" }))
    expect(out).toMatchObject({ id: "mcp:m1", channel: "mcp", origin: "github", level: "error" })
  })

  it("falls back to the MCP source when no server is attached", () => {
    expect(mcpLogToLogEntry(mcp({})).origin).toBe("stderr")
  })
})

describe("mergeLogSources", () => {
  const mcp = (id: string, ts: number): McpLogEntry => ({
    id,
    ts,
    level: "info",
    source: "stderr",
    message: `mcp${id}`,
  })

  it("interleaves both ascending streams by timestamp", () => {
    const logs = [entry({ ts: 1, message: "a" }), entry({ ts: 5, message: "c" })]
    const merged = mergeLogSources(logs, [mcp("x", 3), mcp("y", 9)])
    expect(merged.map((e) => e.ts)).toEqual([1, 3, 5, 9])
  })

  it("returns the unified buffer by reference when there are no MCP rows", () => {
    const logs = [entry()]
    expect(mergeLogSources(logs, [])).toBe(logs)
  })

  it("projects every MCP row when the unified buffer is empty", () => {
    const merged = mergeLogSources([], [mcp("x", 1), mcp("y", 2)])
    expect(merged).toHaveLength(2)
    expect(merged.every((e) => e.channel === "mcp")).toBe(true)
  })
})

describe("filterLogs", () => {
  const rows = [
    entry({ level: "error", channel: "mcp", origin: "github", message: "connect refused" }),
    entry({ level: "info", channel: "agent", origin: "rev", message: "listing tools" }),
    entry({ level: "warn", channel: "sidecar", message: "slow" }),
  ]

  it("returns the SAME reference when no filter is active (identity fast path)", () => {
    expect(filterLogs(rows, ALL)).toBe(rows)
  })

  it("filters by level", () => {
    expect(filterLogs(rows, { ...ALL, level: "error" })).toHaveLength(1)
  })

  it("filters by channel", () => {
    expect(filterLogs(rows, { ...ALL, channel: "agent" })).toHaveLength(1)
  })

  it("matches the query against message and origin, case-insensitively", () => {
    expect(filterLogs(rows, { ...ALL, query: "REFUSED" })).toHaveLength(1)
    expect(filterLogs(rows, { ...ALL, query: "github" })).toHaveLength(1)
  })

  it("preserves oldest→newest order", () => {
    const out = filterLogs(rows, { ...ALL, query: "s" })
    expect(out.map((e) => e.ts)).toEqual([...out].map((e) => e.ts).sort((a, b) => a - b))
  })
})

describe("logCounts / presentChannels", () => {
  const rows = [
    entry({ level: "error", channel: "mcp" }),
    entry({ level: "error", channel: "agent" }),
    entry({ level: "debug", channel: "agent" }),
  ]

  it("tallies levels and channels in one pass", () => {
    const c = logCounts(rows)
    expect(c.levels).toEqual({ error: 2, warn: 0, info: 0, debug: 1 })
    expect(c.channels).toEqual({ mcp: 1, agent: 2, sidecar: 0, system: 0 })
    expect(c.total).toBe(3)
  })

  it("lists only channels present, in stable order", () => {
    expect(presentChannels(rows)).toEqual(["mcp", "agent"])
    expect(presentChannels([])).toEqual([])
  })
})

describe("filter cycles", () => {
  it("cycles levels and wraps", () => {
    expect(nextLevelFilter("all")).toBe("error")
    expect(nextLevelFilter("debug")).toBe("all")
  })

  it("cycles only the channels present, and wraps", () => {
    const rows = [entry({ channel: "agent" }), entry({ channel: "system" })]
    expect(nextChannelFilter("all", rows)).toBe("agent")
    expect(nextChannelFilter("agent", rows)).toBe("system")
    expect(nextChannelFilter("system", rows)).toBe("all")
  })

  it("falls back to all when the active channel aged out of the buffer", () => {
    expect(nextChannelFilter("mcp", [entry({ channel: "agent" })])).toBe("all")
  })
})

describe("formatting", () => {
  it("describes every active filter dimension", () => {
    expect(describeLogFilter({ query: " x ", level: "error", channel: "mcp" }, 10, 2)).toBe(
      "2/10 · channel:mcp · level:error · “x”"
    )
    expect(describeLogFilter(ALL, 10, 10)).toBe("10/10")
  })

  it("labels the channel with and without an origin", () => {
    expect(channelLabel(entry({ channel: "mcp", origin: "github" }))).toBe("[mcp/github]")
    expect(channelLabel(entry({ channel: "sidecar" }))).toBe("[sidecar]")
  })

  it("formats a row and joins rows for copy", () => {
    const rows = [entry({ ts: 0, level: "error", channel: "mcp", message: "boom" })]
    expect(formatLogRowText(rows[0])).toContain("ERR [mcp] boom")
    expect(formatLogsForCopy(rows)).toBe(formatLogRowText(rows[0]))
  })
})

describe("buildLogInjection", () => {
  const rows = [entry({ message: "one" }), entry({ message: "two" })]

  it("fences the block and adds a lead-in when asked", () => {
    const inj = buildLogInjection(rows, { lead: true, scope: "level:error" })
    expect(inj.lead).toContain("level:error")
    expect(inj.body.startsWith("```text\n")).toBe(true)
    expect(inj.body.endsWith("\n```")).toBe(true)
    expect(inj.count).toBe(2)
  })

  it("omits the lead-in when the composer already has text", () => {
    expect(buildLogInjection(rows, { lead: false, scope: "s" }).lead).toBe("")
  })

  it("keeps the NEWEST rows and states the omission inside the fence", () => {
    const many = Array.from({ length: 10 }, (_, i) => entry({ message: `m${i}` }))
    const inj = buildLogInjection(many, { lead: false, scope: "s", max: 3 })
    expect(inj.count).toBe(3)
    expect(inj.body).toContain("… 7 earlier lines omitted")
    expect(inj.body).toContain("m9")
    expect(inj.body).not.toContain("m0 ")
  })
})

describe("composerInsertText", () => {
  it("inserts bare when the caret sits on empty text", () => {
    expect(composerInsertText("", "B")).toBe("B")
    expect(composerInsertText("   ", "B")).toBe("B")
  })

  it("breaks the line first when the caret sits mid-text", () => {
    expect(composerInsertText("why: ", "B")).toBe("\nB")
  })
})

describe("collapseLogBlock / nextLogPasteSeq", () => {
  it("leaves a small block inline", () => {
    const r = collapseLogBlock("a\nb", 0)
    expect(r.isLarge).toBe(false)
    expect(r.display).toBe("a\nb")
  })

  it("collapses a large block behind a NAMESPACED placeholder", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
    const r = collapseLogBlock(body, 3)
    expect(r.isLarge).toBe(true)
    // Namespaced so it can never collide with Input.tsx's own `#N` paste ids.
    expect(r.display).toBe("[Logs · 40 lines #log3]")
    expect(r.stored).toBe(body)
  })

  it("expands verbatim through the shared paste map (placeholder shape is a contract)", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
    const r = collapseLogBlock(body, 0)
    expect(expandPastes(`x ${r.display} y`, { [r.display]: r.stored })).toBe(`x ${body} y`)
  })

  it("picks the next free log paste id, ignoring foreign placeholders", () => {
    expect(nextLogPasteSeq({})).toBe(0)
    expect(nextLogPasteSeq({ "[Pasted 9 lines #7]": "x" })).toBe(0)
    expect(nextLogPasteSeq({ "[Logs · 9 lines #log4]": "x" })).toBe(5)
  })
})

describe("logInjectionActions — dispatch ORDER is load-bearing", () => {
  const rows = [entry({ message: "connect ECONNREFUSED" })]

  function seeded(text: string): TuiState {
    let s: TuiState = createInitialState(config, "ses1")
    s = tuiReducer(s, { type: "INPUT_SET", buffer: bufferFromText(text) })
    return tuiReducer(s, { type: "OVERLAY_OPEN", overlay: { kind: "logs" } })
  }

  it("closes the overlay and leaves the caret AFTER the injected text", () => {
    let s = seeded("look: ")
    for (const a of logInjectionActions({
      rows,
      scope: "level:error",
      beforeCaret: "look: ",
      pasteSeq: 0,
    })) {
      s = tuiReducer(s, a)
    }
    expect(s.overlay.kind).toBe("none")
    expect(bufferText(s.input.buffer)).toContain("ECONNREFUSED")
    // The regression that matters: NOT dragged back to row 0.
    expect(s.input.buffer.cursorRow).toBe(s.input.buffer.lines.length - 1)
  })

  it("would misplace the caret in the reverse order (documents the trap)", () => {
    // OVERLAY_CLOSE restores `savedCursor` whenever it is merely IN RANGE — which
    // it still is after an insert — so closing LAST yanks the caret to the front.
    const [close, ...rest] = logInjectionActions({
      rows,
      scope: "s",
      beforeCaret: "look: ",
      pasteSeq: 0,
    })
    let s = seeded("look: ")
    for (const a of [...rest, close]) s = tuiReducer(s, a)
    expect(s.input.buffer.cursorRow).toBe(0)
  })

  it("registers a paste entry only when the block is large", () => {
    const many = Array.from({ length: 40 }, (_, i) => entry({ message: `m${i}` }))
    const types = logInjectionActions({
      rows: many,
      scope: "s",
      beforeCaret: "",
      pasteSeq: 0,
    }).map((a) => a.type)
    expect(types).toEqual(["OVERLAY_CLOSE", "INPUT_ADD_PASTE", "INPUT_EDIT", "NOTICE"])

    const small = logInjectionActions({ rows, scope: "s", beforeCaret: "", pasteSeq: 0 })
    expect(small.map((a) => a.type)).toEqual(["OVERLAY_CLOSE", "INPUT_EDIT", "NOTICE"])
  })

  function inject(rowCount: number): TuiState {
    const many = Array.from({ length: rowCount }, (_, i) => entry({ message: `m${i}` }))
    let s = createInitialState(config, "ses1")
    s = tuiReducer(s, { type: "OVERLAY_OPEN", overlay: { kind: "logs" } })
    for (const a of logInjectionActions({ rows: many, scope: "s", beforeCaret: "", pasteSeq: 0 })) {
      s = tuiReducer(s, a)
    }
    return s
  }

  it("keeps the composer height INDEPENDENT of how many rows were injected", () => {
    // The composer renders every buffer line unwindowed (`Input.tsx`), so the
    // folded form must not scale with the row count — 200 raw rows would
    // otherwise render a 200-row composer and destroy the layout.
    const small = inject(40)
    const huge = inject(200)
    expect(huge.input.buffer.lines.length).toBe(small.input.buffer.lines.length)
    expect(huge.input.buffer.lines.length).toBeLessThanOrEqual(4)
    expect(bufferText(huge.input.buffer)).toContain("#log0")
    // …while the full text is preserved for submit-time expansion.
    expect(expandPastes(bufferText(huge.input.buffer), huge.input.pastes)).toContain("m199")
  })

  it("singularises the notice for a one-line injection", () => {
    const actions = logInjectionActions({ rows, scope: "s", beforeCaret: "", pasteSeq: 0 })
    expect(actions.at(-1)).toMatchObject({
      type: "NOTICE",
      message: "Added 1 log line to the composer.",
    })
  })
})

describe("footer hints", () => {
  // A wrapped footer would silently steal an item row and re-create the
  // clipped-cursor bug the row budget exists to prevent. 80 cols − border(2) −
  // paddingX(2) = 76.
  it("fits both rows within a narrow terminal without wrapping", () => {
    expect(LOG_PANEL_FOOTER_KEYS.length).toBeLessThanOrEqual(76)
    expect(LOG_PANEL_FOOTER_ACTIONS.length).toBeLessThanOrEqual(76)
  })
})
