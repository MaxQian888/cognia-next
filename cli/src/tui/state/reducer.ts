/**
 * The TUI reducer — the single source of truth for the chat app's screen state.
 *
 * Pure and synchronous: every screen change is an action. Cell ids come from a
 * monotonic `seq` counter (never Date.now / Math.random — both are unavailable
 * in the esbuild build and would make tests non-deterministic).
 *
 * Streaming model: assistant text and reasoning accumulate in `inflight` and are
 * "committed" to permanent cells at tool boundaries and turn end, which keeps
 * the visual order (text → tool → text → …) faithful to arrival order.
 */
import { emptyInputState } from "./initial"
import { isTodoTool, parseTodos } from "../format/tools"
import type { Cell, Inflight, Overlay, ToolCell, TodoCell, TuiAction, TuiState } from "./types"

function makeId(seq: number): string {
  return `c${seq}`
}

/**
 * Commit any pending reasoning + assistant text in `inflight` to permanent
 * cells. Returns the grown cell list, the advanced seq, and a cleared inflight.
 */
function commitInflight(
  cells: Cell[],
  inflight: Inflight,
  seq: number
): { cells: Cell[]; seq: number; inflight: Inflight } {
  let nextSeq = seq
  const next = [...cells]
  if (inflight.thinking.length > 0) {
    next.push({ id: makeId(nextSeq++), kind: "thinking", text: inflight.thinking, collapsed: true })
  }
  if (inflight.text.length > 0) {
    next.push({ id: makeId(nextSeq++), kind: "assistant", raw: inflight.text })
  }
  return { cells: next, seq: nextSeq, inflight: { text: "", thinking: "" } }
}

/** How many selectable rows an overlay has (null = not a movable list). */
function overlayLength(overlay: Overlay): number | null {
  switch (overlay.kind) {
    case "permission":
      return overlay.choices.length
    case "model":
    case "mode":
      return overlay.options.length
    case "sessions":
      return overlay.items.length
    case "files":
      return overlay.completions.length
    default:
      return null
  }
}

// Only ever called for an overlay `overlayLength` reported as indexable, so the
// spread always lands on a member that carries `index`.
function withOverlayIndex(overlay: Overlay, index: number): Overlay {
  return { ...overlay, index } as Overlay
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    // ── Streaming ─────────────────────────────────────────────────────────────
    case "INFLIGHT_TEXT": {
      // First answer text after reasoning flushes the reasoning cell.
      if (state.inflight.thinking.length > 0) {
        const committed = commitInflight(
          state.cells,
          { text: "", thinking: state.inflight.thinking },
          state.seq
        )
        return {
          ...state,
          cells: committed.cells,
          seq: committed.seq,
          inflight: { text: state.inflight.text + action.delta, thinking: "" },
        }
      }
      return { ...state, inflight: { ...state.inflight, text: state.inflight.text + action.delta } }
    }
    case "INFLIGHT_THINKING":
      return {
        ...state,
        inflight: { ...state.inflight, thinking: state.inflight.thinking + action.delta },
      }
    case "TOOL_CALL": {
      const committed = commitInflight(state.cells, state.inflight, state.seq)
      let seq = committed.seq
      const cells = committed.cells
      if (isTodoTool(action.toolName)) {
        const todos = parseTodos(action.input)
        const existingIdx = cells.findIndex((c) => c.kind === "todo")
        if (existingIdx >= 0) {
          const updated = [...cells]
          updated[existingIdx] = { ...(updated[existingIdx] as TodoCell), todos }
          return { ...state, cells: updated, seq, inflight: committed.inflight }
        }
        cells.push({ id: makeId(seq++), kind: "todo", todos })
        return { ...state, cells, seq, inflight: committed.inflight }
      }
      const tool: ToolCell = {
        id: makeId(seq++),
        kind: "tool",
        callKey: action.callKey,
        toolName: action.toolName,
        input: action.input,
        status: "running",
        collapsed: true,
      }
      cells.push(tool)
      return { ...state, cells, seq, inflight: committed.inflight }
    }
    case "TOOL_RESULT": {
      // Fill the most recent still-running tool cell matching the tool name.
      let idx = -1
      for (let i = state.cells.length - 1; i >= 0; i--) {
        const c = state.cells[i]
        if (c.kind === "tool" && c.status === "running" && c.toolName === action.toolName) {
          idx = i
          break
        }
      }
      if (idx < 0) return state
      const updated = [...state.cells]
      updated[idx] = {
        ...(updated[idx] as ToolCell),
        status: action.isError ? "error" : "done",
        result: action.result,
        isError: action.isError,
      }
      return { ...state, cells: updated }
    }

    // ── Turn lifecycle ──────────────────────────────────────────────────────────
    case "TURN_START": {
      const cells = [
        ...state.cells,
        { id: makeId(state.seq), kind: "user", text: action.prompt } as Cell,
      ]
      return {
        ...state,
        cells,
        seq: state.seq + 1,
        inflight: { text: "", thinking: "" },
        turnStatus: "streaming",
        overlay: { kind: "none" },
      }
    }
    case "TURN_COMMIT": {
      const committed = commitInflight(state.cells, state.inflight, state.seq)
      return {
        ...state,
        cells: committed.cells,
        seq: committed.seq,
        inflight: committed.inflight,
        turnStatus: "idle",
        ...(action.result.usage ? { usage: action.result.usage } : {}),
      }
    }
    case "TURN_ERROR": {
      const committed = commitInflight(state.cells, state.inflight, state.seq)
      committed.cells.push({ id: makeId(committed.seq), kind: "error", message: action.message })
      return {
        ...state,
        cells: committed.cells,
        seq: committed.seq + 1,
        inflight: committed.inflight,
        turnStatus: "idle",
      }
    }
    case "TURN_ABORTED": {
      const committed = commitInflight(state.cells, state.inflight, state.seq)
      committed.cells.push({ id: makeId(committed.seq), kind: "error", message: "Interrupted." })
      return {
        ...state,
        cells: committed.cells,
        seq: committed.seq + 1,
        inflight: committed.inflight,
        turnStatus: "idle",
      }
    }

    // ── Cells ────────────────────────────────────────────────────────────────────
    case "TOGGLE_COLLAPSE": {
      const cells = state.cells.map((c) => {
        if (c.id !== action.id) return c
        if (c.kind === "tool" || c.kind === "thinking") {
          return { ...c, collapsed: !c.collapsed }
        }
        return c
      })
      return { ...state, cells }
    }
    case "NOTICE":
      return {
        ...state,
        cells: [...state.cells, { id: makeId(state.seq), kind: "notice", message: action.message }],
        seq: state.seq + 1,
      }
    case "LOAD_CELLS":
      return { ...state, cells: action.cells, inflight: { text: "", thinking: "" } }
    case "RESET":
      return {
        ...state,
        sessionId: action.sessionId,
        cells: [],
        inflight: { text: "", thinking: "" },
        overlay: { kind: "none" },
        usage: undefined,
        turnStatus: "idle",
      }

    // ── Config switches ──────────────────────────────────────────────────────────
    case "SET_MODEL":
      return {
        ...state,
        config: { ...state.config, model: action.model },
        overlay: { kind: "none" },
      }
    case "SET_MODE":
      return {
        ...state,
        config: { ...state.config, permissionMode: action.mode },
        overlay: { kind: "none" },
      }

    // ── Overlays ─────────────────────────────────────────────────────────────────
    case "OVERLAY_OPEN":
      return { ...state, overlay: action.overlay }
    case "OVERLAY_CLOSE":
      return { ...state, overlay: { kind: "none" } }
    case "OVERLAY_MOVE": {
      const len = overlayLength(state.overlay)
      if (len === null || len === 0) return state
      const current = (state.overlay as { index?: number }).index ?? 0
      const next = (((current + action.delta) % len) + len) % len
      return { ...state, overlay: withOverlayIndex(state.overlay, next) }
    }
    case "OVERLAY_SET_INDEX": {
      const len = overlayLength(state.overlay)
      if (len === null) return state
      const clamped = Math.max(0, Math.min(action.index, len - 1))
      return { ...state, overlay: withOverlayIndex(state.overlay, clamped) }
    }

    // ── Input editor ─────────────────────────────────────────────────────────────
    case "INPUT_SET":
      return { ...state, input: { ...state.input, buffer: action.buffer } }
    case "INPUT_HISTORY":
      return { ...state, input: { ...state.input, history: action.history } }
    case "INPUT_ADD_PASTE":
      return {
        ...state,
        input: { ...state.input, pastes: { ...state.input.pastes, [action.id]: action.text } },
      }
    case "INPUT_CLEAR":
      return { ...state, input: emptyInputState() }
    case "INPUT_PUSH_HISTORY": {
      if (action.entry.trim().length === 0) return state
      const entries = [...state.input.history.entries, action.entry]
      return {
        ...state,
        input: { ...emptyInputState(), history: { entries, index: -1, draft: "" } },
      }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────────
    case "CTRL_C":
      return { ...state, lastCtrlCAt: action.at }
    case "EXIT":
      return { ...state, exit: true }

    default:
      return state
  }
}
