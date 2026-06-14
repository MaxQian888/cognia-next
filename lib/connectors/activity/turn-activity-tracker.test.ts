import {
  createTurnActivityState,
  foldEvent,
  markEmitted,
  shouldEmit,
  summarizeForCard,
  THROTTLE_MS,
} from "./turn-activity-tracker"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

const T0 = 1_700_000_000_000

describe("createTurnActivityState", () => {
  it("initializes zeroed counters and empty edits", () => {
    const s = createTurnActivityState(T0)
    expect(s.toolCount).toBe(0)
    expect(s.editCount).toBe(0)
    expect(s.currentTool).toBeNull()
    expect(s.lastEmitAt).toBe(0)
    expect(s.edits).toEqual([])
    expect(s.turnStartedAt).toBe(T0)
  })
})

describe("foldEvent", () => {
  it("increments toolCount and sets currentTool on a tool-call", () => {
    const s = createTurnActivityState(T0)
    const r = foldEvent(s, { type: "tool-call", toolName: "bash", input: { command: "ls" } }, T0)
    expect(r).toEqual({ stateChanged: true, isToolBoundary: true })
    expect(s.toolCount).toBe(1)
    expect(s.currentTool).toBe("bash")
    expect(s.editCount).toBe(0)
  })

  it("extracts a file edit on an edit tool-call and bumps editCount", () => {
    const s = createTurnActivityState(T0)
    foldEvent(
      s,
      {
        type: "tool-call",
        toolName: "edit",
        input: { file_path: "a.ts", old_string: "x", new_string: "y" },
      },
      T0
    )
    expect(s.toolCount).toBe(1)
    expect(s.editCount).toBe(1)
    expect(s.edits).toHaveLength(1)
    expect(s.edits[0].filePath).toBe("a.ts")
    expect(s.edits[0].kind).toBe("edit")
  })

  it("counts a write tool as an edit", () => {
    const s = createTurnActivityState(T0)
    foldEvent(
      s,
      { type: "tool-call", toolName: "write", input: { file_path: "b.ts", content: "a\nb" } },
      T0
    )
    expect(s.editCount).toBe(1)
    expect(s.edits[0].kind).toBe("write")
    expect(s.edits[0].added).toBe(2)
  })

  it("does not count a non-edit tool-call as an edit", () => {
    const s = createTurnActivityState(T0)
    foldEvent(s, { type: "tool-call", toolName: "read", input: { file_path: "c.ts" } }, T0)
    expect(s.toolCount).toBe(1)
    expect(s.editCount).toBe(0)
    expect(s.edits).toEqual([])
  })

  it("marks a tool-result as a boundary without changing counts", () => {
    const s = createTurnActivityState(T0)
    foldEvent(s, { type: "tool-call", toolName: "bash", input: {} }, T0)
    const before = { toolCount: s.toolCount, editCount: s.editCount }
    const r = foldEvent(
      s,
      { type: "tool-result", toolName: "bash", result: "ok", isError: false },
      T0
    )
    expect(r).toEqual({ stateChanged: false, isToolBoundary: true })
    expect(s.toolCount).toBe(before.toolCount)
    expect(s.editCount).toBe(before.editCount)
  })

  it("ignores text/thinking/usage/compact for counts and boundaries", () => {
    const s = createTurnActivityState(T0)
    const cases: CaptureStreamEvent[] = [
      { type: "text-delta", delta: "hi" },
      { type: "thinking-delta", delta: "hmm" },
      { type: "usage", usage: { inputTokens: 1 } as never },
      { type: "compact", trigger: "auto", preTokens: 10, postTokens: 5 },
    ]
    for (const ev of cases) {
      const r = foldEvent(s, ev, T0)
      expect(r).toEqual({ stateChanged: false, isToolBoundary: false })
    }
    expect(s.toolCount).toBe(0)
  })
})

describe("shouldEmit", () => {
  it("emits on force regardless of state", () => {
    const s = createTurnActivityState(T0)
    expect(shouldEmit(s, T0, { isToolBoundary: false, force: true })).toBe(true)
  })

  it("emits on a tool boundary even within the throttle window", () => {
    const s = createTurnActivityState(T0)
    markEmitted(s, T0)
    expect(shouldEmit(s, T0 + 100, { isToolBoundary: true })).toBe(true)
  })

  it("does not emit a heartbeat within the throttle window", () => {
    const s = createTurnActivityState(T0)
    markEmitted(s, T0)
    expect(shouldEmit(s, T0 + THROTTLE_MS - 1, { isToolBoundary: false })).toBe(false)
  })

  it("emits a heartbeat once the throttle window elapses", () => {
    const s = createTurnActivityState(T0)
    markEmitted(s, T0)
    expect(shouldEmit(s, T0 + THROTTLE_MS, { isToolBoundary: false })).toBe(true)
  })

  it("emits the first heartbeat when lastEmitAt is 0", () => {
    const s = createTurnActivityState(T0)
    expect(shouldEmit(s, T0, { isToolBoundary: false })).toBe(true)
  })
})

describe("markEmitted", () => {
  it("stamps lastEmitAt", () => {
    const s = createTurnActivityState(T0)
    markEmitted(s, T0 + 5000)
    expect(s.lastEmitAt).toBe(T0 + 5000)
  })
})

describe("summarizeForCard", () => {
  it("produces a running snapshot with elapsed time and counts", () => {
    const s = createTurnActivityState(T0)
    foldEvent(s, { type: "tool-call", toolName: "bash", input: {} }, T0)
    foldEvent(
      s,
      {
        type: "tool-call",
        toolName: "edit",
        input: { file_path: "a.ts", old_string: "x", new_string: "yy" },
      },
      T0 + 100
    )
    const snap = summarizeForCard(s, "running", T0 + 4000)
    expect(snap.status).toBe("running")
    expect(snap.elapsedMs).toBe(4000)
    expect(snap.toolCount).toBe(2)
    expect(snap.editCount).toBe(1)
    expect(snap.currentTool).toBe("edit")
    expect(snap.edits).toHaveLength(1)
  })

  it("produces a done snapshot", () => {
    const s = createTurnActivityState(T0)
    const snap = summarizeForCard(s, "done", T0 + 2000)
    expect(snap.status).toBe("done")
    expect(snap.toolCount).toBe(0)
    expect(snap.currentTool).toBeNull()
  })

  it("returns a snapshot that does not share edits state by reference", () => {
    const s = createTurnActivityState(T0)
    foldEvent(
      s,
      {
        type: "tool-call",
        toolName: "edit",
        input: { file_path: "a.ts", old_string: "x", new_string: "y" },
      },
      T0
    )
    const snap = summarizeForCard(s, "running", T0)
    snap.edits[0].filePath = "mutated"
    expect(s.edits[0].filePath).toBe("a.ts")
  })
})
