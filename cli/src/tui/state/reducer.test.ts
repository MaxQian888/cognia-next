/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

import { createInitialState } from "./initial"
import { tuiReducer } from "./reducer"
import type { Cell, ToolCell, TuiAction, TuiState } from "./types"

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

  it("TURN_ABORTED appends an Interrupted error cell", () => {
    const s = reduce(base(), { type: "INFLIGHT_TEXT", delta: "partial" }, { type: "TURN_ABORTED" })
    expect(s.cells.map((c) => c.kind)).toEqual(["assistant", "error"])
    expect(s.cells.at(-1)).toMatchObject({ message: "Interrupted." })
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

  it("TURN_COMMIT flushes inflight text then inflight.tools to cells", () => {
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
    // After commit: tools are flushed to cells AFTER the text.
    // Order: assistant("before"), assistant("after"), bash(done)
    // Wait — commitPlan/inline logic flushes thinking→text→tools, so tools
    // go AFTER inflight text. The text "before" was committed at TOOL_CALL time,
    // "after" is committed by TURN_COMMIT before tools.
    expect(s.cells.map((c) => c.kind)).toEqual(["assistant", "assistant", "tool"])
    expect((s.cells[2] as ToolCell).status).toBe("done")
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

  it("SET_MODEL and SET_MODE update config and close the overlay", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "model", options: ["a"], index: 0 },
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

  it("OVERLAY_MOVE wraps the three-choice plan-approval overlay", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "plan", raw: "# Plan", index: 0 },
    })
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(1)
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(2)
    s = reduce(s, { type: "OVERLAY_MOVE", delta: 1 })
    expect((s.overlay as { index: number }).index).toBe(0) // wraps past the 3rd choice
    s = reduce(s, { type: "OVERLAY_CLOSE" })
    expect(s.overlay.kind).toBe("none")
  })

  it("OVERLAY_SET_INDEX clamps to the list bounds and no-ops for non-lists", () => {
    let s = reduce(base(), {
      type: "OVERLAY_OPEN",
      overlay: { kind: "model", options: ["a", "b"], index: 0 },
    })
    s = reduce(s, { type: "OVERLAY_SET_INDEX", index: 9 })
    expect((s.overlay as { index: number }).index).toBe(1)
    const usage = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "usage" } })
    expect(reduce(usage, { type: "OVERLAY_SET_INDEX", index: 3 })).toBe(usage)
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

  it("BASH_RESULT no-ops when there is no running bash cell", () => {
    const s0 = base()
    expect(reduce(s0, { type: "BASH_RESULT", output: "x", status: "done" })).toBe(s0)
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
