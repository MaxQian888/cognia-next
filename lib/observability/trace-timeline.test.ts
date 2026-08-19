import { makeSpan } from "./fixtures"
import {
  blockLabel,
  buildTraceTimeline,
  isZoomed,
  laneKeyFor,
  windowFromDrag,
} from "./trace-timeline"

/** Root model call with two tool children, one of which failed. */
function trace() {
  return [
    makeSpan({
      traceId: "t",
      spanId: "root",
      startTime: 1_000,
      durationMs: 1_000,
      operationName: "invoke_agent",
      agentName: "planner",
      responseModel: "opus",
      usage: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
      costUsdEstimate: 0.5,
      events: [{ name: "tool_call", at: 1_200 }],
    }),
    makeSpan({
      traceId: "t",
      spanId: "tool-a",
      parentSpanId: "root",
      startTime: 1_200,
      durationMs: 100,
      operationName: "execute_tool",
      toolName: "Bash",
      surface: "chat",
    }),
    makeSpan({
      traceId: "t",
      spanId: "tool-b",
      parentSpanId: "root",
      startTime: 1_500,
      durationMs: 0,
      operationName: "execute_tool",
      toolName: "Read",
      errorType: "ToolError",
      surface: "chat",
    }),
  ]
}

describe("buildTraceTimeline", () => {
  it("returns an inert timeline for no spans", () => {
    const tl = buildTraceTimeline([])
    expect(tl.lanes).toEqual([])
    expect(tl.totalMs).toBe(0)
    expect(tl.ticks).toEqual([])
  })

  it("groups by operation in flow order, not alphabetically", () => {
    const tl = buildTraceTimeline(trace())
    expect(tl.lanes.map((lane) => lane.id)).toEqual(["invoke_agent", "execute_tool"])
  })

  it("drops lanes that collected nothing", () => {
    const tl = buildTraceTimeline(trace())
    expect(tl.lanes.some((lane) => lane.id === "embeddings")).toBe(false)
  })

  it("rolls per-lane aggregates including overlap-aware busy time", () => {
    const tl = buildTraceTimeline(trace())
    const tools = tl.lanes.find((lane) => lane.id === "execute_tool")!
    expect(tools.spanCount).toBe(2)
    expect(tools.errorCount).toBe(1)
    expect(tools.busyMs).toBe(100)
    const model = tl.lanes.find((lane) => lane.id === "invoke_agent")!
    expect(model.costUsd).toBeCloseTo(0.5)
    expect(model.tokens).toBe(120)
  })

  it("places duration-scaled blocks proportionally", () => {
    const tl = buildTraceTimeline(trace(), { scale: "duration" })
    const root = tl.lanes[0].blocks[0]
    expect(root.offsetPct).toBe(0)
    expect(root.widthPct).toBe(100)
    const bash = tl.lanes[1].blocks.find((b) => b.spanId === "tool-a")!
    // starts 200ms into a 1000ms trace, runs 100ms
    expect(bash.offsetPct).toBeCloseTo(20)
    expect(bash.widthPct).toBeCloseTo(10)
  })

  it("gives a zero-duration span a hittable minimum width", () => {
    const tl = buildTraceTimeline(trace())
    const read = tl.lanes[1].blocks.find((b) => b.spanId === "tool-b")!
    expect(read.durationMs).toBe(0)
    expect(read.widthPct).toBeGreaterThan(0)
  })

  it("never lets a block overflow the right edge", () => {
    const tl = buildTraceTimeline([
      makeSpan({ spanId: "a", startTime: 0, durationMs: 100 }),
      makeSpan({ spanId: "b", startTime: 99, durationMs: 500 }),
    ])
    for (const lane of tl.lanes) {
      for (const block of lane.blocks) {
        expect(block.offsetPct + block.widthPct).toBeLessThanOrEqual(100.001)
      }
    }
  })

  it("gives every span an equal slot under the sequence scale", () => {
    const tl = buildTraceTimeline(trace(), { scale: "sequence" })
    const widths = tl.lanes.flatMap((lane) => lane.blocks.map((b) => b.widthPct))
    expect(new Set(widths.map((w) => w.toFixed(4))).size).toBe(1)
    const offsets = tl.lanes
      .flatMap((lane) => lane.blocks.map((b) => ({ id: b.spanId, offset: b.offsetPct })))
      .sort((a, b) => a.offset - b.offset)
    // Chronological order survives the reshuffle into lanes.
    expect(offsets.map((o) => o.id)).toEqual(["root", "tool-a", "tool-b"])
  })

  it("counts spans rather than time on the sequence ruler", () => {
    const tl = buildTraceTimeline(trace(), { scale: "sequence" })
    expect(tl.ticks[0].label).toBe("#1")
    expect(tl.ticks.at(-1)?.label).toBe("#3")
  })

  it("labels duration ticks relative to the trace start", () => {
    const tl = buildTraceTimeline(trace(), { scale: "duration", tickCount: 3 })
    expect(tl.ticks[0].label).toBe("0")
    expect(tl.ticks.at(-1)?.label).toBe("1.0s")
  })

  it("regroups by surface, model, and agent", () => {
    const spans = [
      makeSpan({ spanId: "a", surface: "chat", responseModel: "opus", agentName: "planner" }),
      makeSpan({ spanId: "b", surface: "workflow", responseModel: "haiku", agentName: "critic" }),
    ]
    expect(
      buildTraceTimeline(spans, { grouping: "surface" })
        .lanes.map((l) => l.id)
        .sort()
    ).toEqual(["chat", "workflow"])
    expect(
      buildTraceTimeline(spans, { grouping: "model" })
        .lanes.map((l) => l.id)
        .sort()
    ).toEqual(["haiku", "opus"])
    expect(
      buildTraceTimeline(spans, { grouping: "agent" })
        .lanes.map((l) => l.id)
        .sort()
    ).toEqual(["critic", "planner"])
  })

  it("drops spans outside the zoom window instead of clipping them", () => {
    const tl = buildTraceTimeline(trace(), { window: { since: 1_400, until: 2_000 } })
    const ids = tl.lanes.flatMap((lane) => lane.blocks.map((b) => b.spanId))
    expect(ids).toContain("tool-b")
    expect(ids).not.toContain("tool-a")
    expect(tl.spanCount).toBe(2) // root overlaps the window, tool-b starts inside it
  })

  it("normalizes a reversed window", () => {
    const tl = buildTraceTimeline(trace(), { window: { since: 2_000, until: 1_400 } })
    expect(tl.window).toEqual({ since: 1_400, until: 2_000 })
  })

  it("keeps the full trace bounds while zoomed", () => {
    const tl = buildTraceTimeline(trace(), { window: { since: 1_400, until: 1_600 } })
    expect(tl.traceStart).toBe(1_000)
    expect(tl.traceEnd).toBe(2_000)
    expect(tl.totalMs).toBe(1_000)
    expect(isZoomed(tl)).toBe(true)
    expect(isZoomed(buildTraceTimeline(trace()))).toBe(false)
  })

  it("projects mid-span events onto the axis where they happened", () => {
    const tl = buildTraceTimeline(trace())
    expect(tl.markers).toHaveLength(1)
    expect(tl.markers[0].name).toBe("tool_call")
    expect(tl.markers[0].offsetPct).toBeCloseTo(20)
  })

  it("computes nesting depth without looping on a cyclic parent chain", () => {
    const spans = [
      makeSpan({ spanId: "x", parentSpanId: "y", startTime: 1 }),
      makeSpan({ spanId: "y", parentSpanId: "x", startTime: 2 }),
    ]
    const tl = buildTraceTimeline(spans)
    for (const lane of tl.lanes) {
      for (const block of lane.blocks) expect(block.depth).toBeLessThan(64)
    }
  })

  it("totals errors, cost, and tokens across the trace", () => {
    const tl = buildTraceTimeline(trace())
    expect(tl.errorCount).toBe(1)
    expect(tl.costUsd).toBeCloseTo(0.5)
    expect(tl.tokens).toBe(120)
  })
})

describe("blockLabel", () => {
  it("prefers the tool name, then the agent, then the operation", () => {
    expect(blockLabel(makeSpan({ toolName: "Bash", agentName: "a" }))).toBe("Bash")
    expect(blockLabel(makeSpan({ agentName: "planner" }))).toBe("planner")
    expect(blockLabel(makeSpan({ operationName: "retrieval" }))).toBe("retrieval")
  })
})

describe("laneKeyFor", () => {
  it("falls back through model and agent identities", () => {
    expect(laneKeyFor(makeSpan({ requestModel: "sonnet" }), "model")).toBe("sonnet")
    expect(laneKeyFor(makeSpan({}), "model")).toBe("—")
    expect(laneKeyFor(makeSpan({ toolName: "Bash" }), "agent")).toBe("Bash")
  })
})

describe("windowFromDrag", () => {
  it("maps drag fractions onto absolute bounds", () => {
    const tl = buildTraceTimeline(trace())
    expect(windowFromDrag(tl, 0.2, 0.6)).toEqual({ since: 1_200, until: 1_600 })
  })

  it("accepts a backwards drag", () => {
    const tl = buildTraceTimeline(trace())
    expect(windowFromDrag(tl, 0.6, 0.2)).toEqual({ since: 1_200, until: 1_600 })
  })

  it("rejects a drag too small to be deliberate", () => {
    const tl = buildTraceTimeline(trace())
    expect(windowFromDrag(tl, 0.5, 0.505)).toBeNull()
  })

  it("returns null for a degenerate timeline", () => {
    expect(windowFromDrag(buildTraceTimeline([]), 0, 1)).toBeNull()
  })
})
