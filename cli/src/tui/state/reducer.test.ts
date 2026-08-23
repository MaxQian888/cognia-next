/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

import { createInitialState } from "./initial"
import { tuiReducer } from "./reducer"
import { externalCapabilities } from "../runtime/backend-capabilities"
import type { Cell, InputEditOp, ToolCell, TuiAction, TuiState } from "./types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

function base(): TuiState {
  return createInitialState(config, "ses1")
}

function reduce(state: TuiState, ...actions: TuiAction[]): TuiState {
  return actions.reduce(tuiReducer, state)
}

const result = (usage?: RunAndCaptureResult["usage"]): RunAndCaptureResult => ({
  text: "x",
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
  ...(usage ? { usage } : {}),
})

describe("tuiReducer — startup", () => {
  it("STARTUP_TRUST flips the phase to chat", () => {
    const start = createInitialState(config, "ses1", false)
    expect(start.phase).toBe("startup")
    expect(reduce(start, { type: "STARTUP_TRUST" }).phase).toBe("chat")
  })

  it("SET_CWD swaps the working directory", () => {
    const next = reduce(base(), { type: "SET_CWD", cwd: "/other" })
    expect(next.config.cwd).toBe("/other")
  })

  it("INPUT_SET snapshots the prior buffer for undo only on a text change", () => {
    const b0 = base()
    // Text change → pushes a snapshot.
    const typed = reduce(b0, {
      type: "INPUT_SET",
      buffer: { lines: ["hello"], cursorRow: 0, cursorCol: 5 },
    })
    expect(typed.input.undo).toHaveLength(1)
    expect(typed.input.undo[0].lines).toEqual([""])
    // Cursor-only move → no new snapshot.
    const moved = reduce(typed, {
      type: "INPUT_SET",
      buffer: { lines: ["hello"], cursorRow: 0, cursorCol: 2 },
    })
    expect(moved.input.undo).toHaveLength(1)
  })

  it("INPUT_SET avoids text comparison allocation when line references are unchanged", () => {
    const b0 = base()
    const join = jest.spyOn(Array.prototype, "join")
    try {
      reduce(b0, {
        type: "INPUT_SET",
        buffer: { lines: b0.input.buffer.lines, cursorRow: 0, cursorCol: 0 },
      })
      expect(join).not.toHaveBeenCalled()
    } finally {
      join.mockRestore()
    }
  })

  it("INPUT_UNDO/INPUT_REDO step the buffer back and forward", () => {
    let s = reduce(base(), {
      type: "INPUT_SET",
      buffer: { lines: ["a"], cursorRow: 0, cursorCol: 1 },
    })
    s = reduce(s, { type: "INPUT_SET", buffer: { lines: ["ab"], cursorRow: 0, cursorCol: 2 } })
    expect(s.input.buffer.lines).toEqual(["ab"])
    // Undo twice → back to empty.
    s = reduce(s, { type: "INPUT_UNDO" })
    expect(s.input.buffer.lines).toEqual(["a"])
    s = reduce(s, { type: "INPUT_UNDO" })
    expect(s.input.buffer.lines).toEqual([""])
    // Nothing left to undo → no-op.
    expect(reduce(s, { type: "INPUT_UNDO" })).toBe(s)
    // Redo replays forward.
    s = reduce(s, { type: "INPUT_REDO" })
    expect(s.input.buffer.lines).toEqual(["a"])
    s = reduce(s, { type: "INPUT_REDO" })
    expect(s.input.buffer.lines).toEqual(["ab"])
    expect(reduce(s, { type: "INPUT_REDO" })).toBe(s)
  })

  it("a fresh text edit clears the redo stack", () => {
    let s = reduce(base(), {
      type: "INPUT_SET",
      buffer: { lines: ["a"], cursorRow: 0, cursorCol: 1 },
    })
    s = reduce(s, { type: "INPUT_UNDO" })
    expect(s.input.redo).toHaveLength(1)
    s = reduce(s, { type: "INPUT_SET", buffer: { lines: ["z"], cursorRow: 0, cursorCol: 1 } })
    expect(s.input.redo).toHaveLength(0)
  })

  it("SET_STATUS_BAR merges the patch into config.statusBar", () => {
    const a = reduce(base(), { type: "SET_STATUS_BAR", statusBar: { theme: "dim" } })
    expect(a.config.statusBar).toEqual({ theme: "dim" })
    const b = reduce(a, { type: "SET_STATUS_BAR", statusBar: { segments: ["model", "mode"] } })
    expect(b.config.statusBar).toEqual({ theme: "dim", segments: ["model", "mode"] })
  })

  it("SET_MASCOT merges the patch into config.mascot", () => {
    const a = reduce(base(), { type: "SET_MASCOT", mascot: { style: "cat" } })
    expect(a.config.mascot).toEqual({ style: "cat" })
    const b = reduce(a, { type: "SET_MASCOT", mascot: { enabled: false } })
    expect(b.config.mascot).toEqual({ style: "cat", enabled: false })
  })

  it("SET_THEME sets config.theme and closes any overlay", () => {
    const a = reduce(base(), { type: "SET_THEME", theme: "dark" })
    expect(a.config.theme).toBe("dark")
    expect(a.overlay).toEqual({ kind: "none" })
    const b = reduce(a, { type: "SET_THEME", theme: "claude-code" })
    expect(b.config.theme).toBe("claude-code")
  })

  it("keeps config.theme across turn lifecycle actions", () => {
    const themed = reduce(base(), { type: "SET_THEME", theme: "dark" })
    const afterStart = reduce(themed, { type: "TURN_START", prompt: "hi" })
    expect(afterStart.config.theme).toBe("dark")
    const afterCommit = reduce(afterStart, { type: "TURN_COMMIT", result: result() })
    expect(afterCommit.config.theme).toBe("dark")
    const afterReset = reduce(afterCommit, { type: "RESET", sessionId: "ses2" })
    expect(afterReset.config.theme).toBe("dark")
  })

  it("SET_OUTPUT_STYLE sets config.outputStyle", () => {
    const a = reduce(base(), { type: "SET_OUTPUT_STYLE", style: "explanatory" })
    expect(a.config.outputStyle).toBe("explanatory")
    const b = reduce(a, { type: "SET_OUTPUT_STYLE", style: "default" })
    expect(b.config.outputStyle).toBe("default")
  })

  it("SET_LAYOUT sets config.layout and closes any overlay", () => {
    const a = reduce(base(), { type: "SET_LAYOUT", layout: "scrollback" })
    expect(a.config.layout).toBe("scrollback")
    expect(a.overlay).toEqual({ kind: "none" })
    const b = reduce(a, { type: "SET_LAYOUT", layout: "fullscreen" })
    expect(b.config.layout).toBe("fullscreen")
  })

  it("SET_MOUSE sets config.mouse and closes any overlay", () => {
    const a = reduce(base(), { type: "SET_MOUSE", mode: "scroll" })
    expect(a.config.mouse).toBe("scroll")
    expect(a.overlay).toEqual({ kind: "none" })
    const b = reduce(a, { type: "SET_MOUSE", mode: "select" })
    expect(b.config.mouse).toBe("select")
  })
})

describe("tuiReducer", () => {
  it("INFLIGHT_TEXT appends to inflight text", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "Hel" },
      { type: "INFLIGHT_TEXT", delta: "lo" }
    )
    expect(s.inflight.text).toBe("Hello")
  })

  it("bumps streamSeq on each live stream-activity delta", () => {
    const s0 = base()
    expect(s0.streamSeq).toBe(0)
    const s1 = reduce(s0, { type: "INFLIGHT_TEXT", delta: "a" })
    expect(s1.streamSeq).toBe(1)
    const s2 = reduce(s1, { type: "INFLIGHT_THINKING", delta: "t" })
    expect(s2.streamSeq).toBe(2)
    const s3 = reduce(s2, {
      type: "TOOL_CALL",
      callKey: "k1",
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(s3.streamSeq).toBe(3)
    const s4 = reduce(s3, {
      type: "TOOL_RESULT",
      callKey: "k1",
      toolName: "bash",
      result: "ok",
      isError: false,
    })
    expect(s4.streamSeq).toBe(4)
  })

  it("does not bump streamSeq for non-stream actions or no-op deltas", () => {
    const s0 = base()
    // TURN_START is lifecycle, not stream activity.
    const s1 = reduce(s0, { type: "TURN_START", prompt: "go" })
    expect(s1.streamSeq).toBe(0)
    // A duplicate TOOL_CALL for an already-running callKey is a no-op (state
    // unchanged) so the counter must not advance.
    const sCall = reduce(s1, {
      type: "TOOL_CALL",
      callKey: "dup",
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(sCall.streamSeq).toBe(1)
    const sDup = reduce(sCall, {
      type: "TOOL_CALL",
      callKey: "dup",
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(sDup).toBe(sCall)
    expect(sDup.streamSeq).toBe(1)
  })

  it("INFLIGHT_TEXT flushes pending reasoning to a thinking cell first", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_THINKING", delta: "pondering" },
      { type: "INFLIGHT_TEXT", delta: "answer" }
    )
    expect(s.cells).toHaveLength(1)
    expect(s.cells[0]).toMatchObject({ kind: "thinking", text: "pondering", collapsed: true })
    expect(s.inflight).toEqual({ text: "answer", thinking: "", tools: [] })
  })

  it("INFLIGHT_THINKING accumulates reasoning", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_THINKING", delta: "a" },
      { type: "INFLIGHT_THINKING", delta: "b" }
    )
    expect(s.inflight.thinking).toBe("ab")
  })

  it("TOOL_CALL commits inflight text then pushes a running tool to inflight.tools", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "before" },
      { type: "TOOL_CALL", callKey: "bash:{}", toolName: "bash", input: { command: "ls" } }
    )
    // The text before the tool is committed as an assistant cell; the tool cell
    // stays in inflight.tools (live area) so its status re-renders on TOOL_RESULT.
    expect(s.cells.map((c) => c.kind)).toEqual(["assistant"])
    expect(s.inflight.tools).toHaveLength(1)
    expect(s.inflight.tools[0]).toMatchObject({
      kind: "tool",
      toolName: "bash",
      status: "running",
      collapsed: true,
    })
    expect(s.inflight.text).toBe("")
  })

  it("TOOL_CALL for TodoWrite creates then updates a single todo cell", () => {
    let s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: "t1",
      toolName: "TodoWrite",
      input: { todos: [{ content: "step 1", status: "pending" }] },
    })
    expect(s.cells.filter((c) => c.kind === "todo")).toHaveLength(1)
    s = reduce(s, {
      type: "TOOL_CALL",
      callKey: "t2",
      toolName: "TodoWrite",
      input: { todos: [{ content: "step 1", status: "completed" }] },
    })
    const todoCells = s.cells.filter((c) => c.kind === "todo")
    expect(todoCells).toHaveLength(1)
    expect((todoCells[0] as { todos: unknown[] }).todos[0]).toMatchObject({ status: "completed" })
  })

  it("TOOL_RESULT fills the matching running tool in inflight.tools", () => {
    let s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: "k",
      toolName: "bash",
      input: { command: "ls" },
    })
    s = reduce(s, { type: "TOOL_RESULT", toolName: "bash", result: "file.txt", isError: false })
    // The tool cell stays in inflight.tools (live area) so the ✓ re-renders; it
    // is NOT yet moved to cells.
    const tool = s.inflight.tools.find((c) => c.callKey === "k") as ToolCell
    expect(tool.status).toBe("done")
    expect(tool.result).toBe("file.txt")
    expect(s.cells.find((c) => c.kind === "tool")).toBeUndefined()
  })

  it("TOOL_RESULT marks error status in inflight.tools", () => {
    let s = reduce(base(), { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} })
    s = reduce(s, { type: "TOOL_RESULT", toolName: "bash", result: "boom", isError: true })
    const tool = s.inflight.tools.find((c) => c.callKey === "k") as ToolCell
    expect(tool.status).toBe("error")
  })

  it("TOOL_RESULT is a no-op when no running tool matches", () => {
    const s0 = base()
    const s = reduce(s0, { type: "TOOL_RESULT", toolName: "bash", result: "x" })
    expect(s).toBe(s0)
  })

  it("TOOL_RESULT pairs by callKey when two same-name tools are running", () => {
    let s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: 'ls:{"path":"a"}',
      toolName: "ls",
      input: { path: "a" },
    })
    s = reduce(s, {
      type: "TOOL_CALL",
      callKey: 'ls:{"path":"b"}',
      toolName: "ls",
      input: { path: "b" },
    })
    // Result for the FIRST call (by callKey) must complete the first tool, not
    // the most-recent one. Tools are in inflight.tools (live area).
    s = reduce(s, {
      type: "TOOL_RESULT",
      toolName: "ls",
      callKey: 'ls:{"path":"a"}',
      input: { path: "a" },
      result: "a-listing",
    })
    const tools = s.inflight.tools
    expect(tools[0].status).toBe("done")
    expect(tools[0].result).toBe("a-listing")
    expect(tools[1].status).toBe("running")
  })

  it("TOOL_RESULT with an empty toolName still clears the oldest ⏳ in inflight.tools (fallback)", () => {
    // Reproduces the stuck-hourglass bug: a result whose tool_use id could not
    // be correlated arrives with toolName "" and no callKey. It must still
    // complete a running tool rather than hang.
    let s = reduce(base(), { type: "TOOL_CALL", callKey: "k", toolName: "read", input: { p: "x" } })
    s = reduce(s, { type: "TOOL_RESULT", toolName: "", result: "contents" })
    const tool = s.inflight.tools[0]
    expect(tool.status).toBe("done")
    expect(tool.result).toBe("contents")
  })

  it("TOOL_RESULT does NOT guess among several differently-named running tools", () => {
    // Hardening: a nameless/keyless result must not be mis-attached to the wrong
    // card when more than one distinct tool is in flight; it stays a no-op until
    // a name/key correlates it.
    let s = reduce(base(), { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} })
    s = reduce(s, { type: "TOOL_CALL", callKey: "k2", toolName: "read", input: {} })
    s = reduce(s, { type: "TOOL_RESULT", toolName: "", result: "ambiguous" })
    expect(s.inflight.tools.every((t) => t.status === "running")).toBe(true)
    // A correctly-named result still pairs to its tool.
    s = reduce(s, { type: "TOOL_RESULT", toolName: "read", result: "ok" })
    expect(s.inflight.tools.find((t) => t.toolName === "read")?.status).toBe("done")
    expect(s.inflight.tools.find((t) => t.toolName === "bash")?.status).toBe("running")
  })

  it("TOOL_RESULT whose key AND name both match nothing does NOT hijack the lone running tool", () => {
    // A late/duplicate keyed result (its own tool already resolved or it collided)
    // whose name also doesn't match must be dropped, not force-attached to
    // whatever single tool is in flight via the sole-running fallback.
    let s = reduce(base(), { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} })
    s = reduce(s, { type: "TOOL_RESULT", callKey: "k-stale", toolName: "glob", result: "wrong" })
    expect(s.inflight.tools[0].status).toBe("running")
    expect(s.inflight.tools[0].result).toBeUndefined()
  })

  it("TOOL_RESULT still pairs by name when only the callKey is stale (oldest same-name)", () => {
    // The name tier is the legitimate fallback: a result with a non-matching key
    // but a matching tool name pairs to the oldest running tool of that name.
    let s = reduce(base(), { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} })
    s = reduce(s, { type: "TOOL_RESULT", callKey: "k-stale", toolName: "bash", result: "ok" })
    expect(s.inflight.tools[0].status).toBe("done")
    expect(s.inflight.tools[0].result).toBe("ok")
  })

  it("two identical concurrent calls with distinct ids both render and pair to their own result", () => {
    // Same name + same input but distinct tool_use ids → distinct callKeys. The
    // dedup must NOT collapse them, and each result pairs to its own card.
    let s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: "tu_1",
      toolName: "read",
      input: { p: "x" },
    })
    s = reduce(s, { type: "TOOL_CALL", callKey: "tu_2", toolName: "read", input: { p: "x" } })
    expect(s.inflight.tools).toHaveLength(2)
    expect(s.toolStats.read.calls).toBe(2)
    s = reduce(s, { type: "TOOL_RESULT", callKey: "tu_2", toolName: "read", result: "second" })
    s = reduce(s, { type: "TOOL_RESULT", callKey: "tu_1", toolName: "read", result: "first" })
    expect(s.inflight.tools.find((t) => t.callKey === "tu_1")?.result).toBe("first")
    expect(s.inflight.tools.find((t) => t.callKey === "tu_2")?.result).toBe("second")
  })

  it("TURN_START pushes a user cell and enters streaming", () => {
    const s = reduce(base(), { type: "TURN_START", prompt: "do it" })
    expect(s.cells[0]).toMatchObject({ kind: "user", text: "do it" })
    expect(s.turnStatus).toBe("streaming")
  })

  it("TURN_COMMIT flushes inflight and records usage", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_THINKING", delta: "hmm" },
      { type: "INFLIGHT_TEXT", delta: "answer" },
      { type: "TURN_COMMIT", result: result({ inputTokens: 10, outputTokens: 5 }) }
    )
    expect(s.cells.map((c) => c.kind)).toEqual(["thinking", "assistant"])
    expect(s.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(s.turnStatus).toBe("idle")
  })

  it("TURN_COMMIT keeps a finished tool ABOVE the trailing answer text", () => {
    // Regression: the live Inflight frame renders running/finished tools above the
    // streaming text, but TURN_COMMIT used to append the leftover inflight tools
    // AFTER the committed text — flipping a finished tool card below the final
    // answer. The narration before the tool commits at TOOL_CALL; the text after
    // it streams into inflight and must stay below the tool at commit time.
    const s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "let me read it" },
      { type: "TOOL_CALL", callKey: "k", toolName: "read", input: { p: "x" } },
      { type: "TOOL_RESULT", callKey: "k", toolName: "read", result: "contents" },
      { type: "INFLIGHT_TEXT", delta: "the file says hi" },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(s.cells.map((c) => c.kind)).toEqual(["assistant", "tool", "assistant"])
    const tool = s.cells[1] as ToolCell
    expect(tool.status).toBe("done")
    expect((s.cells[0] as { raw: string }).raw).toBe("let me read it")
    expect((s.cells[2] as { raw: string }).raw).toBe("the file says hi")
    expect(s.inflight.tools).toEqual([])
  })

  it("TURN_COMMIT without usage leaves usage unset", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "a" },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(s.usage).toBeUndefined()
  })

  it("TURN_COMMIT captures a structured plan-mode reply as a PlanCell + lastPlan", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const s = reduce(
      planned,
      { type: "INFLIGHT_TEXT", delta: "# Plan\n- step one\n- step two" },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(s.cells.at(-1)).toMatchObject({ kind: "plan", raw: "# Plan\n- step one\n- step two" })
    expect(s.lastPlan).toMatchObject({ raw: "# Plan\n- step one\n- step two" })
    // The plan's seq matches the cell that carries it.
    expect(s.lastPlan?.seq).toBe(Number((s.cells.at(-1)!.id as string).slice(1)))
  })

  it("COMMIT_PLAN captures a programmatic plan (from /plan explore) as a PlanCell + lastPlan", () => {
    // Independent of permission mode — the pipeline can be kicked from any mode.
    const s = reduce(base(), { type: "COMMIT_PLAN", raw: "# Explored Plan\n1. a\n2. b" })
    expect(s.cells.at(-1)).toMatchObject({ kind: "plan", raw: "# Explored Plan\n1. a\n2. b" })
    expect(s.lastPlan).toMatchObject({ raw: "# Explored Plan\n1. a\n2. b" })
    expect(s.planCapturedThisTurn).toBe(true)
  })

  it("COMMIT_PLAN ignores an empty/whitespace plan body", () => {
    const s = reduce(base(), { type: "COMMIT_PLAN", raw: "   " })
    expect(s.lastPlan).toBeUndefined()
    expect(s.cells.some((c) => c.kind === "plan")).toBe(false)
  })

  it("TURN_COMMIT records the superseded plan as prevRaw on a revision", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const first = reduce(
      planned,
      { type: "INFLIGHT_TEXT", delta: "# Plan v1\n- step a\n- step b" },
      { type: "TURN_COMMIT", result: result() }
    )
    // The first plan supersedes nothing.
    expect(first.lastPlan).toMatchObject({ raw: "# Plan v1\n- step a\n- step b" })
    expect(first.lastPlan?.prevRaw).toBeUndefined()
    const second = reduce(
      first,
      { type: "INFLIGHT_TEXT", delta: "# Plan v2\n- step a\n- step c" },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(second.lastPlan).toMatchObject({
      raw: "# Plan v2\n- step a\n- step c",
      prevRaw: "# Plan v1\n- step a\n- step b",
    })
  })

  it("TURN_COMMIT in plan mode keeps a short clarifying reply as a normal cell", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const s = reduce(
      planned,
      { type: "INFLIGHT_TEXT", delta: "Which file first?" },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(s.cells.at(-1)).toMatchObject({ kind: "assistant" })
    expect(s.lastPlan).toBeUndefined()
  })

  it("TURN_COMMIT outside plan mode never captures a plan", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "# Plan\n- a\n- b" },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(s.cells.at(-1)).toMatchObject({ kind: "assistant" })
    expect(s.lastPlan).toBeUndefined()
  })

  it("TURN_COMMIT flushes thinking before a captured plan", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const s = reduce(
      planned,
      { type: "INFLIGHT_THINKING", delta: "reasoning" },
      { type: "INFLIGHT_TEXT", delta: "## Approach\n1. a\n2. b" },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(s.cells.map((c) => c.kind)).toEqual(["thinking", "plan"])
  })

  it.each(["ExitPlanMode", "exit_plan_mode", "mcp__cognia-tools__exit_plan_mode"])(
    "TOOL_CALL %s in plan mode captures the plan body as a PlanCell + lastPlan (no tool cell)",
    (toolName) => {
      const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
      const s = reduce(planned, {
        type: "TOOL_CALL",
        callKey: `${toolName}:1`,
        toolName,
        input: { plan: "# Plan\n- step one\n- step two" },
      })
      expect(s.cells.some((c) => c.kind === "tool")).toBe(false)
      expect(s.cells.at(-1)).toMatchObject({ kind: "plan", raw: "# Plan\n- step one\n- step two" })
      expect(s.lastPlan).toMatchObject({ raw: "# Plan\n- step one\n- step two" })
      expect(s.planCapturedThisTurn).toBe(true)
      expect(s.lastPlan?.seq).toBe(Number((s.cells.at(-1)!.id as string).slice(1)))
    }
  )

  it("TOOL_CALL ExitPlanMode commits prior narration text as an assistant cell, then the plan", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const s = reduce(
      planned,
      { type: "INFLIGHT_TEXT", delta: "Here is my proposed approach:" },
      {
        type: "TOOL_CALL",
        callKey: "ExitPlanMode:1",
        toolName: "ExitPlanMode",
        input: { plan: "- do a\n- do b" },
      }
    )
    expect(s.cells.map((c) => c.kind)).toEqual(["assistant", "plan"])
    expect(s.cells.at(-1)).toMatchObject({ kind: "plan", raw: "- do a\n- do b" })
  })

  it("TOOL_CALL ExitPlanMode then a structured TURN_COMMIT does NOT capture a second plan", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const s = reduce(
      planned,
      {
        type: "TOOL_CALL",
        callKey: "ExitPlanMode:1",
        toolName: "ExitPlanMode",
        input: { plan: "# Plan\n- a\n- b" },
      },
      { type: "INFLIGHT_TEXT", delta: "# Also a plan\n- x\n- y" },
      { type: "TURN_COMMIT", result: result() }
    )
    const planCells = s.cells.filter((c) => c.kind === "plan")
    expect(planCells).toHaveLength(1)
    expect(s.lastPlan?.raw).toBe("# Plan\n- a\n- b")
  })

  it("TOOL_CALL ExitPlanMode echoed twice in a turn captures the plan only once", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const call: TuiAction = {
      type: "TOOL_CALL",
      callKey: "ExitPlanMode:1",
      toolName: "ExitPlanMode",
      input: { plan: "# Plan\n- a\n- b" },
    }
    const s = reduce(planned, call, call)
    expect(s.cells.filter((c) => c.kind === "plan")).toHaveLength(1)
  })

  it("TOOL_CALL ExitPlanMode outside plan mode renders a normal tool cell in inflight.tools (no plan)", () => {
    const s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: "ExitPlanMode:1",
      toolName: "ExitPlanMode",
      input: { plan: "# Plan\n- a\n- b" },
    })
    // Tool goes to inflight.tools (not cells) — no plan capture outside plan mode.
    expect(s.cells.some((c) => c.kind === "tool")).toBe(false)
    expect(s.inflight.tools[0]).toMatchObject({ kind: "tool", toolName: "ExitPlanMode" })
    expect(s.lastPlan).toBeUndefined()
  })

  it("TOOL_CALL ExitPlanMode with malformed input falls through to a tool cell in inflight.tools", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const s = reduce(planned, {
      type: "TOOL_CALL",
      callKey: "ExitPlanMode:1",
      toolName: "ExitPlanMode",
      input: { notAPlan: true },
    })
    // Malformed input → no plan body → treat as normal tool.
    expect(s.cells.some((c) => c.kind === "tool")).toBe(false)
    expect(s.inflight.tools[0]).toMatchObject({ kind: "tool", toolName: "ExitPlanMode" })
    expect(s.lastPlan).toBeUndefined()
  })

  it("TURN_COMMIT in plan mode does not capture a structured clarifying question", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const s = reduce(
      planned,
      // Structured (two bullets → looksLikePlan) but interrogative.
      {
        type: "INFLIGHT_TEXT",
        delta: "Before I proceed, which of these?\n- option a\n- option b",
      },
      { type: "TURN_COMMIT", result: result() }
    )
    expect(s.cells.at(-1)).toMatchObject({ kind: "assistant" })
    expect(s.lastPlan).toBeUndefined()
  })

  it("TURN_START clears planCapturedThisTurn", () => {
    const planned = reduce(base(), { type: "SET_MODE", mode: "plan" })
    const captured = reduce(planned, {
      type: "TOOL_CALL",
      callKey: "ExitPlanMode:1",
      toolName: "ExitPlanMode",
      input: { plan: "# Plan\n- a\n- b" },
    })
    expect(captured.planCapturedThisTurn).toBe(true)
    const next = reduce(captured, { type: "TURN_START", prompt: "go" })
    expect(next.planCapturedThisTurn).toBe(false)
  })

  it("TURN_ERROR appends an error cell", () => {
    const s = reduce(base(), { type: "TURN_ERROR", message: "boom" })
    expect(s.cells.at(-1)).toMatchObject({ kind: "error", message: "boom" })
    expect(s.turnStatus).toBe("idle")
  })

  it("TURN_ABORTED cancels running tools and appends a neutral interruption notice", () => {
    const s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "agent", toolName: "dispatch_agent", input: {} },
      { type: "INFLIGHT_TEXT", delta: "partial" },
      { type: "TURN_ABORTED" }
    )
    expect(s.cells.map((c) => c.kind)).toEqual(["tool", "assistant", "notice"])
    expect(s.cells[0]).toMatchObject({
      kind: "tool",
      status: "cancelled",
      result: "Cancelled by user.",
    })
    expect(s.cells.at(-1)).toMatchObject({
      message: "Turn stopped by user.",
      tone: "interrupted",
    })
  })

  it("moves an immediate interruption marker behind the settled partial turn", () => {
    const s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "agent", toolName: "dispatch_agent", input: {} },
      {
        type: "NOTICE",
        message: "Turn stopped by user.",
        tone: "interrupted",
      },
      { type: "INFLIGHT_TEXT", delta: "partial" },
      { type: "TURN_ABORTED" }
    )
    expect(s.cells.map((cell) => cell.kind)).toEqual(["tool", "assistant", "notice"])
    expect(s.cells.filter((cell) => cell.kind === "notice")).toHaveLength(1)
    expect(s.cells.at(-1)).toMatchObject({ tone: "interrupted" })
  })

  it("TURN_ERROR never commits a still-running tool", () => {
    const s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "read", toolName: "read", input: {} },
      { type: "TURN_ERROR", message: "provider disconnected" }
    )
    expect(s.cells[0]).toMatchObject({
      kind: "tool",
      status: "error",
      isError: true,
      result: "Turn ended before this tool completed: provider disconnected",
    })
  })

  it("TOGGLE_COLLAPSE flips tool and thinking cells but ignores others", () => {
    let s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "a" },
      { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k", toolName: "bash", result: "ok" },
      { type: "TURN_COMMIT", result: result() }
    )
    const toolCell = s.cells.find((c) => c.kind === "tool") as ToolCell
    expect(toolCell.collapsed).toBe(true)
    s = reduce(s, { type: "TOGGLE_COLLAPSE", id: toolCell.id })
    const toggled = s.cells.find((c) => c.id === toolCell.id) as ToolCell
    expect(toggled.collapsed).toBe(false)
    // Unknown id → unchanged.
    const s2 = reduce(s, { type: "TOGGLE_COLLAPSE", id: "nope" })
    expect(s2.cells).toEqual(s.cells)
  })

  it("TOGGLE_COLLAPSE leaves a matched non-collapsible cell unchanged", () => {
    const s = reduce(base(), { type: "TURN_START", prompt: "hi" })
    const userId = s.cells[0].id
    const s2 = reduce(s, { type: "TOGGLE_COLLAPSE", id: userId })
    expect(s2.cells[0]).toEqual(s.cells[0])
  })

  it("TOOL_CALL ignores a repeated emission for the same running tool (no duplicate tools)", () => {
    let s = reduce(base(), { type: "INFLIGHT_TEXT", delta: "let me look" })
    s = reduce(s, { type: "TOOL_CALL", callKey: "ls:.", toolName: "ls", input: { path: "." } })
    const toolCount = s.inflight.tools.length
    // A repeated tool-call for the same still-running invocation is a no-op:
    // no second tool cell, and the inflight text is not re-committed.
    s = reduce(s, { type: "TOOL_CALL", callKey: "ls:.", toolName: "ls", input: { path: "." } })
    s = reduce(s, { type: "TOOL_CALL", callKey: "ls:.", toolName: "ls", input: { path: "." } })
    expect(s.inflight.tools.length).toBe(toolCount)
    expect(s.cells.filter((c) => c.kind === "assistant").length).toBe(1)
  })

  it("TOOL_CALL enriches a repeated canonical snapshot without adding another card", () => {
    let s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: "tu-1",
      toolName: "Read",
      input: {},
    })
    s = reduce(s, {
      type: "TOOL_CALL",
      callKey: "tu-1",
      toolName: "Read",
      input: { path: "README.md" },
      displayTitle: "Read README.md",
    })

    expect(s.inflight.tools).toHaveLength(1)
    expect(s.inflight.tools[0]).toMatchObject({
      callKey: "tu-1",
      input: { path: "README.md" },
      displayTitle: "Read README.md",
      status: "running",
    })
  })

  it("TOOL_CALL ignores a repeated snapshot after the correlated result settled", () => {
    let s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "tu-1", toolName: "Read", input: {} },
      { type: "TOOL_RESULT", callKey: "tu-1", toolName: "Read", result: "done" }
    )
    s = reduce(s, {
      type: "TOOL_CALL",
      callKey: "tu-1",
      toolName: "Read",
      input: { path: "README.md" },
    })

    expect(s.inflight.tools).toHaveLength(1)
    expect(s.inflight.tools[0]).toMatchObject({
      callKey: "tu-1",
      input: { path: "README.md" },
      status: "done",
      result: "done",
    })
  })

  it("TOOL_CALL flushes completed tools to cells, preserving text→tool→text order", () => {
    // Simulate: text → tool A → result A → text → tool B
    let s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "Let me check" },
      { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k1", toolName: "bash", result: "done" }
    )
    // A is done in inflight.tools, text after A accumulates.
    s = reduce(s, { type: "INFLIGHT_TEXT", delta: "Now reading" })
    // Tool B arrives — A(done) is flushed to cells BEFORE the new text.
    s = reduce(s, { type: "TOOL_CALL", callKey: "k2", toolName: "read", input: {} })
    const kinds = s.cells.map((c) => c.kind)
    // Order: assistant("Let me check"), bash(done), assistant("Now reading")
    expect(kinds).toEqual(["assistant", "tool", "assistant"])
    expect((s.cells[1] as ToolCell).status).toBe("done")
    expect(s.inflight.tools).toHaveLength(1) // only B (running)
    expect(s.inflight.tools[0].toolName).toBe("read")
  })

  it("TURN_COMMIT flushes inflight.tools BEFORE the trailing inflight text", () => {
    let s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "before" },
      { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k", toolName: "bash", result: "ok" },
      { type: "INFLIGHT_TEXT", delta: "after" }
    )
    // Before commit: tool is done in inflight.tools, text is in inflight.text.
    expect(s.inflight.tools).toHaveLength(1)
    expect(s.inflight.tools[0].status).toBe("done")
    expect(s.inflight.text).toBe("after")
    s = reduce(s, { type: "TURN_COMMIT", result: result() })
    // After commit the chronological order is preserved (matching the live
    // Inflight frame, which renders tools above the streaming text): "before"
    // committed at TOOL_CALL, then the finished bash tool, then the trailing
    // "after" text — NOT text-then-tool.
    expect(s.cells.map((c) => c.kind)).toEqual(["assistant", "tool", "assistant"])
    expect((s.cells[1] as ToolCell).status).toBe("done")
    expect((s.cells[0] as { raw: string }).raw).toBe("before")
    expect((s.cells[2] as { raw: string }).raw).toBe("after")
    expect(s.inflight.tools).toEqual([])
    expect(s.inflight.text).toBe("")
  })

  it("TOGGLE_COLLAPSE_ALL expands/collapses tool cells that are committed to cells", () => {
    // Tools now live in inflight.tools during the turn; they are committed to
    // cells only at TURN_COMMIT or the next TOOL_CALL. Simulate a completed turn
    // so the tool cell is in cells for the collapse toggle to reach it.
    let s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "looking" },
      { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k1", toolName: "bash", result: "ok" },
      { type: "TOOL_CALL", callKey: "k2", toolName: "read", input: {} },
      { type: "TOOL_RESULT", callKey: "k2", toolName: "read", result: "ok" }
    )
    // The second TOOL_CALL flushed the first (completed) tool to cells.
    // The second tool is still running in inflight.tools.
    const cellTools = s.cells.filter((c) => c.kind === "tool")
    expect(cellTools.length).toBeGreaterThanOrEqual(1)
    expect(cellTools.every((c) => (c as ToolCell).collapsed)).toBe(true)
    // Expand all.
    s = reduce(s, { type: "TOGGLE_COLLAPSE_ALL" })
    const expanded = s.cells.filter((c) => c.kind === "tool")
    expect(expanded.every((c) => (c as ToolCell).collapsed === false)).toBe(true)
    // Collapse all again.
    s = reduce(s, { type: "TOGGLE_COLLAPSE_ALL" })
    const recollapsed = s.cells.filter((c) => c.kind === "tool")
    expect(recollapsed.every((c) => (c as ToolCell).collapsed)).toBe(true)
  })

  it("TOGGLE_COLLAPSE_ALL expands all when the state is mixed (any collapsed → reveal)", () => {
    // Simulate a completed turn so tools are committed to cells (via TURN_COMMIT).
    let s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "ok" },
      { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k1", toolName: "bash", result: "ok" },
      { type: "TOOL_CALL", callKey: "k2", toolName: "read", input: {} },
      { type: "TOOL_RESULT", callKey: "k2", toolName: "read", result: "ok" },
      { type: "TURN_COMMIT", result: result() }
    )
    const cellTools = s.cells.filter((c) => c.kind === "tool") as ToolCell[]
    expect(cellTools.length).toBe(2)
    // Expand only the first → mixed state.
    s = reduce(s, { type: "TOGGLE_COLLAPSE", id: cellTools[0].id })
    expect((s.cells.find((c) => c.id === cellTools[0].id) as ToolCell).collapsed).toBe(false)
    expect((s.cells.find((c) => c.id === cellTools[1].id) as ToolCell).collapsed).toBe(true)
    // Any collapsed → expand all.
    s = reduce(s, { type: "TOGGLE_COLLAPSE_ALL" })
    expect(
      s.cells.filter((c) => c.kind === "tool").every((c) => (c as ToolCell).collapsed === false)
    ).toBe(true)
  })

  it("TOGGLE_COLLAPSE_ALL bumps the render epoch (forces a Static re-print)", () => {
    let s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "a" },
      { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k", toolName: "bash", result: "ok" },
      { type: "TURN_COMMIT", result: result() }
    )
    const before = s.renderEpoch
    s = reduce(s, { type: "TOGGLE_COLLAPSE_ALL" })
    expect(s.renderEpoch).toBe(before + 1)
  })

  it("TOGGLE_VERBOSE flips verbose and bumps the render epoch", () => {
    const s0 = base()
    expect(s0.verbose).toBe(false)
    const s1 = reduce(s0, { type: "TOGGLE_VERBOSE" })
    expect(s1.verbose).toBe(true)
    expect(s1.renderEpoch).toBe(s0.renderEpoch + 1)
    const s2 = reduce(s1, { type: "TOGGLE_VERBOSE" })
    expect(s2.verbose).toBe(false)
    expect(s2.renderEpoch).toBe(s1.renderEpoch + 1)
  })

  it("REPAINT bumps the render epoch without touching cells", () => {
    const s0 = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "x" },
      { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k", toolName: "bash", result: "ok" },
      { type: "TURN_COMMIT", result: result() }
    )
    const s1 = reduce(s0, { type: "REPAINT" })
    expect(s1.renderEpoch).toBe(s0.renderEpoch + 1)
    expect(s1.cells).toBe(s0.cells)
  })

  it("BACKTRACK_ENTER selects the last user cell; no-op without one", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "q1" },
      { id: "2", kind: "assistant", raw: "a1" },
      { id: "3", kind: "user", text: "q2" },
    ]
    const s = reduce({ ...base(), cells }, { type: "BACKTRACK_ENTER" })
    expect(s.backtrack).toEqual({ index: 2 })
    // No user cells → unchanged (no backtrack state).
    const empty = reduce(base(), { type: "BACKTRACK_ENTER" })
    expect(empty.backtrack).toBeUndefined()
  })

  it("BACKTRACK_MOVE walks between user cells and clamps at the ends", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "q1" },
      { id: "2", kind: "assistant", raw: "a1" },
      { id: "3", kind: "user", text: "q2" },
    ]
    const start = { ...base(), cells, backtrack: { index: 2 } }
    const up = reduce(start, { type: "BACKTRACK_MOVE", dir: -1 })
    expect(up.backtrack).toEqual({ index: 0 })
    // Already at the earliest → clamp (no further user cell).
    const clampUp = reduce(up, { type: "BACKTRACK_MOVE", dir: -1 })
    expect(clampUp.backtrack).toEqual({ index: 0 })
    const down = reduce(up, { type: "BACKTRACK_MOVE", dir: 1 })
    expect(down.backtrack).toEqual({ index: 2 })
    // Move without an active selection is a no-op.
    expect(
      reduce({ ...base(), cells }, { type: "BACKTRACK_MOVE", dir: -1 }).backtrack
    ).toBeUndefined()
  })

  it("BACKTRACK_COMMIT sets the edit target and clears the selection", () => {
    const s0 = { ...base(), backtrack: { index: 1 } }
    const s1 = reduce(s0, { type: "BACKTRACK_COMMIT", index: 1 })
    expect(s1.backtrack).toBeUndefined()
    expect(s1.editTarget).toEqual({ index: 1 })
  })

  it("BACKTRACK_CANCEL and EDIT_CLEAR drop their respective state", () => {
    const cancelled = reduce({ ...base(), backtrack: { index: 0 } }, { type: "BACKTRACK_CANCEL" })
    expect(cancelled.backtrack).toBeUndefined()
    const cleared = reduce({ ...base(), editTarget: { index: 0 } }, { type: "EDIT_CLEAR" })
    expect(cleared.editTarget).toBeUndefined()
  })

  it("bumps renderEpoch on every backtrack selection change (scrollback repaint)", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "q1" },
      { id: "2", kind: "assistant", raw: "a1" },
      { id: "3", kind: "user", text: "q2" },
    ]
    // ENTER bumps (a highlight appears).
    const entered = reduce({ ...base(), cells }, { type: "BACKTRACK_ENTER" })
    expect(entered.renderEpoch).toBe(base().renderEpoch + 1)
    // MOVE bumps (the highlight relocates).
    const moved = reduce(entered, { type: "BACKTRACK_MOVE", dir: -1 })
    expect(moved.renderEpoch).toBe(entered.renderEpoch + 1)
    // CANCEL bumps (the highlight disappears).
    const cancelled = reduce(moved, { type: "BACKTRACK_CANCEL" })
    expect(cancelled.renderEpoch).toBe(moved.renderEpoch + 1)
    // COMMIT bumps (highlight gone, message loaded for edit).
    const committed = reduce(entered, { type: "BACKTRACK_COMMIT", index: 2 })
    expect(committed.renderEpoch).toBe(entered.renderEpoch + 1)
  })

  it("does NOT bump renderEpoch on a no-op backtrack action", () => {
    // ENTER with no user cell, MOVE/CANCEL with no active selection — all no-ops.
    const noEnter = reduce(base(), { type: "BACKTRACK_ENTER" })
    expect(noEnter.renderEpoch).toBe(base().renderEpoch)
    const noMove = reduce(base(), { type: "BACKTRACK_MOVE", dir: -1 })
    expect(noMove.renderEpoch).toBe(base().renderEpoch)
    const noCancel = reduce(base(), { type: "BACKTRACK_CANCEL" })
    expect(noCancel.renderEpoch).toBe(base().renderEpoch)
  })

  it("OVERLAY_MOVE navigates a files completion list", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "files", token: "@s", completions: ["src/", "spec/"], index: 0 },
    })
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(1)
  })

  it("NOTICE appends a notice cell", () => {
    const s = reduce(base(), { type: "NOTICE", message: "Pushed" })
    expect(s.cells.at(-1)).toMatchObject({ kind: "notice", message: "Pushed" })
  })

  it("COMPACT_BOUNDARY appends a formatted notice cell", () => {
    const s = reduce(base(), {
      type: "COMPACT_BOUNDARY",
      trigger: "manual",
      preTokens: 45_000,
      postTokens: 8_000,
    })
    expect(s.cells.at(-1)).toMatchObject({
      kind: "notice",
      message: "⊟ Context compacted (manual): 45k → 8.0k tokens (−82%)",
    })
  })

  it("LOAD_CELLS replaces the transcript", () => {
    const cells: Cell[] = [{ id: "r0", kind: "user", text: "hi" }]
    const s = reduce(base(), { type: "LOAD_CELLS", cells })
    expect(s.cells).toEqual(cells)
  })

  it("RESET clears cells and adopts a new session id", () => {
    let s = reduce(
      base(),
      { type: "NOTICE", message: "x" },
      { type: "TURN_COMMIT", result: result({ inputTokens: 1 }) }
    )
    s = reduce(s, { type: "RESET", sessionId: "ses2" })
    expect(s.sessionId).toBe("ses2")
    expect(s.cells).toEqual([])
    expect(s.usage).toBeUndefined()
  })

  it("SET_INIT_DRAFT stages a pending instruction-file change", () => {
    const s = reduce(base(), {
      type: "SET_INIT_DRAFT",
      target: "/work/AGENTS.md",
      content: "# new body",
    })
    expect(s.initDraft).toEqual({ target: "/work/AGENTS.md", content: "# new body" })
  })

  it("CLEAR_INIT_DRAFT drops the staged change", () => {
    let s = reduce(base(), {
      type: "SET_INIT_DRAFT",
      target: "/work/AGENTS.md",
      content: "# body",
    })
    s = reduce(s, { type: "CLEAR_INIT_DRAFT" })
    expect(s.initDraft).toBeUndefined()
  })

  it("RESET clears a staged init draft", () => {
    let s = reduce(base(), {
      type: "SET_INIT_DRAFT",
      target: "/work/AGENTS.md",
      content: "# body",
    })
    s = reduce(s, { type: "RESET", sessionId: "ses2" })
    expect(s.initDraft).toBeUndefined()
  })

  it("SET_COMMIT_DRAFT / CLEAR_COMMIT_DRAFT stage and drop a pending commit message", () => {
    let s = reduce(base(), { type: "SET_COMMIT_DRAFT", message: "feat: x" })
    expect(s.commitDraft).toEqual({ message: "feat: x" })
    s = reduce(s, { type: "CLEAR_COMMIT_DRAFT" })
    expect(s.commitDraft).toBeUndefined()
  })

  it("SET_PR_DRAFT / CLEAR_PR_DRAFT stage and drop a pending PR draft", () => {
    let s = reduce(base(), { type: "SET_PR_DRAFT", title: "feat: x", body: "b", base: "master" })
    expect(s.prDraft).toEqual({ title: "feat: x", body: "b", base: "master" })
    s = reduce(s, { type: "CLEAR_PR_DRAFT" })
    expect(s.prDraft).toBeUndefined()
  })

  it("RESET clears staged commit + PR drafts", () => {
    let s = reduce(base(), { type: "SET_COMMIT_DRAFT", message: "feat: x" })
    s = reduce(s, { type: "SET_PR_DRAFT", title: "t", body: "b", base: "master" })
    s = reduce(s, { type: "RESET", sessionId: "ses3" })
    expect(s.commitDraft).toBeUndefined()
    expect(s.prDraft).toBeUndefined()
  })

  it("SET_MODEL and SET_MODE update config and close the overlay", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "model", options: ["a"], index: 0, query: "" },
    })
    s = reduce(s, { type: "SET_MODEL", model: "claude-x" })
    expect(s.config.model).toBe("claude-x")
    expect(s.overlay.kind).toBe("none")
    s = reduce(s, { type: "SET_MODE", mode: "plan" })
    expect(s.config.permissionMode).toBe("plan")
  })

  it("SET_MODEL also remembers the model under the ACTIVE provider", () => {
    const start = reduce(base(), { type: "SET_PROVIDER", provider: "deepseek" })
    const s = reduce(start, { type: "SET_MODEL", model: "deepseek-reasoner" })
    expect(s.config.providers.deepseek?.model).toBe("deepseek-reasoner")
    expect(s.config.model).toBe("deepseek-reasoner")
  })

  describe("model routing on an external backend", () => {
    /** `--backend codex`, connected and resolved to the native app-server. */
    const onCodex = (): TuiState => {
      const started = createInitialState({ ...config, agentBackend: "codex" }, "ses1")
      return reduce(started, {
        type: "BACKEND_CONNECT_OK",
        capabilities: externalCapabilities({ backend: "codex", presetId: "codex-app-server" }),
      })
    }

    it("SET_MODEL stores the pick under the backend, NOT the chat provider", () => {
      const s = reduce(onCodex(), { type: "SET_MODEL", model: "gpt-5.6-sol" })
      expect(s.config.agentBackends?.["codex-app-server"]?.model).toBe("gpt-5.6-sol")
      expect(s.config.model).toBe("gpt-5.6-sol")
      // Choosing a Codex model must not rewrite what the built-in sidecar runs.
      expect(s.config.providers[s.config.provider]?.model).toBeUndefined()
    })

    it("uses Codex's authoritative usage window for post-5.4 models", () => {
      const selected = reduce(onCodex(), { type: "SET_MODEL", model: "gpt-5.6-sol" })
      const s = reduce(selected, {
        type: "SET_USAGE",
        usage: { inputTokens: 100_000, outputTokens: 2_000, contextWindow: 272_000 },
      })
      expect(s.modelMeta).toMatchObject({
        modelId: "gpt-5.6-sol",
        contextWindow: 272_000,
        runtime: true,
      })
    })

    it("does not let a late catalog fallback overwrite Codex's live window", () => {
      const selected = reduce(onCodex(), { type: "SET_MODEL", model: "gpt-5.6-sol" })
      const reported = reduce(selected, {
        type: "SET_USAGE",
        usage: { inputTokens: 100_000, outputTokens: 2_000, contextWindow: 272_000 },
      })
      const s = reduce(reported, {
        type: "SET_MODEL_META",
        meta: {
          modelId: "gpt-5.6-sol",
          contextWindow: 128_000,
          pricing: { promptPer1M: 3 },
        },
      })
      expect(s.modelMeta).toEqual({
        modelId: "gpt-5.6-sol",
        contextWindow: 272_000,
        pricing: { promptPer1M: 3 },
        runtime: true,
      })
    })

    it("SET_PROVIDER does not re-point the model back at the built-in provider", () => {
      // Switching the chat provider while Codex answers used to overwrite
      // `config.model` with the built-in catalog default — which was then both
      // displayed as, and sent to, Codex as the model it was running.
      const s = reduce(onCodex(), { type: "SET_PROVIDER", provider: "deepseek" })
      expect(s.config.provider).toBe("deepseek")
      expect(s.config.model).toBeUndefined()
    })

    it("BACKEND_CONNECT_OK re-resolves the model under the launched preset", () => {
      // A model remembered for `codex-app-server` is unreachable at mount (only
      // the typed alias is known), so the connect result must re-resolve it.
      const started = createInitialState(
        {
          ...config,
          agentBackend: "codex",
          agentBackends: { "codex-app-server": { model: "gpt-5.6-sol" } },
        },
        "ses1"
      )
      expect(started.config.model).toBeUndefined()
      const s = reduce(started, {
        type: "BACKEND_CONNECT_OK",
        capabilities: externalCapabilities({ backend: "codex", presetId: "codex-app-server" }),
      })
      expect(s.config.model).toBe("gpt-5.6-sol")
    })
  })

  it("BACKEND_CAPABILITIES_UPDATE replaces only the live capability projection", () => {
    const initial = base()
    const capabilities = externalCapabilities({
      backend: "codex",
      presetId: "codex-app-server",
      toolHost: {
        attachable: true,
        running: true,
        builtinToolCount: 12,
        hostToolCount: 3,
        subagentDispatch: true,
      },
    })

    const next = reduce(initial, { type: "BACKEND_CAPABILITIES_UPDATE", capabilities })

    expect(next.backendCapabilities).toBe(capabilities)
    expect(next.phase).toBe(initial.phase)
    expect(next.config).toBe(initial.config)
  })

  it("SET_PROVIDER re-points the displayed model to the new provider (no stale bleed)", () => {
    // Anthropic with a Claude model, then switch to deepseek: the model must
    // follow the provider, not stay on the Claude id.
    let s = reduce(base(), { type: "SET_PROVIDER", provider: "anthropic" })
    s = reduce(s, { type: "SET_MODEL", model: "claude-opus-4-8" })
    s = reduce(s, { type: "SET_PROVIDER", provider: "deepseek" })
    expect(s.config.provider).toBe("deepseek")
    expect(s.config.model).not.toBe("claude-opus-4-8")
    // Switching back to anthropic restores its remembered model.
    s = reduce(s, { type: "SET_PROVIDER", provider: "anthropic" })
    expect(s.config.model).toBe("claude-opus-4-8")
  })

  it("SET_THINKING updates the thinking level and closes the overlay", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "effortSlider", off: false, index: 2 },
    })
    s = reduce(s, { type: "SET_THINKING", level: "high" })
    expect(s.config.thinkingLevel).toBe("high")
    expect(s.overlay.kind).toBe("none")
  })

  it("SET_THINKING with pluginTools couples the ultracode tier to the workflow gate", () => {
    let s = reduce(base(), { type: "SET_THINKING", level: "ultracode", pluginTools: true })
    expect(s.config.thinkingLevel).toBe("ultracode")
    expect(s.config.pluginTools).toBe(true)
    // Switching away turns the gate back off (coupled).
    s = reduce(s, { type: "SET_THINKING", level: "high", pluginTools: false })
    expect(s.config.thinkingLevel).toBe("high")
    expect(s.config.pluginTools).toBe(false)
  })

  it("SET_THINKING without pluginTools leaves the gate untouched", () => {
    const s0 = reduce(base(), { type: "SET_THINKING", level: "max", pluginTools: true })
    const s1 = reduce(s0, { type: "SET_THINKING", level: "low" })
    expect(s1.config.pluginTools).toBe(true)
  })

  it("OVERLAY_OPEN / CLOSE toggle the overlay", () => {
    let s = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    expect(s.overlay.kind).toBe("help")
    s = reduce(s, { type: "OVERLAY_CLOSE" })
    expect(s.overlay.kind).toBe("none")
  })

  it("closes only the matching remotely resolved permission", () => {
    const request = {
      type: "permission_request" as const,
      sessionId: "session-a",
      requestId: "request-a",
      toolUseID: "tool-a",
      toolName: "bash",
      input: {},
    }
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "permission", req: request, choices: [], index: 0 },
    })
    s = reduce(s, { type: "REMOTE_PERMISSION_RESOLVED", requestId: "request-b" })
    expect(s.overlay.kind).toBe("permission")
    s = reduce(s, { type: "REMOTE_PERMISSION_RESOLVED", requestId: "request-a" })
    expect(s.overlay.kind).toBe("none")
  })

  it("applies completed limits only while the same panel is still open", () => {
    const limits = {
      kind: "limits" as const,
      snapshots: [],
      loading: true,
      requestId: 7,
      analysis: {
        turns: 0,
        highContextTurns: 0,
        highContextPct: 0,
        highContextThreshold: 150_000,
        dispatchCalls: 0,
        totalToolCalls: 0,
        topTools: [],
      },
      now: 1,
    }
    let s = reduce(base(), { type: "OVERLAY_OPEN", overlay: limits })
    s = reduce(s, { type: "LIMITS_LOADED", requestId: 7, snapshots: [] })
    expect(s.overlay).toMatchObject({ kind: "limits", loading: false })

    s = reduce(s, { type: "OVERLAY_CLOSE" })
    const closed = reduce(s, { type: "LIMITS_LOADED", requestId: 7, snapshots: [] })
    expect(closed.overlay.kind).toBe("none")
  })

  it("ignores a completed limits refresh from an older request", () => {
    const current = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "limits",
        snapshots: [],
        loading: true,
        requestId: 2,
        analysis: {
          turns: 0,
          highContextTurns: 0,
          highContextPct: 0,
          highContextThreshold: 150_000,
          dispatchCalls: 0,
          totalToolCalls: 0,
          topTools: [],
        },
        now: 1,
      },
    })
    const next = reduce(current, { type: "LIMITS_LOADED", requestId: 1, snapshots: [] })
    expect(next).toBe(current)
  })

  it("MCP_STATUS_PATCH updates one server's live status in the mcp panel", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "mcp",
        probing: true,
        servers: [
          { name: "a", transport: "http", enabled: true, status: "pending" },
          { name: "b", transport: "stdio", enabled: true, status: "pending" },
        ],
      },
    })
    s = reduce(s, {
      type: "MCP_STATUS_PATCH",
      name: "a",
      patch: { status: "connected", toolCount: 4 },
    })
    const overlay = s.overlay as Extract<typeof s.overlay, { kind: "mcp" }>
    expect(overlay.servers[0]).toMatchObject({ status: "connected", toolCount: 4 })
    expect(overlay.servers[1].status).toBe("pending")
    expect(overlay.probing).toBe(true)
  })

  it("MCP_STATUS_PATCH clears the probing spinner on the final patch", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "mcp",
        probing: true,
        servers: [{ name: "a", transport: "http", enabled: true, status: "pending" }],
      },
    })
    s = reduce(s, {
      type: "MCP_STATUS_PATCH",
      name: "a",
      patch: { status: "failed" },
      doneProbing: true,
    })
    const overlay = s.overlay as Extract<typeof s.overlay, { kind: "mcp" }>
    expect(overlay.probing).toBe(false)
  })

  it("MCP_STATUS_PATCH is a no-op when the mcp panel isn't open", () => {
    const s = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    const after = reduce(s, { type: "MCP_STATUS_PATCH", name: "a", patch: { status: "connected" } })
    expect(after.overlay.kind).toBe("help")
  })

  it("SKILL_ROW_TOGGLE flips one skill's enabled badge", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "skills",
        rows: [
          { id: "a", name: "A", origin: null, enabled: false, errorCount: 0 },
          { id: "b", name: "B", origin: null, enabled: true, errorCount: 0 },
        ],
      },
    })
    s = reduce(s, { type: "SKILL_ROW_TOGGLE", id: "a" })
    const overlay = s.overlay as Extract<typeof s.overlay, { kind: "skills" }>
    expect(overlay.rows[0].enabled).toBe(true)
    expect(overlay.rows[1].enabled).toBe(true)
  })

  it("SKILL_ROW_TOGGLE is a no-op when the skills panel isn't open", () => {
    const s = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    const after = reduce(s, { type: "SKILL_ROW_TOGGLE", id: "a" })
    expect(after.overlay.kind).toBe("help")
  })

  it("SKILL_ROWS_SET_MANY flips a batch of badges (全开全关)", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "skills",
        rows: [
          { id: "a", name: "A", origin: null, enabled: false, errorCount: 0 },
          { id: "b", name: "B", origin: null, enabled: false, errorCount: 0 },
          { id: "c", name: "C", origin: null, enabled: true, errorCount: 0 },
        ],
      },
    })
    s = reduce(s, { type: "SKILL_ROWS_SET_MANY", ids: ["a", "b"], enabled: true })
    const overlay = s.overlay as Extract<typeof s.overlay, { kind: "skills" }>
    expect(overlay.rows.map((r) => r.enabled)).toEqual([true, true, true])
  })

  it("SKILL_ROWS_SET_MANY is a no-op when the skills panel isn't open", () => {
    const s = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    const after = reduce(s, { type: "SKILL_ROWS_SET_MANY", ids: ["a"], enabled: false })
    expect(after.overlay.kind).toBe("help")
  })

  it("OVERLAY_OPEN replaces only the body when re-opening a same-title document", () => {
    const first = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "Workflow · Nightly", body: "v1", format: "markdown" },
    })
    const refreshed = reduce(first, {
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "Workflow · Nightly", body: "v2", format: "markdown" },
    })
    expect(refreshed.overlay).toMatchObject({
      kind: "document",
      title: "Workflow · Nightly",
      body: "v2",
    })
  })

  it("OVERLAY_OPEN replaces fully when the document title differs", () => {
    const first = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "A", body: "v1", format: "markdown" },
    })
    const second = reduce(first, {
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "B", body: "v2", format: "markdown" },
    })
    expect(second.overlay).toMatchObject({ title: "B", body: "v2" })
  })

  it("OVERLAY_OPEN snapshots the composer cursor and OVERLAY_CLOSE restores it", () => {
    const s0 = reduce(base(), {
      type: "INPUT_SET",
      buffer: { lines: ["hello world"], cursorRow: 0, cursorCol: 5 },
    })
    const opened = reduce(s0, { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    expect(opened.input.savedCursor).toEqual({ row: 0, col: 5 })
    // Simulate Ink resetting the cursor to the buffer end while the overlay owns
    // input, then close: the saved cursor is restored and the snapshot cleared.
    const moved = reduce(opened, {
      type: "INPUT_SET",
      buffer: { lines: ["hello world"], cursorRow: 0, cursorCol: 11 },
    })
    const closed = reduce(moved, { type: "OVERLAY_CLOSE" })
    expect(closed.input.buffer.cursorCol).toBe(5)
    expect(closed.input.savedCursor).toBeUndefined()
  })

  it("OVERLAY_CLOSE drops the saved cursor when it no longer fits the buffer", () => {
    const s0 = reduce(base(), {
      type: "INPUT_SET",
      buffer: { lines: ["hello world"], cursorRow: 0, cursorCol: 8 },
    })
    const opened = reduce(s0, { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    // The buffer text shrank while the overlay was open → the saved col is now
    // out of range, so the snapshot is discarded rather than restored.
    const shrunk = reduce(opened, {
      type: "INPUT_SET",
      buffer: { lines: ["hi"], cursorRow: 0, cursorCol: 2 },
    })
    const closed = reduce(shrunk, { type: "OVERLAY_CLOSE" })
    expect(closed.input.buffer.cursorCol).toBe(2)
    expect(closed.input.savedCursor).toBeUndefined()
  })

  it("OVERLAY_MOVE wraps within a movable list and no-ops otherwise", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "mode", options: ["default", "plan", "acceptEdits"], index: 0 },
    })
    s = reduce(s, { type: "OVERLAY_MOVE", delta: -1 })
    expect((s.overlay as { index: number }).index).toBe(2) // wrapped
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0)
    // help overlay has no list → move is a no-op.
    const help = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    expect(reduce(help, { type: "OVERLAY_MOVE", delta: 1 })).toBe(help)
  })

  it("OVERLAY_MOVE wraps the five-choice plan-approval overlay", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "plan", raw: "# Plan", index: 0 },
    })
    // Five choices: approve-auto, approve-confirm, approve-new-session,
    // edit-then-approve, keep.
    for (let i = 1; i <= 4; i++) {
      s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
      expect((s.overlay as { index: number }).index).toBe(i)
    }
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0) // wraps past the 5th choice
    s = reduce(s, { type: "OVERLAY_CLOSE" })
    expect(s.overlay.kind).toBe("none")
  })

  it("OVERLAY_SET_INDEX clamps to the list bounds and no-ops for non-lists", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "model", options: ["a", "b"], index: 0, query: "" },
    })
    s = reduce(s, { type: "OVERLAY_SET_INDEX", index: 9 })
    expect((s.overlay as { index: number }).index).toBe(1)
    const usage = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
    expect(reduce(usage, { type: "OVERLAY_SET_INDEX", index: 3 })).toBe(usage)
  })

  it("OVERLAY_REFRESH_MODEL_OPTIONS swaps the live list and keeps the selected id", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "model",
        options: ["anthropic/claude-sonnet-4", "openai/gpt-5"],
        index: 1,
        query: "",
      },
    })
    // Live catalog lands with a superset; the selected id ("openai/gpt-5") moves.
    s = reduce(s, {
      type: "OVERLAY_REFRESH_MODEL_OPTIONS",
      options: ["aaa/free", "openai/gpt-5", "anthropic/claude-sonnet-4", "zzz/big"],
    })
    expect(s.overlay).toEqual({
      kind: "model",
      options: ["aaa/free", "openai/gpt-5", "anthropic/claude-sonnet-4", "zzz/big"],
      index: 1,
      query: "",
    })
  })

  it("OVERLAY_REFRESH_MODEL_OPTIONS clamps to 0 when the selected id is gone", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "model", options: ["old/model"], index: 0, query: "" },
    })
    s = reduce(s, { type: "OVERLAY_REFRESH_MODEL_OPTIONS", options: ["new/a", "new/b"] })
    expect((s.overlay as { index: number }).index).toBe(0)
    expect((s.overlay as { options: string[] }).options).toEqual(["new/a", "new/b"])
  })

  it("OVERLAY_REFRESH_MODEL_OPTIONS no-ops when the model overlay is not open or list is empty", () => {
    const usage = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
    expect(reduce(usage, { type: "OVERLAY_REFRESH_MODEL_OPTIONS", options: ["a"] })).toBe(usage)
    const model = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "model", options: ["a"], index: 0, query: "" },
    })
    expect(reduce(model, { type: "OVERLAY_REFRESH_MODEL_OPTIONS", options: [] })).toBe(model)
  })

  it("OVERLAY_MODEL_QUERY filters the picker and resets the highlight to the top", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "model",
        options: ["anthropic/claude-opus", "anthropic/claude-sonnet", "openai/gpt-5"],
        index: 2,
        query: "",
      },
    })
    s = reduce(s, { type: "OVERLAY_MODEL_QUERY", query: "claude" })
    expect(s.overlay).toEqual({
      kind: "model",
      options: ["anthropic/claude-opus", "anthropic/claude-sonnet", "openai/gpt-5"],
      index: 0,
      query: "claude",
    })
    // Navigation now ranges over the filtered view (2 claude rows), not all 3.
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(1)
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0) // wraps past the 2nd match
  })

  it("OVERLAY_MODEL_QUERY no-ops when the model overlay is not open", () => {
    const usage = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
    expect(reduce(usage, { type: "OVERLAY_MODEL_QUERY", query: "x" })).toBe(usage)
  })

  it("OVERLAY_QUERY filters a generic select overlay and resets the highlight", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        title: "Plugins",
        items: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
          { id: "c", label: "Gamma" },
        ],
        index: 2,
      },
    })
    s = reduce(s, { type: "OVERLAY_QUERY", query: "beta" })
    expect((s.overlay as { query: string }).query).toBe("beta")
    expect((s.overlay as { index: number }).index).toBe(0)
    // Navigation now ranges over the single filtered row (wraps to itself).
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0)
  })

  it("OVERLAY_QUERY filters sessions, inspect and quickActions overlays", () => {
    const sessions = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "sessions",
        items: [
          { sessionId: "1", title: "login bug", turns: 1, updatedAt: 0 },
          { sessionId: "2", title: "dark mode", turns: 1, updatedAt: 0 },
        ],
        index: 1,
      },
    })
    const sAfter = reduce(sessions, { type: "OVERLAY_QUERY", query: "dark" })
    expect((sAfter.overlay as { query: string }).query).toBe("dark")
    expect((sAfter.overlay as { index: number }).index).toBe(0)

    const quick = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "quickActions",
        rows: [
          { id: "model", label: "Model", hint: "opus", command: "/model" },
          { id: "diff", label: "Git diff", hint: "changes", command: "/diff" },
        ],
        index: 0,
      },
    })
    const qAfter = reduce(quick, { type: "OVERLAY_QUERY", query: "diff" })
    expect((qAfter.overlay as { query: string }).query).toBe("diff")
  })

  it("OVERLAY_QUERY no-ops for an overlay kind without typeahead", () => {
    const usage = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
    expect(reduce(usage, { type: "OVERLAY_QUERY", query: "x" })).toBe(usage)
  })

  it("OVERLAY_QUERY filters the provider picker and navigates the filtered view", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "provider",
        options: [
          {
            id: "anthropic",
            name: "Anthropic",
            configured: true,
            auth: "api key",
            requiresKey: true,
          },
          {
            id: "openai",
            name: "OpenAI",
            configured: false,
            auth: "no credential",
            requiresKey: true,
          },
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: false,
            auth: "no credential",
            requiresKey: true,
          },
        ],
        index: 2,
      },
    })
    s = reduce(s, { type: "OVERLAY_QUERY", query: "open" })
    expect((s.overlay as { query: string }).query).toBe("open")
    // Highlight resets to the top of the 2 "open*" matches.
    expect((s.overlay as { index: number }).index).toBe(0)
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(1)
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0) // wraps past the 2nd match
  })

  it("SET_PROVIDER_CREDENTIAL merges the secret into the provider config without touching the overlay", () => {
    const opened = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "providerKey",
        providerId: "openai",
        providerName: "OpenAI",
        credentialKind: "apiKey",
        value: "sk-live",
        reveal: false,
      },
    })
    const s = reduce(opened, {
      type: "SET_PROVIDER_CREDENTIAL",
      providerId: "openai",
      credentialKind: "apiKey",
      secret: "sk-live",
    })
    expect(s.config.providers.openai?.apiKey).toBe("sk-live")
    // The overlay is left for the caller's follow-up switch to close.
    expect(s.overlay.kind).toBe("providerKey")
  })

  it("SET_PROVIDER_CREDENTIAL preserves the other credential kind for the provider", () => {
    const withKey = reduce(base(), {
      type: "SET_PROVIDER_CREDENTIAL",
      providerId: "opencode",
      credentialKind: "apiKey",
      secret: "k",
    })
    const withBoth = reduce(withKey, {
      type: "SET_PROVIDER_CREDENTIAL",
      providerId: "opencode",
      credentialKind: "authToken",
      secret: "tok",
    })
    expect(withBoth.config.providers.opencode).toMatchObject({ apiKey: "k", authToken: "tok" })
  })

  it("OVERLAY_PROVIDER_KEY_INPUT sets the value and clears any error; REVEAL toggles masking", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "providerKey",
        providerId: "openai",
        providerName: "OpenAI",
        credentialKind: "apiKey",
        value: "",
        reveal: false,
        error: "Enter a key, or press Esc to cancel.",
      },
    })
    s = reduce(s, { type: "OVERLAY_PROVIDER_KEY_INPUT", value: "sk-1" })
    expect(s.overlay).toMatchObject({ kind: "providerKey", value: "sk-1", error: undefined })
    s = reduce(s, { type: "OVERLAY_PROVIDER_KEY_REVEAL" })
    expect((s.overlay as { reveal: boolean }).reveal).toBe(true)
    s = reduce(s, { type: "OVERLAY_PROVIDER_KEY_REVEAL" })
    expect((s.overlay as { reveal: boolean }).reveal).toBe(false)
  })

  it("OVERLAY_PROVIDER_KEY_ERROR surfaces a validation error on the prompt", () => {
    const opened = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "providerKey",
        providerId: "openai",
        providerName: "OpenAI",
        credentialKind: "apiKey",
        value: "",
        reveal: false,
      },
    })
    const s = reduce(opened, { type: "OVERLAY_PROVIDER_KEY_ERROR", error: "nope" })
    expect((s.overlay as { error?: string }).error).toBe("nope")
  })

  it("the provider-key actions no-op unless the prompt overlay is open", () => {
    const usage = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
    expect(reduce(usage, { type: "OVERLAY_PROVIDER_KEY_INPUT", value: "x" })).toBe(usage)
    expect(reduce(usage, { type: "OVERLAY_PROVIDER_KEY_REVEAL" })).toBe(usage)
    expect(reduce(usage, { type: "OVERLAY_PROVIDER_KEY_ERROR", error: "e" })).toBe(usage)
  })

  it("MARKETPLACE_PATCH_ENTRY updates one entry's badge in the open browser", () => {
    const s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "marketplace",
        entries: [
          { installRef: "a/x", name: "Alpha", installed: true, enabled: true },
          { installRef: "b/y", name: "Beta", installed: true, enabled: true },
        ],
      },
    })
    const after = reduce(s, {
      type: "MARKETPLACE_PATCH_ENTRY",
      ref: "a/x",
      patch: { enabled: false },
    })
    const entries = (after.overlay as { entries: { installRef: string; enabled: boolean }[] })
      .entries
    expect(entries[0].enabled).toBe(false)
    expect(entries[1].enabled).toBe(true)
  })

  it("MARKETPLACE_PATCH_ENTRY is a no-op when the marketplace isn't open", () => {
    const usage = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
    expect(reduce(usage, { type: "MARKETPLACE_PATCH_ENTRY", ref: "a/x", patch: {} })).toBe(usage)
  })

  it("OVERLAY_REFRESH_MODEL_OPTIONS keeps the selected id across a refresh while filtered", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "model",
        options: ["a/claude-opus", "a/claude-sonnet", "b/gpt"],
        index: 1,
        query: "claude",
      },
    })
    // Selected id is the 2nd claude match ("a/claude-sonnet"); after a refresh it
    // sits at a new position in the freshly-filtered superset.
    s = reduce(s, {
      type: "OVERLAY_REFRESH_MODEL_OPTIONS",
      options: ["a/claude-haiku", "a/claude-sonnet", "a/claude-opus", "b/gpt"],
    })
    expect((s.overlay as { index: number }).index).toBe(1) // claude-sonnet among 3 claude matches
    expect((s.overlay as { query: string }).query).toBe("claude")
  })

  it("OVERLAY_MOVE no-ops on an empty list", () => {
    const s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "sessions", items: [], index: 0 },
    })
    expect(reduce(s, { type: "OVERLAY_MOVE", delta: 1 })).toBe(s)
  })

  it("OVERLAY_MOVE navigates a generic select overlay", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        title: "Workflows",
        items: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        index: 0,
        onSelectCommand: "workflow run",
      },
    })
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(1)
  })

  it("OVERLAY_MOVE navigates the inspect overlay", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "inspect",
        items: [
          { cellId: "1", label: "✓ read", summary: "/a.ts", lines: 3, isError: false },
          { cellId: "2", label: "! ls", summary: "shell", lines: 0, isError: false },
        ],
        index: 0,
      },
    })
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(1)
    // Wraps back to the top.
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0)
  })

  it("TOOL_CALL respects collapseToolsByDefault=false (tools start expanded)", () => {
    const cfg: ResolvedConfig = { ...config, render: { collapseToolsByDefault: false } }
    const s = reduce(createInitialState(cfg, "ses1"), {
      type: "TOOL_CALL",
      callKey: "k",
      toolName: "bash",
      input: { command: "ls" },
    })
    const tool = s.inflight.tools[0]
    expect(tool.collapsed).toBe(false)
  })

  it("FORM_UPDATE replaces the active form, and no-ops when no form is open", () => {
    const form = {
      title: "/mcp add",
      commandName: "mcp",
      subcommand: "add",
      fields: [{ spec: { name: "name", label: "Name", type: "string" as const }, value: "" }],
      activeField: 0,
    }
    let s = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "form", form } })
    const updated = { ...form, fields: [{ ...form.fields[0], value: "srv" }] }
    s = reduce(s, { type: "FORM_UPDATE", form: updated })
    expect((s.overlay as { form: typeof form }).form.fields[0].value).toBe("srv")
    // No form open → unchanged.
    const help = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    expect(reduce(help, { type: "FORM_UPDATE", form: updated })).toBe(help)
  })

  it("BASH_START adds a running bash cell and BASH_RESULT fills it", () => {
    let s = reduce(base(), { type: "BASH_START", command: "ls -la" })
    const cell = s.cells.at(-1)
    expect(cell).toMatchObject({ kind: "bash", command: "ls -la", status: "running" })
    s = reduce(s, { type: "BASH_RESULT", output: "a\nb", status: "done", exitCode: 0 })
    expect(s.cells.at(-1)).toMatchObject({
      kind: "bash",
      output: "a\nb",
      status: "done",
      exitCode: 0,
    })
  })

  it("BASH_APPEND streams chunks into the running bash cell, then BASH_RESULT reflows it", () => {
    let s = reduce(base(), { type: "BASH_START", command: "echo hi" })
    s = reduce(s, { type: "BASH_APPEND", chunk: "hel" })
    s = reduce(s, { type: "BASH_APPEND", chunk: "lo\n" })
    expect(s.cells.at(-1)).toMatchObject({ kind: "bash", output: "hello\n", status: "running" })
    // The final result overwrites the streamed text with the clean formatted form.
    s = reduce(s, { type: "BASH_RESULT", output: "hello", status: "done", exitCode: 0 })
    expect(s.cells.at(-1)).toMatchObject({ kind: "bash", output: "hello", status: "done" })
  })

  it("BASH_APPEND no-ops when there is no running bash cell", () => {
    const s0 = base()
    expect(reduce(s0, { type: "BASH_APPEND", chunk: "x" })).toBe(s0)
  })

  it("BASH_RESULT no-ops when there is no running bash cell", () => {
    const s0 = base()
    expect(reduce(s0, { type: "BASH_RESULT", output: "x", status: "done" })).toBe(s0)
  })

  it("id-targeted BASH_APPEND/RESULT fill the matching cell, not the most recent", () => {
    // Two concurrent runs: a backgrounded one (a) and a fresh foreground one (b).
    let s = reduce(base(), { type: "BASH_START", command: "a", id: "bash-1" })
    s = reduce(s, { type: "BASH_BACKGROUND", id: "bash-1" })
    s = reduce(s, { type: "BASH_START", command: "b", id: "bash-2" })
    // A late chunk for `a` lands on `a`, even though `b` started later.
    s = reduce(s, { type: "BASH_APPEND", chunk: "from-a", id: "bash-1" })
    const a = s.cells.find((c) => c.id === "bash-1")
    expect(a).toMatchObject({ kind: "bash", output: "from-a", background: true })
    // `a`'s result settles `a` and clears its background marker; `b` untouched.
    s = reduce(s, {
      type: "BASH_RESULT",
      output: "done-a",
      status: "done",
      exitCode: 0,
      id: "bash-1",
    })
    expect(s.cells.find((c) => c.id === "bash-1")).toMatchObject({
      kind: "bash",
      status: "done",
      background: false,
    })
    expect(s.cells.find((c) => c.id === "bash-2")).toMatchObject({ status: "running" })
  })

  it("BASH_BACKGROUND marks a running cell and only a running one", () => {
    let s = reduce(base(), { type: "BASH_START", command: "srv", id: "bash-1" })
    s = reduce(s, { type: "BASH_BACKGROUND", id: "bash-1" })
    expect(s.cells.find((c) => c.id === "bash-1")).toMatchObject({ background: true })
    // Settled, then a stray BASH_BACKGROUND is a no-op on the now-done cell.
    s = reduce(s, { type: "BASH_RESULT", output: "x", status: "done", id: "bash-1" })
    const settled = s.cells.find((c) => c.id === "bash-1")
    s = reduce(s, { type: "BASH_BACKGROUND", id: "bash-1" })
    expect(s.cells.find((c) => c.id === "bash-1")).toBe(settled)
  })

  it("BASH_FOREGROUND promotes the target and demotes every other running bash cell", () => {
    let s = reduce(base(), { type: "BASH_START", command: "a", id: "bash-1" })
    s = reduce(s, { type: "BASH_BACKGROUND", id: "bash-1" })
    s = reduce(s, { type: "BASH_START", command: "b", id: "bash-2" })
    s = reduce(s, { type: "BASH_FOREGROUND", id: "bash-1" })
    expect(s.cells.find((c) => c.id === "bash-1")).toMatchObject({ background: false })
    expect(s.cells.find((c) => c.id === "bash-2")).toMatchObject({ background: true })
  })

  it("BASH_FOREGROUND no-ops on a settled or unknown cell", () => {
    let s = reduce(base(), { type: "BASH_START", command: "a", id: "bash-1" })
    s = reduce(s, { type: "BASH_RESULT", output: "x", status: "done", id: "bash-1" })
    const settled = s
    expect(reduce(settled, { type: "BASH_FOREGROUND", id: "bash-1" })).toBe(settled)
    expect(reduce(settled, { type: "BASH_FOREGROUND", id: "nope" })).toBe(settled)
  })

  it("ACTIVITY_START/PROGRESS/END drive the background activity pill", () => {
    let s = reduce(base(), { type: "ACTIVITY_START", kind: "goal", label: "ship it" })
    expect(s.activity).toEqual({ kind: "goal", label: "ship it", status: "running" })
    s = reduce(s, { type: "ACTIVITY_PROGRESS", turns: 3, note: "thinking" })
    expect(s.activity).toMatchObject({ turns: 3, note: "thinking" })
    s = reduce(s, { type: "ACTIVITY_END", status: "done", summary: "goal complete" })
    expect(s.activity).toBeUndefined()
    expect(s.cells.at(-1)).toMatchObject({ kind: "notice", message: "goal complete" })
  })

  it("ACTIVITY_PROGRESS no-ops with no active activity, ACTIVITY_END can omit a summary", () => {
    const s0 = base()
    expect(reduce(s0, { type: "ACTIVITY_PROGRESS", turns: 1 })).toBe(s0)
    let s = reduce(s0, { type: "ACTIVITY_START", kind: "workflow", label: "wf" })
    const before = s.cells.length
    s = reduce(s, { type: "ACTIVITY_END", status: "error" })
    expect(s.activity).toBeUndefined()
    expect(s.cells.length).toBe(before)
  })

  it("input actions set buffer, history, pastes and clear", () => {
    let s = reduce(base(), {
      type: "INPUT_SET",
      buffer: { lines: ["hi"], cursorRow: 0, cursorCol: 2 },
    })
    expect(s.input.buffer.lines).toEqual(["hi"])
    s = reduce(s, { type: "INPUT_HISTORY", history: { entries: ["a"], index: 0, draft: "d" } })
    expect(s.input.history.entries).toEqual(["a"])
    s = reduce(s, { type: "INPUT_ADD_PASTE", id: "p1", text: "big paste" })
    expect(s.input.pastes.p1).toBe("big paste")
    s = reduce(s, { type: "INPUT_CLEAR" })
    expect(s.input.buffer.lines).toEqual([""])
  })

  it("INPUT_PUSH_HISTORY records non-blank entries and resets the editor", () => {
    const s = reduce(base(), { type: "INPUT_PUSH_HISTORY", entry: "first" })
    expect(s.input.history.entries).toEqual(["first"])
    expect(s.input.buffer.lines).toEqual([""])
    // Blank entry is ignored.
    const s2 = reduce(s, { type: "INPUT_PUSH_HISTORY", entry: "   " })
    expect(s2).toBe(s)
  })

  it("INPUT_PUSH_HISTORY skips a consecutive duplicate but keeps a later repeat", () => {
    let s = reduce(base(), { type: "INPUT_PUSH_HISTORY", entry: "ls" })
    s = reduce(s, { type: "INPUT_PUSH_HISTORY", entry: "ls" })
    expect(s.input.history.entries).toEqual(["ls"])
    s = reduce(s, { type: "INPUT_PUSH_HISTORY", entry: "pwd" })
    s = reduce(s, { type: "INPUT_PUSH_HISTORY", entry: "ls" })
    expect(s.input.history.entries).toEqual(["ls", "pwd", "ls"])
  })

  it("INPUT_PUSH_HISTORY caps the in-memory ring at the limit", () => {
    let s = base()
    for (let i = 0; i < 110; i++) {
      s = reduce(s, { type: "INPUT_PUSH_HISTORY", entry: `e${i}` })
    }
    expect(s.input.history.entries).toHaveLength(100)
    expect(s.input.history.entries[0]).toBe("e10")
    expect(s.input.history.entries[s.input.history.entries.length - 1]).toBe("e109")
  })

  it("CTRL_C records the timestamp and EXIT flips the exit flag", () => {
    let s = reduce(base(), { type: "CTRL_C", at: 123 })
    expect(s.lastCtrlCAt).toBe(123)
    s = reduce(s, { type: "EXIT" })
    expect(s.exit).toBe(true)
  })

  it("returns state unchanged for an unknown action", () => {
    const s0 = base()
    const s = tuiReducer(s0, { type: "NOPE" } as unknown as TuiAction)
    expect(s).toBe(s0)
  })

  it("SET_USAGE records the latest usage and accumulates session totals", () => {
    let s = reduce(base(), { type: "SET_USAGE", usage: { inputTokens: 100, totalCostUsd: 0.1 } })
    expect(s.usage?.inputTokens).toBe(100)
    expect(s.sessionTotals.costUsd).toBeCloseTo(0.1)
    expect(s.usageSeenThisTurn).toBe(true)
    s = reduce(s, { type: "SET_USAGE", usage: { inputTokens: 200, totalCostUsd: 0.2 } })
    // Latest usage replaces; cost accumulates.
    expect(s.usage?.inputTokens).toBe(200)
    expect(s.sessionTotals.costUsd).toBeCloseTo(0.3)
  })

  it("SET_USAGE attributes each turn to its model in modelTotals", () => {
    let s = reduce(base(), { type: "SET_USAGE", usage: { inputTokens: 100, totalCostUsd: 0.1 } })
    s = reduce(s, { type: "SET_USAGE", usage: { inputTokens: 200, totalCostUsd: 0.2 } })
    // Same model both turns → one bucket whose total mirrors the session total.
    const keys = Object.keys(s.modelTotals)
    expect(keys).toHaveLength(1)
    expect(s.modelTotals[keys[0]].inputTokens).toBe(300)
    expect(s.modelTotals[keys[0]].costUsd).toBeCloseTo(s.sessionTotals.costUsd)
  })

  it("RESET clears the per-model totals", () => {
    let s = reduce(base(), { type: "SET_USAGE", usage: { inputTokens: 100, totalCostUsd: 0.1 } })
    expect(Object.keys(s.modelTotals)).toHaveLength(1)
    s = reduce(s, { type: "RESET", sessionId: "next" })
    expect(s.modelTotals).toEqual({})
  })

  it("SET_USAGE appends each turn's total tokens to the trend history", () => {
    let s = reduce(base(), {
      type: "SET_USAGE",
      usage: { inputTokens: 100, cacheReadInputTokens: 50, outputTokens: 25 },
    })
    // 100 + 50 (prompt incl. cache) + 25 output = 175.
    expect(s.usageHistory).toEqual([175])
    s = reduce(s, { type: "SET_USAGE", usage: { inputTokens: 10, outputTokens: 5 } })
    expect(s.usageHistory).toEqual([175, 15])
  })

  it("SET_USAGE appends each turn's SDK-reported cost to the cost history", () => {
    let s = reduce(base(), { type: "SET_USAGE", usage: { inputTokens: 100, totalCostUsd: 0.1 } })
    expect(s.costHistory).toEqual([0.1])
    s = reduce(s, { type: "SET_USAGE", usage: { inputTokens: 200, totalCostUsd: 0.25 } })
    expect(s.costHistory).toEqual([0.1, 0.25])
  })

  it("TURN_COMMIT fallback usage also feeds the trend history", () => {
    const s = reduce(base(), {
      type: "TURN_COMMIT",
      result: result({ inputTokens: 80, outputTokens: 20 }),
    })
    expect(s.usageHistory).toEqual([100])
  })

  it("TOOL_CALL tallies calls and TOOL_RESULT tallies errors per tool", () => {
    let s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} },
      { type: "TOOL_RESULT", callKey: "k1", toolName: "bash", result: "boom", isError: true },
      { type: "TOOL_CALL", callKey: "k2", toolName: "read", input: {} },
      { type: "TOOL_RESULT", callKey: "k2", toolName: "read", result: "ok", isError: false }
    )
    expect(s.toolStats.bash).toEqual({ calls: 1, errors: 1 })
    expect(s.toolStats.read).toEqual({ calls: 1, errors: 0 })
    // A second bash call bumps only its call count.
    s = reduce(s, { type: "TOOL_CALL", callKey: "k3", toolName: "bash", input: {} })
    expect(s.toolStats.bash).toEqual({ calls: 2, errors: 1 })
  })

  it("TodoWrite calls are tallied too", () => {
    const s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: "t",
      toolName: "TodoWrite",
      input: { todos: [{ content: "a", status: "pending" }] },
    })
    expect(s.toolStats.TodoWrite).toEqual({ calls: 1, errors: 0 })
  })

  it("SET_MODEL_META stores the resolved window + pricing", () => {
    const s = reduce(base(), {
      type: "SET_MODEL_META",
      meta: {
        modelId: "claude-x",
        contextWindow: 1_000_000,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
    })
    expect(s.modelMeta?.modelId).toBe("claude-x")
    expect(s.modelMeta?.contextWindow).toBe(1_000_000)
    expect(s.modelMeta?.pricing).toEqual({ promptPer1M: 3, completionPer1M: 15 })
  })

  it("SET_CONTEXT_USAGE updates live occupancy without accumulating token totals", () => {
    const initial = createInitialState(config, "s1")
    const next = tuiReducer(initial, { type: "SET_CONTEXT_USAGE", used: 42_000, size: 1_000_000 })
    expect(next.usage).toMatchObject({ contextTokens: 42_000, contextWindow: 1_000_000 })
    expect(next.modelMeta).toMatchObject({ contextWindow: 1_000_000, runtime: true })
    expect(next.sessionTotals).toEqual(initial.sessionTotals)
  })

  it("SET_USAGE estimates cost from modelMeta pricing when the SDK reports none", () => {
    let s = reduce(base(), {
      type: "SET_MODEL_META",
      meta: {
        modelId: "claude-x",
        contextWindow: 200_000,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
    })
    // ai-sdk path: no totalCostUsd → priced from the catalog rates.
    s = reduce(s, { type: "SET_USAGE", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })
    expect(s.sessionTotals.costUsd).toBeCloseTo(18, 6)
  })

  it("TURN_START clears the per-turn usage-seen guard", () => {
    const s = reduce(
      base(),
      { type: "SET_USAGE", usage: { inputTokens: 1 } },
      { type: "TURN_START", prompt: "hi" }
    )
    expect(s.usageSeenThisTurn).toBe(false)
  })

  it("TURN_COMMIT folds in result usage only when no stream event landed", () => {
    const r = (usage?: { totalCostUsd?: number }): RunAndCaptureResult => ({
      text: "x",
      messageId: "m",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      ...(usage ? { usage } : {}),
    })
    // No prior SET_USAGE → result usage is counted.
    const a = reduce(base(), { type: "TURN_COMMIT", result: r({ totalCostUsd: 0.4 }) })
    expect(a.sessionTotals.costUsd).toBeCloseTo(0.4)
    // SET_USAGE already landed → result usage is NOT double-counted.
    const b = reduce(
      base(),
      { type: "SET_USAGE", usage: { totalCostUsd: 0.4 } },
      { type: "TURN_COMMIT", result: r({ totalCostUsd: 0.4 }) }
    )
    expect(b.sessionTotals.costUsd).toBeCloseTo(0.4)
  })

  it("RESET clears usage, session totals, trend history and tool stats", () => {
    const s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} },
      { type: "SET_USAGE", usage: { inputTokens: 100, totalCostUsd: 1 } },
      { type: "RESET", sessionId: "ses2" }
    )
    expect(s.usage).toBeUndefined()
    expect(s.sessionTotals.costUsd).toBe(0)
    expect(s.usageHistory).toEqual([])
    expect(s.toolStats).toEqual({})
  })

  it("SET_MODEL discards stale modelMeta so the footer falls back to the pattern table", () => {
    let s = reduce(base(), {
      type: "SET_MODEL_META",
      meta: { modelId: "sonnet", contextWindow: 200_000 },
    })
    expect(s.modelMeta).not.toBeUndefined()
    s = reduce(s, { type: "SET_MODEL", model: "claude-opus-4-8" })
    expect(s.modelMeta).toBeUndefined()
  })

  it("SET_PROVIDER discards stale modelMeta so the footer falls back until re-resolved", () => {
    let s = reduce(base(), {
      type: "SET_MODEL_META",
      meta: { modelId: "claude-x", contextWindow: 200_000 },
    })
    expect(s.modelMeta).not.toBeUndefined()
    s = reduce(s, { type: "SET_PROVIDER", provider: "deepseek" })
    expect(s.modelMeta).toBeUndefined()
  })

  it("CLEAR_CTRL_C resets the double-press window", () => {
    let s = reduce(base(), { type: "CTRL_C", at: 5000 })
    expect(s.lastCtrlCAt).toBe(5000)
    s = reduce(s, { type: "CLEAR_CTRL_C" })
    expect(s.lastCtrlCAt).toBeUndefined()
  })
})

describe("tuiReducer — backend lifecycle", () => {
  const external = (backend: string): TuiState =>
    createInitialState({ ...config, agentBackend: backend }, "ses1", false)

  it("routes the trust gate into a connect on an external backend", () => {
    expect(reduce(external("codex"), { type: "STARTUP_TRUST" }).phase).toBe("connecting")
  })

  it("goes straight to chat on the built-in backend", () => {
    const start = createInitialState(config, "ses1", false)
    expect(reduce(start, { type: "STARTUP_TRUST" }).phase).toBe("chat")
  })

  it("tracks the connect stage for the progress line", () => {
    const next = reduce(external("codex"), {
      type: "BACKEND_CONNECT_STAGE",
      backend: "codex",
      stage: "sandbox",
    })
    expect(next.phase).toBe("connecting")
    expect(next.backendConnect).toEqual({ backend: "codex", stage: "sandbox" })
  })

  it("adopts negotiated capabilities and opens the chat on success", () => {
    const caps = externalCapabilities({ backend: "codex" })
    const next = reduce(
      reduce(external("codex"), {
        type: "BACKEND_CONNECT_STAGE",
        backend: "codex",
        stage: "launch",
      }),
      { type: "BACKEND_CONNECT_OK", capabilities: caps }
    )
    expect(next.phase).toBe("chat")
    expect(next.backendCapabilities).toBe(caps)
    expect(next.backendConnect).toBeUndefined()
  })

  it("holds the failure for the recovery page, then clears it on retry", () => {
    const failure = { kind: "launcher" as const, stage: "sandbox" as const, message: "missing" }
    const failed = reduce(external("codex"), { type: "BACKEND_CONNECT_FAIL", failure })
    expect(failed.phase).toBe("connect-failed")
    expect(failed.backendFailure).toBe(failure)
    expect(failed.backendConnect).toBeUndefined()

    const retried = reduce(failed, { type: "BACKEND_CONNECT_RETRY", backend: "codex" })
    expect(retried.phase).toBe("connecting")
    expect(retried.backendFailure).toBeUndefined()
    expect(retried.backendConnect).toEqual({ backend: "codex", stage: "preset" })
  })

  it("drops the old backend's capabilities the moment the backend changes", () => {
    const live = reduce(external("codex"), {
      type: "BACKEND_CONNECT_OK",
      capabilities: externalCapabilities({ backend: "codex" }),
    })
    const switched = reduce(live, { type: "SET_BACKEND", backend: "claude-code" })
    expect(switched.config.agentBackend).toBe("claude-code")
    // Stale support is exactly the lie the capability gate exists to prevent.
    expect(switched.backendCapabilities).toBeUndefined()
  })

  it("restores full capabilities when switching back to the built-in agent", () => {
    const switched = reduce(external("codex"), { type: "SET_BACKEND", backend: "builtin" })
    expect(switched.backendCapabilities?.builtin).toBe(true)
  })

  const installOption = {
    command: "copilot",
    name: "GitHub Copilot CLI",
    method: {
      kind: "npm" as const,
      ownership: "user-managed" as const,
      label: "npm",
      display: "npm install -g @github/copilot",
      command: "npm",
      args: ["install", "-g", "@github/copilot"],
      requires: ["npm"],
    },
  }
  const cmdFailure = {
    kind: "command" as const,
    stage: "command" as const,
    message: "\"copilot\" isn't installed or isn't on PATH.",
    command: "copilot",
  }

  it("carries an install option onto the failure page and drives the install phase", () => {
    const failed = reduce(external("copilot-cli"), {
      type: "BACKEND_CONNECT_FAIL",
      failure: cmdFailure,
      installOption,
    })
    expect(failed.backendInstallOption).toEqual(installOption)

    const installing = reduce(failed, {
      type: "BACKEND_INSTALL_START",
      name: installOption.name,
      display: installOption.method.display,
    })
    expect(installing.phase).toBe("installing")
    expect(installing.backendInstall).toEqual({
      name: installOption.name,
      display: installOption.method.display,
      output: "",
      status: "running",
    })
    // The failure + option survive so a failed install returns a full page.
    expect(installing.backendFailure).toBe(cmdFailure)
    expect(installing.backendInstallOption).toEqual(installOption)

    const streamed = reduce(
      reduce(installing, {
        type: "BACKEND_INSTALL_OUTPUT",
        chunk: "added 1 package\n",
      }),
      { type: "BACKEND_INSTALL_OUTPUT", chunk: "done\n" }
    )
    expect(streamed.backendInstall?.output).toBe("added 1 package\ndone\n")
  })

  it("ignores install output once the install phase is gone", () => {
    const failed = reduce(external("copilot-cli"), {
      type: "BACKEND_CONNECT_FAIL",
      failure: cmdFailure,
      installOption,
    })
    // No backendInstall yet → the late line is a no-op, not a crash.
    expect(reduce(failed, { type: "BACKEND_INSTALL_OUTPUT", chunk: "x" })).toBe(failed)
  })

  it("returns to the failure page with an inline error when the install fails", () => {
    const installing = reduce(
      reduce(external("copilot-cli"), {
        type: "BACKEND_CONNECT_FAIL",
        failure: cmdFailure,
        installOption,
      }),
      {
        type: "BACKEND_INSTALL_START",
        name: installOption.name,
        display: installOption.method.display,
      }
    )
    const failed = reduce(installing, {
      type: "BACKEND_INSTALL_FAIL",
      message: "Couldn't install X",
    })
    expect(failed.phase).toBe("connect-failed")
    expect(failed.backendInstall).toBeUndefined()
    expect(failed.backendInstallError).toBe("Couldn't install X")
    // The option is still there so the user can retry the install.
    expect(failed.backendInstallOption).toEqual(installOption)
  })

  it("clears the install option and error on a fresh failure, retry, and success", () => {
    const failed = reduce(external("copilot-cli"), {
      type: "BACKEND_CONNECT_FAIL",
      failure: cmdFailure,
      installOption,
    })
    // A later failure with no installable fix drops the stale option.
    const noFix = reduce(failed, {
      type: "BACKEND_CONNECT_FAIL",
      failure: { kind: "handshake", stage: "launch", message: "not logged in" },
    })
    expect(noFix.backendInstallOption).toBeUndefined()

    // Retry and success both clear every install remnant.
    const withError = reduce(
      reduce(failed, {
        type: "BACKEND_INSTALL_START",
        name: installOption.name,
        display: installOption.method.display,
      }),
      { type: "BACKEND_INSTALL_FAIL", message: "boom" }
    )
    const retried = reduce(withError, { type: "BACKEND_CONNECT_RETRY", backend: "copilot-cli" })
    expect(retried.backendInstallOption).toBeUndefined()
    expect(retried.backendInstallError).toBeUndefined()

    const live = reduce(withError, {
      type: "BACKEND_CONNECT_OK",
      capabilities: externalCapabilities({ backend: "copilot-cli" }),
    })
    expect(live.backendInstallOption).toBeUndefined()
    expect(live.backendInstallError).toBeUndefined()
    expect(live.backendInstall).toBeUndefined()
  })
})

describe("tuiReducer — INPUT_EDIT", () => {
  const edit = (state: TuiState, ...ops: InputEditOp[]): TuiState =>
    reduce(state, ...ops.map((op): TuiAction => ({ type: "INPUT_EDIT", edit: op })))

  const typed = (text: string): TuiState => edit(base(), { op: "insert", text })
  const text = (state: TuiState): string => state.input.buffer.lines.join("\n")

  it("applies each text-mutating op to the live buffer", () => {
    expect(text(typed("hello"))).toBe("hello")
    expect(text(edit(typed("hello"), { op: "backspace" }))).toBe("hell")
    expect(text(edit(typed("hello world"), { op: "delete-word" }))).toBe("hello ")
    expect(text(edit(typed("hi"), { op: "newline" }))).toBe("hi\n")
    expect(text(edit(typed("hello"), { op: "kill-to-start" }))).toBe("")
    expect(text(edit(typed("hello"), { op: "move", dir: "home" }, { op: "kill-to-end" }))).toBe("")
  })

  it.each([
    ["left", 4],
    ["right", 5],
    ["home", 0],
    ["end", 5],
    ["word-left", 0],
    ["word-right", 5],
    // On a single line, ↑/↓ fall back to jumping to the start / end of the buffer.
    ["up", 0],
    ["down", 5],
  ] as const)("moves the cursor %s", (dir, cursorCol) => {
    expect(edit(typed("hello"), { op: "move", dir }).input.buffer.cursorCol).toBe(cursorCol)
  })
})

describe("tuiReducer — TOOL_UPDATE", () => {
  const start = (): TuiState =>
    reduce(
      base(),
      { type: "TURN_START", prompt: "go" },
      {
        type: "TOOL_CALL",
        callKey: "t1",
        toolName: "Write",
        input: {},
        displayTitle: "Edit the config",
      }
    )

  it("refines the announced card in place rather than adding another", () => {
    const next = reduce(start(), {
      type: "TOOL_UPDATE",
      callKey: "t1",
      toolName: "Edit",
      input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
    })
    expect(next.inflight.tools).toHaveLength(1)
    expect(next.inflight.tools[0]).toMatchObject({
      toolName: "Edit",
      displayTitle: "Edit the config",
      input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
      status: "running",
    })
  })

  it("is idempotent, so a re-sent update never stacks cards", () => {
    const update: TuiAction = {
      type: "TOOL_UPDATE",
      callKey: "t1",
      toolName: "Edit",
      input: { file_path: "/work/a.ts" },
    }
    const next = reduce(start(), update, update, update)
    expect(next.inflight.tools).toHaveLength(1)
  })

  it("merges onto a card that already moved into the transcript", () => {
    // A late update for a tool that was flushed to cells at a commit boundary.
    const committed = reduce(
      start(),
      { type: "TOOL_RESULT", callKey: "t1", toolName: "Write", result: "ok" },
      { type: "TURN_COMMIT", result: result() }
    )
    const next = reduce(committed, {
      type: "TOOL_UPDATE",
      callKey: "t1",
      input: { file_path: "/work/a.ts" },
    })
    const tools = next.cells.filter((c): c is ToolCell => c.kind === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0].input).toMatchObject({ file_path: "/work/a.ts" })
    // The result is untouched — an update refines, it does not re-open a tool.
    expect(tools[0].status).toBe("done")
  })

  it("materializes a card when the update outran its announcement", () => {
    const next = reduce(reduce(base(), { type: "TURN_START", prompt: "go" }), {
      type: "TOOL_UPDATE",
      callKey: "orphan",
      toolName: "Edit",
      input: { file_path: "/a" },
    })
    expect(next.inflight.tools).toHaveLength(1)
    expect(next.inflight.tools[0]).toMatchObject({ callKey: "orphan", toolName: "Edit" })
  })

  it("leaves the canonical name alone when the update only carries input", () => {
    const next = reduce(start(), { type: "TOOL_UPDATE", callKey: "t1", input: { a: 1 } })
    expect(next.inflight.tools[0].toolName).toBe("Write")
  })
})

describe("tuiReducer — btw steer queue", () => {
  it("enqueues trimmed steer messages and ignores blank ones", () => {
    let s = base()
    expect(s.steerQueue).toEqual([])
    s = reduce(s, { type: "STEER_ENQUEUE", text: "  check the logs  " })
    s = reduce(s, { type: "STEER_ENQUEUE", text: "   " })
    s = reduce(s, { type: "STEER_ENQUEUE", text: "also lint" })
    expect(s.steerQueue).toEqual(["check the logs", "also lint"])
  })

  it("clears the queue", () => {
    let s = reduce(base(), { type: "STEER_ENQUEUE", text: "a" })
    s = reduce(s, { type: "STEER_CLEAR" })
    expect(s.steerQueue).toEqual([])
  })

  it("STEER_CLEAR on an empty queue is a no-op (same reference)", () => {
    const s = base()
    expect(reduce(s, { type: "STEER_CLEAR" })).toBe(s)
  })
})

describe("tuiReducer — workflow run panel", () => {
  const steps = [
    { id: "a", label: "A", status: "pending" as const },
    { id: "b", label: "B", status: "pending" as const },
  ]

  it("WORKFLOW_RUN_START seeds the panel", () => {
    const s = reduce(base(), { type: "WORKFLOW_RUN_START", steps })
    expect(s.workflowRun).toEqual({ steps, completed: 0 })
  })

  it("WORKFLOW_RUN_STEP replaces the slice with progress + currentId", () => {
    let s = reduce(base(), { type: "WORKFLOW_RUN_START", steps })
    const next = [{ id: "a", label: "A", status: "succeeded" as const }, steps[1]]
    s = reduce(s, { type: "WORKFLOW_RUN_STEP", steps: next, completed: 1, currentId: "b" })
    expect(s.workflowRun).toEqual({ steps: next, completed: 1, currentId: "b" })
  })

  it("WORKFLOW_RUN_STEP omits currentId when not supplied", () => {
    const s = reduce(base(), { type: "WORKFLOW_RUN_STEP", steps, completed: 0 })
    expect(s.workflowRun).toEqual({ steps, completed: 0 })
    expect(s.workflowRun?.currentId).toBeUndefined()
  })

  it("WORKFLOW_RUN_STEP stores run-level usage and raw events when supplied", () => {
    const usage = { totalTokens: 1200, costUsd: 0.002 }
    const events = [{ id: "e1", runId: "r", ts: 1, type: "step_started" as const, stepId: "a" }]
    const s = reduce(base(), {
      type: "WORKFLOW_RUN_STEP",
      steps,
      completed: 1,
      usage,
      events,
    })
    expect(s.workflowRun?.usage).toEqual(usage)
    expect(s.workflowRun?.events).toEqual(events)
  })

  it("WORKFLOW_RUN_END clears the panel", () => {
    let s = reduce(base(), { type: "WORKFLOW_RUN_START", steps })
    s = reduce(s, { type: "WORKFLOW_RUN_END" })
    expect(s.workflowRun).toBeUndefined()
  })
})

describe("tuiReducer — settings overlay", () => {
  const sections = [
    {
      id: "model" as const,
      title: "Model",
      rows: [{ id: "a", label: "A", value: "1", control: { type: "readonly" as const } }],
    },
    {
      id: "appearance" as const,
      title: "Appearance",
      rows: [
        { id: "t", label: "Theme", value: "classic", control: { type: "readonly" as const } },
        { id: "o", label: "Output", value: "default", control: { type: "readonly" as const } },
      ],
    },
  ]

  function openSettings(section = 0, index = 0): TuiState {
    return reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "settings", sections, section, index },
    })
  }

  it("OVERLAY_MOVE navigates rows within the active section (wraps)", () => {
    const s = reduce(openSettings(1, 0), { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(1)
    const wrapped = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((wrapped.overlay as { index: number }).index).toBe(0)
  })

  it("OVERLAY_MOVE is bounded by the active section's row count, not another's", () => {
    // model section has 1 row → moving stays at 0
    const s = reduce(openSettings(0, 0), { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0)
  })

  it("SET_CONFIG_PATCH merges config without closing the overlay", () => {
    const s = reduce(openSettings(0, 0), { type: "SET_CONFIG_PATCH", patch: { webTools: false } })
    expect(s.config.webTools).toBe(false)
    expect(s.overlay.kind).toBe("settings")
  })

  it("SET_CONFIG_PATCH preserves untouched config fields", () => {
    const s = reduce(openSettings(), {
      type: "SET_CONFIG_PATCH",
      patch: { builtinTools: { git: false } as ResolvedConfig["builtinTools"] },
    })
    expect(s.config.builtinTools).toEqual({ git: false })
    expect(s.config.provider).toBe(base().config.provider)
  })
})

describe("tuiReducer — workflow copilot mode", () => {
  it("COPILOT_ENTER sets the copilot slice (new draft starts dirty)", () => {
    const s = reduce(base(), {
      type: "COPILOT_ENTER",
      workflowId: "w1",
      name: "Demo",
      isNew: true,
    })
    expect(s.copilot).toEqual({ workflowId: "w1", name: "Demo", isNew: true, dirty: true })
  })

  it("an existing-workflow edit starts clean", () => {
    const s = reduce(base(), {
      type: "COPILOT_ENTER",
      workflowId: "w1",
      name: "Demo",
      isNew: false,
    })
    expect(s.copilot?.dirty).toBe(false)
  })

  it("COPILOT_SET_PROPOSAL / CLEAR_PROPOSAL toggle the pending id", () => {
    const entered = reduce(base(), {
      type: "COPILOT_ENTER",
      workflowId: "w1",
      name: "Demo",
      isNew: false,
    })
    const set = reduce(entered, { type: "COPILOT_SET_PROPOSAL", proposalId: "p1" })
    expect(set.copilot?.pendingProposalId).toBe("p1")
    const cleared = reduce(set, { type: "COPILOT_CLEAR_PROPOSAL" })
    expect(cleared.copilot?.pendingProposalId).toBeUndefined()
    expect(cleared.copilot?.workflowId).toBe("w1")
  })

  it("COPILOT_MARK_DIRTY flips dirty true", () => {
    const entered = reduce(base(), {
      type: "COPILOT_ENTER",
      workflowId: "w1",
      name: "Demo",
      isNew: false,
    })
    expect(reduce(entered, { type: "COPILOT_MARK_DIRTY" }).copilot?.dirty).toBe(true)
  })

  it("COPILOT_EXIT clears the slice", () => {
    const entered = reduce(base(), {
      type: "COPILOT_ENTER",
      workflowId: "w1",
      name: "Demo",
      isNew: true,
    })
    expect(reduce(entered, { type: "COPILOT_EXIT" }).copilot).toBeUndefined()
  })

  it("copilot actions are no-ops when not in copilot mode", () => {
    const s = reduce(
      base(),
      { type: "COPILOT_SET_PROPOSAL", proposalId: "p1" },
      { type: "COPILOT_CLEAR_PROPOSAL" },
      { type: "COPILOT_MARK_DIRTY" }
    )
    expect(s.copilot).toBeUndefined()
  })
})

describe("tuiReducer — toasts & completion signals", () => {
  it("TOAST_PUSH appends a toast and caps at three (oldest dropped)", () => {
    const s = reduce(
      base(),
      { type: "TOAST_PUSH", severity: "info", message: "one" },
      { type: "TOAST_PUSH", severity: "warn", message: "two" },
      { type: "TOAST_PUSH", severity: "error", message: "three", hint: "fix it" },
      { type: "TOAST_PUSH", severity: "info", message: "four" }
    )
    expect(s.toasts.map((t) => t.message)).toEqual(["two", "three", "four"])
    expect(s.toasts[1]).toMatchObject({ severity: "error", hint: "fix it" })
    // Ids are unique (derived from the monotonic seq).
    expect(new Set(s.toasts.map((t) => t.id)).size).toBe(3)
  })

  it("TOAST_DISMISS removes the matching toast only", () => {
    const pushed = reduce(base(), { type: "TOAST_PUSH", severity: "info", message: "keep" })
    const id = pushed.toasts[0].id
    const other = reduce(pushed, { type: "TOAST_PUSH", severity: "warn", message: "drop" })
    const dropId = other.toasts[1].id
    const after = reduce(other, { type: "TOAST_DISMISS", id: dropId })
    expect(after.toasts.map((t) => t.id)).toEqual([id])
  })

  it("NOTICE with toast:true archives a cell AND raises a toast", () => {
    const s = reduce(base(), { type: "NOTICE", message: "heads up", severity: "warn", toast: true })
    expect(s.cells.at(-1)).toMatchObject({ kind: "notice", message: "heads up" })
    expect(s.toasts).toHaveLength(1)
    expect(s.toasts[0]).toMatchObject({ severity: "warn", message: "heads up" })
  })

  it("NOTICE without toast only appends a cell", () => {
    const s = reduce(base(), { type: "NOTICE", message: "quiet" })
    expect(s.cells.at(-1)).toMatchObject({ kind: "notice", message: "quiet" })
    expect(s.toasts).toHaveLength(0)
  })

  it("SIDECAR_STATUS toggles the down flag; TURN_START clears it", () => {
    const down = reduce(base(), { type: "SIDECAR_STATUS", down: true })
    expect(down.sidecarDown).toBe(true)
    const started = reduce(down, { type: "TURN_START", prompt: "hi" })
    expect(started.sidecarDown).toBe(false)
  })

  it("TURN_ERROR carries hint/category and sets an error completion signal", () => {
    const s = reduce(base(), {
      type: "TURN_ERROR",
      message: "401 Unauthorized",
      hint: "run /provider",
      category: "auth",
      title: "Authentication failed",
    })
    expect(s.cells.at(-1)).toMatchObject({ kind: "error", hint: "run /provider", category: "auth" })
    expect(s.lastCompletion).toEqual({
      kind: "turn",
      status: "error",
      label: "Authentication failed",
    })
  })

  it("ACTIVITY_END with status error surfaces a toast even without a summary", () => {
    const running = reduce(base(), { type: "ACTIVITY_START", kind: "goal", label: "ship it" })
    const ended = reduce(running, { type: "ACTIVITY_END", status: "error" })
    expect(ended.activity).toBeUndefined()
    expect(ended.toasts).toHaveLength(1)
    expect(ended.toasts[0]).toMatchObject({ severity: "error", message: "ship it error" })
    expect(ended.lastCompletion).toMatchObject({ kind: "activity", status: "error" })
  })

  it("ACTIVITY_END done with a summary appends a notice and no toast", () => {
    const running = reduce(base(), { type: "ACTIVITY_START", kind: "loop", label: "loop" })
    const ended = reduce(running, { type: "ACTIVITY_END", status: "done", summary: "3 turns" })
    expect(ended.cells.at(-1)).toMatchObject({ kind: "notice", message: "3 turns" })
    expect(ended.toasts).toHaveLength(0)
    expect(ended.lastCompletion).toMatchObject({ kind: "activity", status: "done" })
  })
})

describe("tuiReducer — MCP logs", () => {
  it("starts with an empty MCP log buffer", () => {
    expect(base().mcpLogs).toEqual([])
  })

  it("MCP_LOG_APPEND stamps a stable id and preserves order", () => {
    const s = reduce(
      base(),
      {
        type: "MCP_LOG_APPEND",
        entry: { ts: 1, level: "error", source: "stderr", message: "boom", server: "github" },
      },
      { type: "MCP_LOG_APPEND", entry: { ts: 2, level: "info", source: "sidecar", message: "ok" } }
    )
    expect(s.mcpLogs).toHaveLength(2)
    expect(s.mcpLogs[0]).toMatchObject({ level: "error", message: "boom", server: "github" })
    expect(s.mcpLogs[1]).toMatchObject({ level: "info", message: "ok" })
    // Ids are unique + monotonic (derived from seq).
    expect(s.mcpLogs[0].id).not.toEqual(s.mcpLogs[1].id)
    expect(typeof s.mcpLogs[0].id).toBe("string")
  })

  it("MCP_LOG_APPEND caps the ring buffer at 1000 (oldest drop)", () => {
    let s = base()
    for (let i = 0; i < 1005; i++) {
      s = reduce(s, {
        type: "MCP_LOG_APPEND",
        entry: { ts: i, level: "info", source: "stderr", message: `line ${i}` },
      })
    }
    expect(s.mcpLogs).toHaveLength(1000)
    // The oldest 5 were dropped; newest is retained.
    expect(s.mcpLogs[0].message).toBe("line 5")
    expect(s.mcpLogs.at(-1)?.message).toBe("line 1004")
  })

  it("MCP_LOG_CLEAR empties the buffer and is a no-op when already empty", () => {
    const filled = reduce(base(), {
      type: "MCP_LOG_APPEND",
      entry: { ts: 1, level: "warn", source: "diagnostic", message: "x" },
    })
    const cleared = reduce(filled, { type: "MCP_LOG_CLEAR" })
    expect(cleared.mcpLogs).toEqual([])
    // Already-empty clear returns the same reference (no needless re-render).
    expect(reduce(cleared, { type: "MCP_LOG_CLEAR" })).toBe(cleared)
  })

  it("MCP logs survive RESET (backend diagnostics aren't conversation state)", () => {
    const withLog = reduce(base(), {
      type: "MCP_LOG_APPEND",
      entry: { ts: 1, level: "info", source: "stderr", message: "kept" },
    })
    const afterReset = reduce(withLog, { type: "RESET", sessionId: "ses2" })
    expect(afterReset.mcpLogs).toHaveLength(1)
    expect(afterReset.mcpLogs[0].message).toBe("kept")
  })
})

describe("tuiReducer — unified log buffer", () => {
  const entries = (n: number, prefix = "m") =>
    Array.from({ length: n }, (_, i) => ({
      ts: i,
      level: "info" as const,
      channel: "agent" as const,
      message: `${prefix}${i}`,
    }))

  it("LOG_APPEND_BATCH appends the whole batch and stamps unique ids", () => {
    const s = reduce(base(), { type: "LOG_APPEND_BATCH", entries: entries(3) })
    expect(s.logs).toHaveLength(3)
    expect(new Set(s.logs.map((l) => l.id)).size).toBe(3)
    expect(s.logs.map((l) => l.message)).toEqual(["m0", "m1", "m2"])
  })

  it("advances seq once per entry so ids can't collide with later cells", () => {
    const start = base()
    const s = reduce(start, { type: "LOG_APPEND_BATCH", entries: entries(5) })
    expect(s.seq).toBe(start.seq + 5)
  })

  it("returns the same state for an empty batch", () => {
    const start = base()
    expect(reduce(start, { type: "LOG_APPEND_BATCH", entries: [] })).toBe(start)
  })

  it("trims only after crossing the high-water mark, not on every append", () => {
    // 1500 lines is past MAX but under the 2000 high-water mark: no trim yet, so
    // the O(n) slice is amortized instead of running on every single line.
    const grown = reduce(base(), { type: "LOG_APPEND_BATCH", entries: entries(1500) })
    expect(grown.logs).toHaveLength(1500)

    // Crossing 2000 trims back to 1000, keeping the NEWEST rows.
    const trimmed = reduce(grown, { type: "LOG_APPEND_BATCH", entries: entries(600, "n") })
    expect(trimmed.logs).toHaveLength(1000)
    expect(trimmed.logs[trimmed.logs.length - 1].message).toBe("n599")
  })

  it("LOG_CLEAR empties the buffer and is identity when already empty", () => {
    const filled = reduce(base(), { type: "LOG_APPEND_BATCH", entries: entries(2) })
    expect(reduce(filled, { type: "LOG_CLEAR" }).logs).toEqual([])
    const empty = base()
    expect(reduce(empty, { type: "LOG_CLEAR" })).toBe(empty)
  })

  it("LOG_CLEAR leaves the MCP buffer alone (it has its own clear)", () => {
    const s = reduce(
      base(),
      { type: "MCP_LOG_APPEND", entry: { ts: 1, level: "info", source: "stderr", message: "mcp" } },
      { type: "LOG_APPEND_BATCH", entries: entries(1) },
      { type: "LOG_CLEAR" }
    )
    expect(s.logs).toEqual([])
    expect(s.mcpLogs).toHaveLength(1)
  })

  it("survives RESET — backend diagnostics are not conversation state", () => {
    const s = reduce(
      base(),
      { type: "LOG_APPEND_BATCH", entries: entries(1, "kept") },
      { type: "RESET", sessionId: "ses2" }
    )
    expect(s.logs).toHaveLength(1)
    expect(s.logs[0].message).toBe("kept0")
  })
})

describe("BYPASS_ACK", () => {
  it("starts unacknowledged, so a session that OPENS in bypass still has to accept", () => {
    expect(base().bypassAcknowledged).toBe(false)
  })

  it("records the acknowledgement without touching the mode", () => {
    const s = reduce(
      base(),
      { type: "SET_MODE", mode: "bypassPermissions" },
      { type: "BYPASS_ACK" }
    )
    expect(s.bypassAcknowledged).toBe(true)
    expect(s.config.permissionMode).toBe("bypassPermissions")
  })

  it("survives a later de-escalation — the warning was seen once, that is enough", () => {
    const s = reduce(base(), { type: "BYPASS_ACK" }, { type: "SET_MODE", mode: "default" })
    expect(s.bypassAcknowledged).toBe(true)
  })
})

describe("BACKEND_INSTALL_START — install ownership", () => {
  it("carries ownership onto the install page", () => {
    const next = reduce(base(), {
      type: "BACKEND_INSTALL_START",
      name: "Factory Droid",
      display: "curl -fsSL https://app.factory.ai/cli | sh",
      ownership: "user-managed",
    })
    expect(next.backendInstall?.ownership).toBe("user-managed")
  })

  it("leaves ownership unset when the dispatcher did not record one", () => {
    const next = reduce(base(), {
      type: "BACKEND_INSTALL_START",
      name: "Factory Droid",
      display: "curl … | sh",
    })
    expect(next.backendInstall?.ownership).toBeUndefined()
  })
})
