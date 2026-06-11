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
    expect(s.inflight).toEqual({ text: "answer", thinking: "" })
  })

  it("INFLIGHT_THINKING accumulates reasoning", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_THINKING", delta: "a" },
      { type: "INFLIGHT_THINKING", delta: "b" }
    )
    expect(s.inflight.thinking).toBe("ab")
  })

  it("TOOL_CALL commits inflight text then pushes a running tool cell", () => {
    const s = reduce(
      base(),
      { type: "INFLIGHT_TEXT", delta: "before" },
      { type: "TOOL_CALL", callKey: "bash:{}", toolName: "bash", input: { command: "ls" } }
    )
    expect(s.cells.map((c) => c.kind)).toEqual(["assistant", "tool"])
    expect(s.cells[1]).toMatchObject({
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

  it("TOOL_RESULT fills the most recent matching running tool", () => {
    let s = reduce(base(), {
      type: "TOOL_CALL",
      callKey: "k",
      toolName: "bash",
      input: { command: "ls" },
    })
    s = reduce(s, { type: "TOOL_RESULT", toolName: "bash", result: "file.txt", isError: false })
    const tool = s.cells.find((c) => c.kind === "tool") as ToolCell
    expect(tool.status).toBe("done")
    expect(tool.result).toBe("file.txt")
  })

  it("TOOL_RESULT marks error status", () => {
    let s = reduce(base(), { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} })
    s = reduce(s, { type: "TOOL_RESULT", toolName: "bash", result: "boom", isError: true })
    expect((s.cells.find((c) => c.kind === "tool") as ToolCell).status).toBe("error")
  })

  it("TOOL_RESULT is a no-op when no running tool matches", () => {
    const s0 = base()
    const s = reduce(s0, { type: "TOOL_RESULT", toolName: "bash", result: "x" })
    expect(s).toBe(s0)
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
    let s = reduce(base(), { type: "TOOL_CALL", callKey: "k", toolName: "bash", input: {} })
    const toolId = s.cells[0].id
    s = reduce(s, { type: "TOGGLE_COLLAPSE", id: toolId })
    expect((s.cells[0] as ToolCell).collapsed).toBe(false)
    // Unknown id → unchanged.
    const s2 = reduce(s, { type: "TOGGLE_COLLAPSE", id: "nope" })
    expect(s2.cells[0]).toBe(s.cells[0])
  })

  it("TOGGLE_COLLAPSE leaves a matched non-collapsible cell unchanged", () => {
    const s = reduce(base(), { type: "TURN_START", prompt: "hi" })
    const userId = s.cells[0].id
    const s2 = reduce(s, { type: "TOGGLE_COLLAPSE", id: userId })
    expect(s2.cells[0]).toEqual(s.cells[0])
  })

  it("TOOL_CALL ignores a repeated emission for the same running tool (no duplicate cells)", () => {
    let s = reduce(base(), { type: "INFLIGHT_TEXT", delta: "let me look" })
    s = reduce(s, { type: "TOOL_CALL", callKey: "ls:.", toolName: "ls", input: { path: "." } })
    const afterFirst = s.cells.filter((c) => c.kind === "tool").length
    // A repeated tool-call for the same still-running invocation is a no-op:
    // no second tool cell, and the inflight text is not re-committed.
    s = reduce(s, { type: "TOOL_CALL", callKey: "ls:.", toolName: "ls", input: { path: "." } })
    s = reduce(s, { type: "TOOL_CALL", callKey: "ls:.", toolName: "ls", input: { path: "." } })
    expect(s.cells.filter((c) => c.kind === "tool").length).toBe(afterFirst)
    expect(s.cells.filter((c) => c.kind === "assistant").length).toBe(1)
  })

  it("TOGGLE_COLLAPSE_ALL expands every tool cell, then collapses them all", () => {
    let s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} },
      { type: "TOOL_CALL", callKey: "k2", toolName: "read", input: {} }
    )
    // Both default to collapsed.
    expect(s.cells.every((c) => c.kind !== "tool" || c.collapsed)).toBe(true)
    // First press → any collapsed, so expand all.
    s = reduce(s, { type: "TOGGLE_COLLAPSE_ALL" })
    expect(s.cells.every((c) => c.kind !== "tool" || !c.collapsed)).toBe(true)
    // Second press → none collapsed, so collapse all.
    s = reduce(s, { type: "TOGGLE_COLLAPSE_ALL" })
    expect(s.cells.every((c) => c.kind !== "tool" || c.collapsed)).toBe(true)
  })

  it("TOGGLE_COLLAPSE_ALL expands all when the state is mixed (any collapsed → reveal)", () => {
    let s = reduce(
      base(),
      { type: "TOOL_CALL", callKey: "k1", toolName: "bash", input: {} },
      { type: "TOOL_CALL", callKey: "k2", toolName: "read", input: {} }
    )
    // Expand only the first → mixed state.
    s = reduce(s, { type: "TOGGLE_COLLAPSE", id: s.cells[0].id })
    expect((s.cells[0] as ToolCell).collapsed).toBe(false)
    expect((s.cells[1] as ToolCell).collapsed).toBe(true)
    // Any collapsed → expand all.
    s = reduce(s, { type: "TOGGLE_COLLAPSE_ALL" })
    expect(s.cells.every((c) => c.kind !== "tool" || !c.collapsed)).toBe(true)
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

  it("OVERLAY_OPEN / CLOSE toggle the overlay", () => {
    let s = reduce(base(), { type: "OVERLAY_OPEN", overlay: { kind: "help" } })
    expect(s.overlay.kind).toBe("help")
    s = reduce(s, { type: "OVERLAY_CLOSE" })
    expect(s.overlay.kind).toBe("none")
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

  it("RESET clears usage and session totals", () => {
    const s = reduce(
      base(),
      { type: "SET_USAGE", usage: { inputTokens: 100, totalCostUsd: 1 } },
      { type: "RESET", sessionId: "ses2" }
    )
    expect(s.usage).toBeUndefined()
    expect(s.sessionTotals.costUsd).toBe(0)
  })
})
