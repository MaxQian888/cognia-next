/**
 * @jest-environment node
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import {
  __clearLiveSubagentsForTesting,
  applyLiveSubagentEvent,
  getLiveSubagent,
  listLiveSubagents,
  settleLiveSubagent,
  startLiveSubagent,
} from "./subagent-live-output"

beforeEach(() => __clearLiveSubagentsForTesting())

describe("startLiveSubagent", () => {
  it("seeds a running entry and mints a live id", () => {
    const id = startLiveSubagent({ name: "general-purpose", task: "do it", sessionId: "s1" })
    expect(id).toMatch(/^live-/)
    const entry = getLiveSubagent(id)
    expect(entry).toMatchObject({
      liveId: id,
      name: "general-purpose",
      task: "do it",
      sessionId: "s1",
      status: "running",
      text: "",
      thinking: "",
      tools: [],
      version: 0,
    })
    expect(typeof entry?.startedAt).toBe("number")
  })

  it("reuses a caller-supplied liveId (background runs pass their runId)", () => {
    const id = startLiveSubagent({ liveId: "bg-123", name: "x", task: "t", sessionId: "s1" })
    expect(id).toBe("bg-123")
    expect(getLiveSubagent("bg-123")?.liveId).toBe("bg-123")
  })

  it("honours a provided startedAt and truncates a long task", () => {
    const id = startLiveSubagent({
      name: "x",
      task: "p".repeat(500),
      sessionId: "s1",
      startedAt: 42,
    })
    const entry = getLiveSubagent(id)!
    expect(entry.startedAt).toBe(42)
    expect(entry.task.length).toBe(200)
  })
})

describe("applyLiveSubagentEvent", () => {
  const ev = <T extends CaptureStreamEvent>(e: T): CaptureStreamEvent => e

  it("appends text and thinking deltas and bumps version", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(id, ev({ type: "text-delta", delta: "hello " }))
    applyLiveSubagentEvent(id, ev({ type: "text-delta", delta: "world" }))
    applyLiveSubagentEvent(id, ev({ type: "thinking-delta", delta: "hmm" }))
    const entry = getLiveSubagent(id)!
    expect(entry.text).toBe("hello world")
    expect(entry.thinking).toBe("hmm")
    expect(entry.version).toBe(3)
  })

  it("ignores empty deltas and usage/compact without bumping version", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(id, ev({ type: "text-delta", delta: "" }))
    applyLiveSubagentEvent(id, ev({ type: "thinking-delta", delta: "" }))
    applyLiveSubagentEvent(
      id,
      ev({ type: "usage", usage: { inputTokens: 1, outputTokens: 2 } as never })
    )
    applyLiveSubagentEvent(
      id,
      ev({ type: "compact", trigger: "auto", preTokens: 1, postTokens: 0 })
    )
    expect(getLiveSubagent(id)!.version).toBe(0)
  })

  it("is a no-op for an unknown live id", () => {
    expect(() =>
      applyLiveSubagentEvent("nope", ev({ type: "text-delta", delta: "x" }))
    ).not.toThrow()
  })

  it("keeps only the trailing TEXT_CAP characters", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(id, ev({ type: "text-delta", delta: "a".repeat(199_999) }))
    applyLiveSubagentEvent(id, ev({ type: "text-delta", delta: "bbbb" }))
    const text = getLiveSubagent(id)!.text
    expect(text.length).toBe(200_000)
    expect(text.endsWith("bbbb")).toBe(true)
  })

  it("tracks a tool from call to result by id", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(id, ev({ type: "tool-call", toolName: "read", input: {}, id: "tu1" }))
    expect(getLiveSubagent(id)!.tools).toEqual([{ id: "tu1", name: "read", status: "running" }])
    applyLiveSubagentEvent(
      id,
      ev({ type: "tool-result", toolName: "read", id: "tu1", result: "ok" })
    )
    expect(getLiveSubagent(id)!.tools[0].status).toBe("done")
  })

  it("marks a tool result as error and resolves by name when id is absent", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(id, ev({ type: "tool-call", toolName: "bash", input: {} }))
    applyLiveSubagentEvent(
      id,
      ev({ type: "tool-result", toolName: "bash", result: "boom", isError: true })
    )
    expect(getLiveSubagent(id)!.tools[0].status).toBe("error")
  })

  it("ignores a tool-result that matches no tracked call", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(id, ev({ type: "tool-result", toolName: "ghost", result: "x" }))
    expect(getLiveSubagent(id)!.tools).toEqual([])
  })

  it("caps the tool list to the most recent TOOLS_CAP entries", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    for (let i = 0; i < 205; i++) {
      applyLiveSubagentEvent(
        id,
        ev({ type: "tool-call", toolName: `t${i}`, input: {}, id: `id${i}` })
      )
    }
    const tools = getLiveSubagent(id)!.tools
    expect(tools.length).toBe(200)
    expect(tools[tools.length - 1].name).toBe("t204")
    expect(tools[0].name).toBe("t5")
  })
})

describe("settleLiveSubagent", () => {
  const ev = <T extends CaptureStreamEvent>(e: T): CaptureStreamEvent => e

  it("sets status + settledAt and resolves a dangling running tool", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(
      id,
      ev<CaptureStreamEvent>({ type: "tool-call", toolName: "read", input: {}, id: "a" })
    )
    settleLiveSubagent(id, "done")
    const entry = getLiveSubagent(id)!
    expect(entry.status).toBe("done")
    expect(typeof entry.settledAt).toBe("number")
    expect(entry.tools[0].status).toBe("done")
  })

  it("resolves a dangling tool to error when the run errored", () => {
    const id = startLiveSubagent({ name: "x", task: "t", sessionId: "s1" })
    applyLiveSubagentEvent(
      id,
      ev<CaptureStreamEvent>({ type: "tool-call", toolName: "read", input: {}, id: "a" })
    )
    settleLiveSubagent(id, "error")
    expect(getLiveSubagent(id)!.tools[0].status).toBe("error")
  })

  it("is a no-op for an unknown live id", () => {
    expect(() => settleLiveSubagent("nope", "done")).not.toThrow()
  })
})

describe("isolation + listing + eviction", () => {
  it("scopes get/list by owner session", () => {
    const a = startLiveSubagent({ name: "a", task: "t", sessionId: "s1" })
    startLiveSubagent({ name: "b", task: "t", sessionId: "s2" })
    expect(getLiveSubagent(a, "s2")).toBeUndefined()
    expect(getLiveSubagent(a, "s1")?.name).toBe("a")
    expect(listLiveSubagents("s1").map((e) => e.name)).toEqual(["a"])
    expect(listLiveSubagents().length).toBe(2)
  })

  it("lists newest first by startedAt", () => {
    startLiveSubagent({ name: "old", task: "t", sessionId: "s1", startedAt: 1 })
    startLiveSubagent({ name: "new", task: "t", sessionId: "s1", startedAt: 2 })
    expect(listLiveSubagents("s1").map((e) => e.name)).toEqual(["new", "old"])
  })

  it("evicts settled entries beyond the retention cap but keeps running ones", () => {
    const ids: string[] = []
    for (let i = 0; i < 51; i++) {
      ids.push(startLiveSubagent({ name: `n${i}`, task: "t", sessionId: "s1", startedAt: i }))
    }
    const running = startLiveSubagent({ name: "live", task: "t", sessionId: "s1", startedAt: 999 })
    ids.forEach((id) => settleLiveSubagent(id, "done"))
    // The oldest-settled entry is evicted; 50 settled + the running one remain.
    expect(getLiveSubagent(ids[0])).toBeUndefined()
    expect(getLiveSubagent(ids[1])).toBeDefined()
    expect(getLiveSubagent(running)?.status).toBe("running")
    expect(listLiveSubagents("s1").length).toBe(51)
  })
})
