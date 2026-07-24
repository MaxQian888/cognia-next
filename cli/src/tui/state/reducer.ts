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
import { filterByQuery } from "../components/select-list-state"
import {
  filterInspectItems,
  filterProviderOptions,
  filterQuickActions,
  filterSelectItems,
  filterSessionItems,
} from "./overlay-search"
import { isTodoTool, parseTodos } from "../format/tools"
import { formatCompactBoundary } from "../format/compaction"
import {
  accumulateModelTotals,
  accumulateUsage,
  contextTokens,
  emptySessionTotals,
  turnCostUsd,
} from "../format/usage"
import { resolveActiveModel, resolveBackendModel } from "../../config/active-model"
import {
  builtinCapabilities as capabilitiesForBuiltin,
  isBuiltinBackend,
} from "../runtime/backend-capabilities"
import {
  isExitPlanTool,
  looksLikePlan,
  looksLikeQuestion,
  planBodyFromExitInput,
  PLAN_APPROVAL_CHOICES,
} from "../runtime/plan"
import type { ModelPricing } from "@cognia/provider-types/provider"
import type {
  Cell,
  Inflight,
  InputBuffer,
  InputEditOp,
  LogEntry,
  McpLogEntry,
  Overlay,
  ToolCell,
  TodoCell,
  ToolStat,
  Toast,
  TuiAction,
  TuiState,
  UsageInfo,
} from "./types"
import {
  insertText,
  insertNewline,
  backspace,
  deleteWordLeft,
  deleteToLineStart,
  deleteToLineEnd,
  moveLeft,
  moveRight,
  moveUp,
  moveDown,
  moveHome,
  moveEnd,
  moveWordLeft,
  moveWordRight,
} from "../input/buffer"

function makeId(seq: number): string {
  return `c${seq}`
}

/** Max transient toasts kept on screen at once (newest win; oldest drop). */
const MAX_TOASTS = 3

/** Max captured MCP log lines kept in the session ring buffer (oldest drop). */
const MAX_MCP_LOGS = 1000
/**
 * Unified log buffer sizing. The buffer is allowed to grow to
 * {@link LOG_HIGH_WATER} before a trim cuts it back to {@link LOG_TRIM_TO} —
 * amortizing the trim's O(n) slice over ~1000 lines instead of paying it on
 * every single append (which is what `MCP_LOG_APPEND` above still does).
 */
const LOG_HIGH_WATER = 2000
const LOG_TRIM_TO = 1000

/** Append a toast, keeping only the most recent {@link MAX_TOASTS}. Pure. */
function pushToast(list: Toast[], toast: Toast): Toast[] {
  const next = [...list, toast]
  return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
}

/**
 * Locate the bash cell a streamed-output action targets. With an `id`, find that
 * exact cell (running or not); without one, fall back to the most recent
 * still-running bash cell (legacy behaviour for callers that don't pass ids).
 */
function bashCellIndex(cells: Cell[], id: string | undefined): number {
  if (id !== undefined) {
    return cells.findIndex((c) => c.id === id && c.kind === "bash")
  }
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]
    if (c.kind === "bash" && c.status === "running") return i
  }
  return -1
}

/** Index of the last user-message cell, or null when there are none. */
function lastUserCellIndex(cells: Cell[]): number | null {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i].kind === "user") return i
  return null
}

/** Index of the nearest user cell from `from` in direction `dir` (-1 earlier,
 * +1 later), or null when there's no further user cell that way. */
function adjacentUserCellIndex(cells: Cell[], from: number, dir: -1 | 1): number | null {
  for (let i = from + dir; i >= 0 && i < cells.length; i += dir) {
    if (cells[i].kind === "user") return i
  }
  return null
}

/** Max per-turn token samples kept for the usage-panel sparkline. */
const USAGE_HISTORY_LIMIT = 60

/** Append one turn's total tokens (prompt incl. cache + output) to the history. */
function pushUsageHistory(history: number[], usage: UsageInfo): number[] {
  const next = [...history, contextTokens(usage) + (usage.outputTokens ?? 0)]
  return next.length > USAGE_HISTORY_LIMIT ? next.slice(next.length - USAGE_HISTORY_LIMIT) : next
}

/** Append one turn's USD cost (SDK figure or priced estimate) to the history. */
function pushCostHistory(
  history: number[],
  usage: UsageInfo,
  pricing?: Partial<ModelPricing>
): number[] {
  const next = [...history, turnCostUsd(usage, pricing)]
  return next.length > USAGE_HISTORY_LIMIT ? next.slice(next.length - USAGE_HISTORY_LIMIT) : next
}

/** Bump a tool's `calls` or `errors` tally (creating the entry on first sight). */
function bumpToolStat(
  stats: Record<string, ToolStat>,
  toolName: string,
  field: keyof ToolStat
): Record<string, ToolStat> {
  const prev = stats[toolName] ?? { calls: 0, errors: 0 }
  return { ...stats, [toolName]: { ...prev, [field]: prev[field] + 1 } }
}

/** Max composer-history entries kept in memory (matches the persisted cap). */
const HISTORY_LIMIT = 100

/** Max undo/redo snapshots kept per composer draft. */
const UNDO_LIMIT = 100

/** Push onto an undo/redo stack, dropping the oldest entry past the cap. */
function pushBounded(stack: InputBuffer[], entry: InputBuffer): InputBuffer[] {
  const next = [...stack, entry]
  return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next
}

/** Apply one editor op to a buffer (the reducer side of INPUT_EDIT). */
function applyInputEdit(buffer: InputBuffer, edit: InputEditOp): InputBuffer {
  switch (edit.op) {
    case "insert":
      return insertText(buffer, edit.text)
    case "newline":
      return insertNewline(buffer)
    case "backspace":
      return backspace(buffer)
    case "delete-word":
      return deleteWordLeft(buffer)
    case "kill-to-start":
      return deleteToLineStart(buffer)
    case "kill-to-end":
      return deleteToLineEnd(buffer)
    case "move":
      return {
        left: moveLeft,
        right: moveRight,
        up: moveUp,
        down: moveDown,
        home: moveHome,
        end: moveEnd,
        "word-left": moveWordLeft,
        "word-right": moveWordRight,
      }[edit.dir](buffer)
  }
}

function sameBufferText(a: InputBuffer, b: InputBuffer): boolean {
  if (a.lines === b.lines) return true
  if (a.lines.length !== b.lines.length) return false
  for (let i = 0; i < a.lines.length; i++) {
    if (a.lines[i] !== b.lines[i]) return false
  }
  return true
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
  return { cells: next, seq: nextSeq, inflight: { text: "", thinking: "", tools: inflight.tools } }
}

/**
 * Commit a proposed plan to a {@link PlanCell} and derive the `lastPlan` record
 * the App watches to open the approval overlay. Shared by both triggers:
 *   • the `ExitPlanMode` tool signal (`keepText: true` — the inflight narration
 *     before the tool call is committed as a normal assistant cell, the plan
 *     body comes from the tool input);
 *   • the `looksLikePlan` fallback in TURN_COMMIT (`keepText: false` — the
 *     inflight text *is* the plan, so it becomes the PlanCell, not an assistant
 *     cell).
 * Pending reasoning is always flushed first. `prevRaw` (the superseded plan)
 * drives the revision diff badge on a refine.
 */
function commitPlan(
  cells: Cell[],
  inflight: Inflight,
  seq: number,
  raw: string,
  prevRaw: string | undefined,
  opts: { keepText: boolean }
): {
  cells: Cell[]
  seq: number
  inflight: Inflight
  lastPlan: { raw: string; seq: number; prevRaw?: string }
} {
  let nextSeq = seq
  const next = [...cells]
  if (inflight.thinking.length > 0) {
    next.push({ id: makeId(nextSeq++), kind: "thinking", text: inflight.thinking, collapsed: true })
  }
  if (opts.keepText && inflight.text.length > 0) {
    next.push({ id: makeId(nextSeq++), kind: "assistant", raw: inflight.text })
  }
  const planSeq = nextSeq
  next.push({ id: makeId(nextSeq++), kind: "plan", raw })
  return {
    cells: next,
    seq: nextSeq,
    inflight: { text: "", thinking: "", tools: inflight.tools },
    lastPlan: { raw, seq: planSeq, ...(prevRaw ? { prevRaw } : {}) },
  }
}

/** How many selectable rows an overlay has (null = not a movable list). */
function overlayLength(overlay: Overlay): number | null {
  switch (overlay.kind) {
    case "permission":
      return overlay.choices.length
    case "model":
      // The `/model` overlay navigates the FILTERED view, so its length must
      // reflect the active typeahead query (else OVERLAY_MOVE/SET_INDEX would
      // range over hidden rows and the highlight could land off-screen).
      return filterByQuery(overlay.options, overlay.query).length
    case "mode":
      return overlay.options.length
    case "provider":
      // The `/provider` picker navigates the FILTERED view (same reason as
      // `model`), so the length must reflect the active typeahead query.
      return filterProviderOptions(overlay.options, overlay.query ?? "").length
    case "config":
      return overlay.rows.length
    case "subagentModels":
      return overlay.rows.length
    case "settings":
      return overlay.sections[overlay.section]?.rows.length ?? 0
    case "sessions":
      // Searchable overlays navigate the FILTERED view (same reason as `model`),
      // so the length must reflect the active typeahead query.
      return filterSessionItems(overlay.items, overlay.query ?? "").length
    case "select":
      return filterSelectItems(overlay.items, overlay.query ?? "").length
    case "inspect":
      return filterInspectItems(overlay.items, overlay.query ?? "").length
    case "quickActions":
      return filterQuickActions(overlay.rows, overlay.query ?? "").length
    case "files":
      return overlay.completions.length
    case "plan":
      return PLAN_APPROVAL_CHOICES.length
    default:
      return null
  }
}

// Only ever called for an overlay `overlayLength` reported as indexable, so the
// spread always lands on a member that carries `index`.
function withOverlayIndex(overlay: Overlay, index: number): Overlay {
  return { ...overlay, index } as Overlay
}

/** Actions that signal live stream activity — each bumps `streamSeq` so the App
 * can timestamp "last activity" for the stall hint without the reducer touching
 * a clock (which is unavailable in the build and would break determinism). */
const STREAM_ACTIVITY = new Set<TuiAction["type"]>([
  "INFLIGHT_TEXT",
  "INFLIGHT_THINKING",
  "TOOL_CALL",
  "TOOL_UPDATE",
  "TOOL_RESULT",
  "SET_USAGE",
])

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  const next = reduceInner(state, action)
  // Bump the monotonic stream-activity counter on each delta (only when the
  // action actually produced new state) so the stall watcher re-arms.
  return next !== state && STREAM_ACTIVITY.has(action.type)
    ? { ...next, streamSeq: next.streamSeq + 1 }
    : next
}

function reduceInner(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    // ── Streaming ─────────────────────────────────────────────────────────────
    case "INFLIGHT_TEXT": {
      // First answer text after reasoning flushes the reasoning cell.
      if (state.inflight.thinking.length > 0) {
        const committed = commitInflight(
          state.cells,
          { text: "", thinking: state.inflight.thinking, tools: state.inflight.tools },
          state.seq
        )
        return {
          ...state,
          cells: committed.cells,
          seq: committed.seq,
          inflight: {
            text: state.inflight.text + action.delta,
            thinking: "",
            tools: state.inflight.tools,
          },
        }
      }
      return { ...state, inflight: { ...state.inflight, text: state.inflight.text + action.delta } }
    }
    case "INFLIGHT_THINKING":
      return {
        ...state,
        inflight: { ...state.inflight, thinking: state.inflight.thinking + action.delta },
      }
    case "COMMIT_PLAN": {
      // Programmatic plan capture from the `/plan explore` pipeline: the Plan
      // subagent's markdown IS the plan (no ExitPlanMode tool call). Route it
      // through the SAME commit path as the tool signal so it lands in `lastPlan`
      // and the App opens the approval overlay. Independent of permission mode —
      // the pipeline can be kicked from any mode.
      const raw = action.raw.trim()
      if (!raw) return state
      const p = commitPlan(state.cells, state.inflight, state.seq, raw, state.lastPlan?.raw, {
        keepText: true,
      })
      return {
        ...state,
        cells: p.cells,
        seq: p.seq,
        inflight: p.inflight,
        lastPlan: p.lastPlan,
        planCapturedThisTurn: true,
      }
    }
    case "TOOL_CALL": {
      // Primary plan-ready signal: in plan mode, an `ExitPlanMode` /
      // `exit_plan_mode` tool call means the agent is presenting its final plan
      // (never a clarifying question — those stay plain text). Capture the plan
      // body from the tool input into a PlanCell + `lastPlan` (the App opens the
      // approval overlay) and DON'T render a ⏳ tool cell for it. The
      // `planCapturedThisTurn` flag both suppresses the TURN_COMMIT heuristic
      // and guards against a duplicate capture from an assistant-snapshot echo.
      if (state.config.permissionMode === "plan" && isExitPlanTool(action.toolName)) {
        if (state.planCapturedThisTurn) return state
        const body = planBodyFromExitInput(action.input)
        if (body) {
          const p = commitPlan(state.cells, state.inflight, state.seq, body, state.lastPlan?.raw, {
            keepText: true,
          })
          return {
            ...state,
            cells: p.cells,
            seq: p.seq,
            inflight: p.inflight,
            lastPlan: p.lastPlan,
            planCapturedThisTurn: true,
          }
        }
        // Malformed input (no usable plan body): fall through to render it as a
        // normal tool cell rather than swallowing the call.
      }
      // Defensive dedup: if the most recent running tool in inflight has the same
      // callKey, this is a repeated emission for the same invocation (assistant
      // snapshots echo completed tool_use blocks). Ignore it so we don't
      // re-commit inflight text and stack duplicate cells.
      const runningTools = state.inflight.tools.filter((t) => t.status === "running")
      const lastRunning = runningTools[runningTools.length - 1]
      if (lastRunning && lastRunning.callKey === action.callKey) {
        return state
      }
      // ── flush completed tools → cells (in original order) ─────────────────
      // Tools that already resolved stay in inflight.tools so they re-render live
      // (⏳→✓). They are only moved to `<Static>` cells at the NEXT commit
      // boundary — a follow-on TOOL_CALL or TURN_COMMIT — so the transcript order
      // is: text-before-tool → tool(done) → text-after-tool → next-tool.
      let seq = state.seq
      const cells = [...state.cells]
      const remainingTools: ToolCell[] = []
      for (const t of state.inflight.tools) {
        if (t.status !== "running") {
          cells.push(t)
        } else {
          remainingTools.push(t)
        }
      }
      // ── commit pending inflight text/thinking ────────────────────────────
      if (state.inflight.thinking.length > 0) {
        cells.push({
          id: makeId(seq++),
          kind: "thinking",
          text: state.inflight.thinking,
          collapsed: true,
        })
      }
      if (state.inflight.text.length > 0) {
        cells.push({ id: makeId(seq++), kind: "assistant", raw: state.inflight.text })
      }
      // ── todo tool still merges into a single cell (not a per-call cell) ─
      const toolStats = bumpToolStat(state.toolStats, action.toolName, "calls")
      if (isTodoTool(action.toolName)) {
        const todos = parseTodos(action.input)
        const existingIdx = cells.findIndex((c) => c.kind === "todo")
        if (existingIdx >= 0) {
          const updated = [...cells]
          updated[existingIdx] = { ...(updated[existingIdx] as TodoCell), todos }
          return {
            ...state,
            cells: updated,
            seq,
            inflight: { text: "", thinking: "", tools: remainingTools },
            toolStats,
          }
        }
        cells.push({ id: makeId(seq++), kind: "todo", todos })
        return {
          ...state,
          cells,
          seq,
          inflight: { text: "", thinking: "", tools: remainingTools },
          toolStats,
        }
      }
      // ── add the new tool to the live inflight area ───────────────────────
      const tool: ToolCell = {
        id: makeId(seq++),
        kind: "tool",
        callKey: action.callKey,
        toolName: action.toolName,
        ...(action.displayTitle ? { displayTitle: action.displayTitle } : {}),
        input: action.input,
        status: "running",
        // Tools collapse by default (Claude-Code look); a user pref can flip it.
        collapsed: state.config.render?.collapseToolsByDefault !== false,
      }
      remainingTools.push(tool)
      return {
        ...state,
        cells,
        seq,
        inflight: { text: "", thinking: "", tools: remainingTools },
        toolStats,
      }
    }
    case "TOOL_UPDATE": {
      const patch = (cell: ToolCell): ToolCell => ({
        ...cell,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.displayTitle ? { displayTitle: action.displayTitle } : {}),
        ...(action.input ? { input: { ...cell.input, ...action.input } } : {}),
      })
      const inflightIdx = state.inflight.tools.findIndex((c) => c.callKey === action.callKey)
      if (inflightIdx >= 0) {
        const tools = [...state.inflight.tools]
        tools[inflightIdx] = patch(tools[inflightIdx])
        return { ...state, inflight: { ...state.inflight, tools } }
      }
      const cellIdx = state.cells.findIndex(
        (c) => c.kind === "tool" && c.callKey === action.callKey
      )
      if (cellIdx >= 0) {
        const cells = [...state.cells]
        cells[cellIdx] = patch(cells[cellIdx] as ToolCell)
        return { ...state, cells }
      }
      // The update outran its `TOOL_CALL` (or the call was never announced):
      // materialize the card rather than dropping the content. Idempotent —
      // every later update for this key now finds it above.
      const created: ToolCell = {
        id: makeId(state.seq),
        kind: "tool",
        callKey: action.callKey,
        toolName: action.toolName ?? "external",
        ...(action.displayTitle ? { displayTitle: action.displayTitle } : {}),
        input: action.input ?? {},
        status: "running",
        collapsed: state.config.render?.collapseToolsByDefault !== false,
      }
      return {
        ...state,
        seq: state.seq + 1,
        inflight: { ...state.inflight, tools: [...state.inflight.tools, created] },
      }
    }
    case "TOOL_RESULT": {
      // Pair the result with its running tool cell, most-specific match first:
      //   1. exact callKey (set when the result correlated to its tool_use),
      //   2. oldest running cell of the same tool name,
      //   3. the sole running cell — but ONLY when exactly one is in flight, so a
      //      nameless/keyless result can't be mis-attached to the wrong card when
      //      several different tools run concurrently.
      // Search inflight.tools first — tool cells now live there during the turn
      // so status transitions (⏳→✓) re-render in the live frame. Fall back to
      // cells for edge cases (e.g. a stale result arriving after the turn ended).
      const runningOf = (tools: ToolCell[], pred: (c: ToolCell) => boolean): number =>
        tools.findIndex((c) => c.status === "running" && pred(c))
      const soleRunning = (tools: ToolCell[]): number => {
        const running = tools.filter((c) => c.status === "running")
        return running.length === 1 ? tools.indexOf(running[0]) : -1
      }
      let idx = action.callKey
        ? runningOf(state.inflight.tools, (c) => c.callKey === action.callKey)
        : -1
      if (idx < 0 && action.toolName)
        idx = runningOf(state.inflight.tools, (c) => c.toolName === action.toolName)
      // The sole-running fallback is ONLY for a nameless, keyless result — a
      // result that DID carry a key/name but matched nothing (a late/duplicate
      // result, or its tool already moved to cells) must NOT be force-attached to
      // an unrelated tool that happens to be the lone one in flight.
      if (idx < 0 && !action.callKey && !action.toolName) idx = soleRunning(state.inflight.tools)
      if (idx >= 0) {
        // Found in inflight — update in place so the live frame re-renders it
        // (⏳→✓/✗). Do NOT move it to cells yet; it stays in inflight.tools until
        // the next commit boundary (TOOL_CALL / TURN_COMMIT), preserving the
        // natural text→result ordering.
        const updated = [...state.inflight.tools]
        const matched = updated[idx] as ToolCell
        updated[idx] = {
          ...matched,
          status: action.isError ? "error" : "done",
          result: action.result,
          isError: action.isError,
        }
        const toolStats = action.isError
          ? bumpToolStat(state.toolStats, matched.toolName, "errors")
          : state.toolStats
        return { ...state, inflight: { ...state.inflight, tools: updated }, toolStats }
      }
      // Fallback: search cells for running tools (stale result after turn end,
      // or a pre-existing cell from a restored session).
      const cellIdx = action.callKey
        ? state.cells.findIndex(
            (c) => c.kind === "tool" && c.status === "running" && c.callKey === action.callKey
          )
        : -1
      let fallbackIdx = cellIdx
      if (fallbackIdx < 0 && action.toolName)
        fallbackIdx = state.cells.findIndex(
          (c) => c.kind === "tool" && c.status === "running" && c.toolName === action.toolName
        )
      if (fallbackIdx < 0 && !action.callKey && !action.toolName) {
        // Same single-candidate guard as inflight, and likewise only for a
        // nameless, keyless result: pair it to a lone running cell, never guess
        // among several and never override an unmatched keyed/named result.
        const running = state.cells.filter((c) => c.kind === "tool" && c.status === "running")
        if (running.length === 1) fallbackIdx = state.cells.indexOf(running[0])
      }
      if (fallbackIdx < 0) return state
      const updated = [...state.cells]
      const matched = updated[fallbackIdx] as ToolCell
      updated[fallbackIdx] = {
        ...matched,
        status: action.isError ? "error" : "done",
        result: action.result,
        isError: action.isError,
      }
      // Tally the error against the cell we actually matched — the action's
      // toolName may be empty when the result couldn't be correlated.
      const toolStats = action.isError
        ? bumpToolStat(state.toolStats, matched.toolName, "errors")
        : state.toolStats
      return { ...state, cells: updated, toolStats }
    }

    // ── Usage (per-turn, streamed from the SDK result message) ──────────────────
    case "SET_USAGE": {
      // Attribute this turn to the model that ran it (resolved from the active
      // config) so the panel can break usage down per model like `/usage`.
      const turnModel = resolveActiveModel(state.config) ?? "default"
      return {
        ...state,
        usage: action.usage,
        sessionTotals: accumulateUsage(state.sessionTotals, action.usage, state.modelMeta?.pricing),
        modelTotals: accumulateModelTotals(
          state.modelTotals,
          turnModel,
          action.usage,
          state.modelMeta?.pricing
        ),
        usageHistory: pushUsageHistory(state.usageHistory, action.usage),
        costHistory: pushCostHistory(state.costHistory, action.usage, state.modelMeta?.pricing),
        usageSeenThisTurn: true,
      }
    }
    case "SET_RATE_LIMITS":
      // Account-level live quota — persists across /clear (a fresh chat doesn't
      // reset the API key's per-window remaining), overwritten by each response.
      return { ...state, rateLimits: action.snapshot }
    case "SET_MODEL_META":
      return { ...state, modelMeta: action.meta }

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
        inflight: { text: "", thinking: "", tools: [] },
        // A new turn's reveal must start from zero rather than inherit the
        // previous turn's character count.
        streamEpoch: state.streamEpoch + 1,
        turnStatus: "streaming",
        usageSeenThisTurn: false,
        planCapturedThisTurn: false,
        overlay: { kind: "none" },
        // A fresh send respawns a dead sidecar, so clear the "backend down" flag.
        sidecarDown: false,
      }
    }
    case "TURN_COMMIT": {
      // Guarded fallback to the text heuristic: only when the structured
      // ExitPlanMode signal did NOT already capture a plan this turn, we're in
      // plan mode, the reply reads like a plan, AND it is not a clarifying
      // question. The exit-plan tool (handled in TOOL_CALL) is the primary
      // trigger; this catches providers/cases that present a plan as plain text.
      const isPlan =
        !state.planCapturedThisTurn &&
        state.config.permissionMode === "plan" &&
        looksLikePlan(state.inflight.text) &&
        !looksLikeQuestion(state.inflight.text)
      // Flush any remaining inflight tools BEFORE committing the trailing text.
      // A tool's preceding narration was already committed at its own TOOL_CALL,
      // so whatever text sits in inflight now streamed AFTER these tools — and the
      // live Inflight frame renders tools above that text. Committing text first
      // would flip a finished tool card below the final answer (the "tool output
      // ends up after the answer" bug). Seeding the commit base with the tools
      // keeps the static transcript order identical to the live frame.
      const baseCells =
        state.inflight.tools.length > 0 ? [...state.cells, ...state.inflight.tools] : state.cells
      let committed: { cells: Cell[]; seq: number; inflight: Inflight }
      let lastPlan = state.lastPlan
      if (isPlan) {
        const p = commitPlan(
          baseCells,
          state.inflight,
          state.seq,
          state.inflight.text,
          state.lastPlan?.raw,
          { keepText: false }
        )
        committed = { cells: p.cells, seq: p.seq, inflight: p.inflight }
        lastPlan = p.lastPlan
      } else {
        committed = commitInflight(baseCells, state.inflight, state.seq)
      }
      const finalCells = committed.cells
      // The native Anthropic path streams usage via SET_USAGE; only fall back to
      // the resolved result's usage when no stream event landed (ai-sdk path),
      // so a turn's tokens/cost are never counted twice.
      const fallbackUsage =
        !state.usageSeenThisTurn && action.result.usage ? action.result.usage : undefined
      return {
        ...state,
        cells: finalCells,
        seq: committed.seq,
        inflight: { text: "", thinking: "", tools: [] },
        turnStatus: "idle",
        lastPlan,
        lastCompletion: { kind: "turn", status: "done", label: "Response ready" },
        ...(fallbackUsage
          ? {
              usage: fallbackUsage,
              sessionTotals: accumulateUsage(
                state.sessionTotals,
                fallbackUsage,
                state.modelMeta?.pricing
              ),
              modelTotals: accumulateModelTotals(
                state.modelTotals,
                resolveActiveModel(state.config) ?? "default",
                fallbackUsage,
                state.modelMeta?.pricing
              ),
              usageHistory: pushUsageHistory(state.usageHistory, fallbackUsage),
              costHistory: pushCostHistory(
                state.costHistory,
                fallbackUsage,
                state.modelMeta?.pricing
              ),
            }
          : {}),
      }
    }
    case "TURN_ERROR": {
      // Flush tools before the trailing text (see TURN_COMMIT) so an interrupted
      // turn's finished tool cards stay above the partial answer, not below it.
      const baseCells =
        state.inflight.tools.length > 0 ? [...state.cells, ...state.inflight.tools] : state.cells
      const committed = commitInflight(baseCells, state.inflight, state.seq)
      const finalCells = committed.cells
      finalCells.push({
        id: makeId(committed.seq),
        kind: "error",
        message: action.message,
        ...(action.hint ? { hint: action.hint } : {}),
        ...(action.category ? { category: action.category } : {}),
      })
      return {
        ...state,
        cells: finalCells,
        seq: committed.seq + 1,
        inflight: { text: "", thinking: "", tools: [] },
        turnStatus: "idle",
        lastCompletion: { kind: "turn", status: "error", label: action.title ?? "Error" },
      }
    }
    case "TURN_ABORTED": {
      // Flush tools before the trailing text (see TURN_COMMIT) so an aborted
      // turn's finished tool cards stay above the partial answer, not below it.
      const baseCells =
        state.inflight.tools.length > 0 ? [...state.cells, ...state.inflight.tools] : state.cells
      const committed = commitInflight(baseCells, state.inflight, state.seq)
      const finalCells = committed.cells
      finalCells.push({ id: makeId(committed.seq), kind: "error", message: "Interrupted." })
      return {
        ...state,
        cells: finalCells,
        seq: committed.seq + 1,
        inflight: { text: "", thinking: "", tools: [] },
        turnStatus: "idle",
        lastCompletion: { kind: "turn", status: "aborted", label: "Interrupted" },
      }
    }

    // ── Background activity ────────────────────────────────────────────────────
    case "ACTIVITY_START":
      return {
        ...state,
        activity: {
          kind: action.kind,
          label: action.label,
          status: "running",
          ...(action.max !== undefined ? { max: action.max } : {}),
        },
      }
    case "ACTIVITY_PROGRESS":
      if (!state.activity) return state
      return {
        ...state,
        activity: {
          ...state.activity,
          turns: action.turns ?? state.activity.turns,
          note: action.note ?? state.activity.note,
        },
      }
    case "ACTIVITY_END": {
      // Human label for the notification + the error toast, derived from the
      // running activity (kind + label) so a run that ends while you're tabbed
      // away is identifiable. Falls back to a generic phrase if the pill is gone.
      const runLabel = state.activity
        ? `${state.activity.label || state.activity.kind} ${action.status}`
        : `Background run ${action.status}`
      let seq = state.seq
      const cells = [...state.cells]
      if (action.summary) {
        cells.push({ id: makeId(seq++), kind: "notice" as const, message: action.summary })
      }
      // An errored run used to vanish silently when it carried no summary — the
      // pill just disappeared. Always surface the failure as an error toast so it
      // can't pass unnoticed (in addition to any summary notice above).
      let toasts = state.toasts
      if (action.status === "error") {
        toasts = pushToast(toasts, {
          id: makeId(seq++),
          severity: "error",
          message: runLabel,
          ...(action.summary ? {} : { hint: "See the transcript above for details." }),
        })
      }
      return {
        ...state,
        cells,
        seq,
        toasts,
        activity: undefined,
        lastCompletion: { kind: "activity", status: action.status, label: runLabel },
      }
    }
    case "WORKFLOW_RUN_START":
      return { ...state, workflowRun: { steps: action.steps, completed: 0 } }
    case "WORKFLOW_RUN_STEP":
      return {
        ...state,
        workflowRun: {
          steps: action.steps,
          completed: action.completed,
          ...(action.currentId !== undefined ? { currentId: action.currentId } : {}),
          ...(action.usage !== undefined ? { usage: action.usage } : {}),
          ...(action.events !== undefined ? { events: action.events } : {}),
        },
      }
    case "WORKFLOW_RUN_END":
      return { ...state, workflowRun: undefined }

    // ── Workflow Copilot mode ──────────────────────────────────────────────────
    case "COPILOT_ENTER":
      return {
        ...state,
        copilot: {
          workflowId: action.workflowId,
          name: action.name,
          isNew: action.isNew,
          dirty: action.isNew,
        },
      }
    case "COPILOT_EXIT":
      return { ...state, copilot: undefined }
    case "COPILOT_SET_PROPOSAL":
      if (!state.copilot) return state
      return { ...state, copilot: { ...state.copilot, pendingProposalId: action.proposalId } }
    case "COPILOT_CLEAR_PROPOSAL": {
      if (!state.copilot) return state
      const { pendingProposalId: _drop, ...rest } = state.copilot
      return { ...state, copilot: rest }
    }
    case "COPILOT_MARK_DIRTY":
      if (!state.copilot) return state
      return { ...state, copilot: { ...state.copilot, dirty: true } }

    // ── Shell-out ────────────────────────────────────────────────────────────────
    case "BASH_START":
      return {
        ...state,
        cells: [
          ...state.cells,
          {
            id: action.id ?? makeId(state.seq),
            kind: "bash",
            command: action.command,
            output: "",
            status: "running",
          },
        ],
        seq: state.seq + 1,
      }
    case "BASH_APPEND": {
      // Stream a chunk into the target bash cell so output appears live (the
      // fullscreen transcript re-renders in place). With an `id`, target that
      // cell exactly; otherwise the most recent still-running one. A no-op when
      // the cell is gone / already settled (the result already landed).
      const idx = bashCellIndex(state.cells, action.id)
      if (idx < 0) return state
      const updated = [...state.cells]
      const cell = updated[idx] as Extract<Cell, { kind: "bash" }>
      updated[idx] = { ...cell, output: cell.output + action.chunk }
      return { ...state, cells: updated }
    }
    case "BASH_RESULT": {
      const idx = bashCellIndex(state.cells, action.id)
      if (idx < 0) return state
      const updated = [...state.cells]
      updated[idx] = {
        ...(updated[idx] as Extract<Cell, { kind: "bash" }>),
        output: action.output,
        status: action.status,
        // The command has settled — drop the background marker so the cell
        // renders as a plain done/error result.
        background: false,
        ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
      }
      return { ...state, cells: updated }
    }
    case "BASH_BACKGROUND": {
      const updated = state.cells.map((c) =>
        c.id === action.id && c.kind === "bash" && c.status === "running"
          ? { ...c, background: true }
          : c
      )
      return { ...state, cells: updated }
    }
    case "BASH_FOREGROUND": {
      // Only a still-running cell can come back to the foreground; every other
      // running bash cell is demoted so at most one renders as foreground.
      const target = state.cells.find(
        (c) => c.id === action.id && c.kind === "bash" && c.status === "running"
      )
      if (!target) return state
      const updated = state.cells.map((c) =>
        c.kind === "bash" && c.status === "running" ? { ...c, background: c.id !== action.id } : c
      )
      return { ...state, cells: updated }
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
    case "TOGGLE_COLLAPSE_ALL": {
      // If anything is currently collapsed, expand everything; otherwise collapse
      // everything — so the first press always reveals tool output, the next hides.
      const anyCollapsed = state.cells.some(
        (c) => (c.kind === "tool" || c.kind === "thinking") && c.collapsed
      )
      const next = !anyCollapsed
      const cells = state.cells.map((c) =>
        c.kind === "tool" || c.kind === "thinking" ? { ...c, collapsed: next } : c
      )
      // Bump the epoch: committed cells live in `<Static>`, which never
      // re-renders in place, so the new collapsed state only shows after a
      // forced re-print.
      return { ...state, cells, renderEpoch: state.renderEpoch + 1 }
    }
    case "TOGGLE_VERBOSE":
      return { ...state, verbose: !state.verbose, renderEpoch: state.renderEpoch + 1 }
    case "REPAINT":
      return { ...state, renderEpoch: state.renderEpoch + 1 }
    // Backtrack selection drives a highlight on the chosen user cell. In the
    // scrollback layout that highlight lives in `<Static>`, which never repaints
    // in place — so every selection change bumps `renderEpoch` to force a
    // re-print (paired with a `clearScreen()` at the dispatch site). The
    // fullscreen layout re-renders live and ignores the epoch, so the bump is a
    // harmless no-op there.
    case "BACKTRACK_ENTER": {
      const index = lastUserCellIndex(state.cells)
      return index === null
        ? state
        : { ...state, backtrack: { index }, renderEpoch: state.renderEpoch + 1 }
    }
    case "BACKTRACK_MOVE": {
      if (!state.backtrack) return state
      const next = adjacentUserCellIndex(state.cells, state.backtrack.index, action.dir)
      return next === null
        ? state
        : { ...state, backtrack: { index: next }, renderEpoch: state.renderEpoch + 1 }
    }
    case "BACKTRACK_CANCEL":
      return state.backtrack
        ? { ...state, backtrack: undefined, renderEpoch: state.renderEpoch + 1 }
        : state
    case "BACKTRACK_COMMIT":
      return {
        ...state,
        backtrack: undefined,
        editTarget: { index: action.index },
        renderEpoch: state.renderEpoch + 1,
      }
    case "EDIT_CLEAR":
      return state.editTarget ? { ...state, editTarget: undefined } : state
    case "NOTICE": {
      const cells = [
        ...state.cells,
        { id: makeId(state.seq), kind: "notice" as const, message: action.message },
      ]
      // When flagged, also surface a transient toast so the message isn't lost in
      // scrollback (uses a second seq tick for a stable, unique toast id).
      if (action.toast) {
        const toastId = makeId(state.seq + 1)
        return {
          ...state,
          cells,
          seq: state.seq + 2,
          toasts: pushToast(state.toasts, {
            id: toastId,
            severity: action.severity ?? "info",
            message: action.message,
          }),
        }
      }
      return { ...state, cells, seq: state.seq + 1 }
    }
    case "TOAST_PUSH":
      return {
        ...state,
        toasts: pushToast(state.toasts, {
          id: makeId(state.seq),
          severity: action.severity,
          message: action.message,
          ...(action.hint ? { hint: action.hint } : {}),
        }),
        seq: state.seq + 1,
      }
    case "TOAST_DISMISS":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case "SIDECAR_STATUS":
      return { ...state, sidecarDown: action.down }
    case "COMPACT_BOUNDARY":
      // Render the boundary inline as a notice cell (reuses the notice renderer).
      return {
        ...state,
        cells: [
          ...state.cells,
          {
            id: makeId(state.seq),
            kind: "notice",
            message: formatCompactBoundary(action.trigger, action.preTokens, action.postTokens),
          },
        ],
        seq: state.seq + 1,
      }
    case "LOAD_CELLS":
      return { ...state, cells: action.cells, inflight: { text: "", thinking: "", tools: [] } }
    case "SET_INIT_DRAFT":
      return { ...state, initDraft: { target: action.target, content: action.content } }
    case "CLEAR_INIT_DRAFT":
      return { ...state, initDraft: undefined }
    case "SET_COMMIT_DRAFT":
      return { ...state, commitDraft: { message: action.message } }
    case "CLEAR_COMMIT_DRAFT":
      return { ...state, commitDraft: undefined }
    case "SET_PR_DRAFT":
      return { ...state, prDraft: { title: action.title, body: action.body, base: action.base } }
    case "CLEAR_PR_DRAFT":
      return { ...state, prDraft: undefined }
    case "RESET":
      return {
        ...state,
        sessionId: action.sessionId,
        cells: [],
        inflight: { text: "", thinking: "", tools: [] },
        overlay: { kind: "none" },
        usage: undefined,
        sessionTotals: emptySessionTotals(),
        modelTotals: {},
        usageHistory: [],
        toolStats: {},
        usageSeenThisTurn: false,
        turnStatus: "idle",
        lastPlan: undefined,
        planCapturedThisTurn: false,
        initDraft: undefined,
        commitDraft: undefined,
        prDraft: undefined,
        backtrack: undefined,
        editTarget: undefined,
        toasts: [],
        sidecarDown: false,
      }

    // ── Config switches ──────────────────────────────────────────────────────────
    case "SET_MODEL": {
      // Remember the model for the ACTIVE provider (per-provider memory) and
      // mirror it onto the top-level `model` the displays read. Keying it to the
      // provider is what stops the pick from bleeding onto other providers.
      //
      // On an external backend the pick belongs to THAT agent, not to the
      // built-in chat provider: writing it into `providers[provider]` would make
      // choosing a Codex model silently rewrite the model the built-in sidecar
      // runs with. It goes to the per-backend namespace instead, keyed by the
      // resolved preset id.
      const externalKey = isBuiltinBackend(state.config.agentBackend)
        ? undefined
        : (state.backendCapabilities?.presetId ?? state.config.agentBackend)
      return {
        ...state,
        config: {
          ...state.config,
          model: action.model,
          ...(externalKey
            ? {
                agentBackends: {
                  ...state.config.agentBackends,
                  [externalKey]: {
                    ...state.config.agentBackends?.[externalKey],
                    model: action.model,
                  },
                },
              }
            : {
                providers: {
                  ...state.config.providers,
                  [state.config.provider]: {
                    ...state.config.providers[state.config.provider],
                    model: action.model,
                  },
                },
              }),
        },
        // Discard the per-model context window + pricing from the PREVIOUS model
        // — the App's useEffect will fire resolveMeta for the new model and land
        // SET_MODEL_META, but until then the Footer falls back to the pattern table
        // (which keys on config.model, already updated). Without this, a stale
        // contextWindow from the old model would win over the fallback.
        modelMeta: undefined,
        overlay: { kind: "none" },
      }
    }
    case "SET_MODE":
      return {
        ...state,
        config: { ...state.config, permissionMode: action.mode },
        overlay: { kind: "none" },
      }
    case "SET_THINKING":
      return {
        ...state,
        config: {
          ...state.config,
          thinkingLevel: action.level,
          // The effort slider couples `"ultracode"` to the dynamic-workflow
          // plugin tools, so it passes the resolved gate alongside the level.
          ...(action.pluginTools !== undefined ? { pluginTools: action.pluginTools } : {}),
        },
        overlay: { kind: "none" },
      }
    case "SET_PROVIDER": {
      // Switching provider re-points the displayed model to THAT provider's
      // remembered model (or its catalog default) so a previous provider's model
      // never lingers on screen. `resolveActiveModel` ignores the stale top-level
      // pin for a known provider, so no Claude-id bleed.
      // Backend-aware: while an external agent is answering, the built-in
      // provider's model is not what runs, so switching provider must not
      // re-point `config.model` at it — that would undo the honest "no model"
      // and start sending the built-in id to the external agent again.
      const nextConfig = { ...state.config, provider: action.provider }
      return {
        ...state,
        config: {
          ...nextConfig,
          model: resolveBackendModel(nextConfig, state.backendCapabilities?.presetId),
        },
        // Discard the per-model context window from the previous provider's model
        // — same reasoning as SET_MODEL above.
        modelMeta: undefined,
        overlay: { kind: "none" },
      }
    }
    case "SET_PROVIDER_CREDENTIAL":
      // Merge the secret into the provider's config entry so the next session
      // authenticates with it. Leaves the overlay untouched — the caller drives
      // the switch/close (usually via a following SET_PROVIDER).
      return {
        ...state,
        config: {
          ...state.config,
          providers: {
            ...state.config.providers,
            [action.providerId]: {
              ...state.config.providers[action.providerId],
              [action.credentialKind]: action.secret,
            },
          },
        },
      }
    case "SET_STATUS_BAR":
      return {
        ...state,
        config: {
          ...state.config,
          statusBar: { ...state.config.statusBar, ...action.statusBar },
        },
        overlay: { kind: "none" },
      }
    case "SET_MASCOT":
      return {
        ...state,
        config: {
          ...state.config,
          mascot: { ...state.config.mascot, ...action.mascot },
        },
        overlay: { kind: "none" },
      }
    case "SET_EDITOR":
      return {
        ...state,
        config: {
          ...state.config,
          editor: { ...state.config.editor, ...action.editor },
        },
      }
    case "SET_THEME":
      return {
        ...state,
        config: { ...state.config, theme: action.theme },
        overlay: { kind: "none" },
      }
    case "SET_OUTPUT_STYLE":
      return {
        ...state,
        config: { ...state.config, outputStyle: action.style },
        overlay: { kind: "none" },
      }
    case "SET_AGENT_MODE":
      return {
        ...state,
        // An empty id clears the active mode (back to plain chat).
        config: { ...state.config, agentMode: action.modeId || undefined },
        overlay: { kind: "none" },
      }
    case "SET_LAYOUT":
      return {
        ...state,
        config: { ...state.config, layout: action.layout },
        overlay: { kind: "none" },
      }
    case "SET_MOUSE":
      return {
        ...state,
        config: { ...state.config, mouse: action.mode },
        overlay: { kind: "none" },
      }
    case "SET_SELECTION":
      return {
        ...state,
        config: { ...state.config, selection: action.mode },
        overlay: { kind: "none" },
      }
    case "SET_CONFIG_PATCH":
      // Generic live merge — does NOT close the overlay, so the settings panel
      // stays open and re-renders the updated value. Nested objects are
      // pre-merged by the caller, so a shallow spread is correct here.
      return { ...state, config: { ...state.config, ...action.patch } }

    // ── Overlays ─────────────────────────────────────────────────────────────────
    case "OVERLAY_OPEN": {
      // Live refresh: re-opening a `document` with the SAME title (e.g. the
      // auto-refreshing `/workflow inspect`) replaces only the body so the pager
      // stays mounted and the scroll position isn't reset on every emit.
      if (
        action.overlay.kind === "document" &&
        state.overlay.kind === "document" &&
        state.overlay.title === action.overlay.title
      ) {
        return { ...state, overlay: { ...state.overlay, body: action.overlay.body } }
      }
      // Snapshot the composer cursor so it can be restored when the overlay
      // closes (overlays replace the composer, so Ink would otherwise reset the
      // cursor to the buffer end on remount).
      const buffer = state.input.buffer
      return {
        ...state,
        overlay: action.overlay,
        input: {
          ...state.input,
          savedCursor: { row: buffer.cursorRow, col: buffer.cursorCol },
        },
      }
    }
    case "OVERLAY_CLOSE": {
      const { savedCursor, ...restInput } = state.input
      const buffer = state.input.buffer
      // Restore the cursor only when the saved position is still valid for the
      // current buffer (i.e. the buffer text wasn't changed while the overlay was
      // open). An out-of-range snapshot means the text changed → drop it.
      const valid =
        savedCursor !== undefined &&
        savedCursor.row < buffer.lines.length &&
        savedCursor.col <= buffer.lines[savedCursor.row].length
      return {
        ...state,
        overlay: { kind: "none" },
        input: valid
          ? {
              ...restInput,
              buffer: { ...buffer, cursorRow: savedCursor.row, cursorCol: savedCursor.col },
            }
          : restInput,
      }
    }
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
    case "OVERLAY_REFRESH_MODEL_OPTIONS": {
      // Only applies while the model picker is the active overlay (a close /
      // other-open between dispatch and resolve silently drops it). Keep the
      // current selection if its id survives the refresh, else clamp to range.
      if (state.overlay.kind !== "model") return state
      if (action.options.length === 0) return state
      const { query } = state.overlay
      // `index` points into the filtered view, so resolve the selected id there
      // and re-find it within the freshly-filtered new catalog.
      const currentId = filterByQuery(state.overlay.options, query)[state.overlay.index]
      const nextIndex = Math.max(0, filterByQuery(action.options, query).indexOf(currentId))
      return {
        ...state,
        overlay: { kind: "model", options: action.options, index: nextIndex, query },
      }
    }
    case "OVERLAY_MODEL_QUERY": {
      if (state.overlay.kind !== "model") return state
      // Reset the highlight to the top of the freshly-filtered list — a typeahead
      // refinement should land on the best (first) match, not a stale row index.
      return { ...state, overlay: { ...state.overlay, query: action.query, index: 0 } }
    }
    case "OVERLAY_QUERY": {
      // Generic typeahead for the searchable reducer-owned overlays. Reset the
      // highlight to the top of the freshly-filtered list (best match first).
      const k = state.overlay.kind
      if (
        k !== "select" &&
        k !== "sessions" &&
        k !== "inspect" &&
        k !== "quickActions" &&
        k !== "provider"
      )
        return state
      return { ...state, overlay: { ...state.overlay, query: action.query, index: 0 } }
    }
    case "OVERLAY_PROVIDER_KEY_INPUT": {
      if (state.overlay.kind !== "providerKey") return state
      // Typing clears any prior validation error so the hint isn't stale.
      return { ...state, overlay: { ...state.overlay, value: action.value, error: undefined } }
    }
    case "OVERLAY_PROVIDER_KEY_REVEAL": {
      if (state.overlay.kind !== "providerKey") return state
      return { ...state, overlay: { ...state.overlay, reveal: !state.overlay.reveal } }
    }
    case "OVERLAY_PROVIDER_KEY_ERROR": {
      if (state.overlay.kind !== "providerKey") return state
      return { ...state, overlay: { ...state.overlay, error: action.error } }
    }
    case "MARKETPLACE_PATCH_ENTRY": {
      // Live status from an in-place plugin action (enable/disable) — only applies
      // while the marketplace browser is the active overlay.
      if (state.overlay.kind !== "marketplace") return state
      const entries = state.overlay.entries.map((e) =>
        e.installRef === action.ref ? { ...e, ...action.patch } : e
      )
      return { ...state, overlay: { kind: "marketplace", entries } }
    }
    case "FORM_UPDATE":
      if (state.overlay.kind !== "form") return state
      return { ...state, overlay: { kind: "form", form: action.form } }

    case "MCP_STATUS_PATCH": {
      // Live status from the async probe — only applies while the MCP panel is
      // the active overlay (an interleaved close/other-open silently drops it).
      if (state.overlay.kind !== "mcp") return state
      const servers = state.overlay.servers.map((s) =>
        s.name === action.name ? { ...s, ...action.patch } : s
      )
      return {
        ...state,
        overlay: {
          kind: "mcp",
          servers,
          probing: action.doneProbing ? false : state.overlay.probing,
        },
      }
    }

    case "MCP_LOG_APPEND": {
      // Stamp a stable id from the monotonic seq (no Date.now/Math.random) and
      // append to the bounded ring buffer. Independent of the open overlay — the
      // buffer accrues even when the `/mcp logs` panel is closed.
      const seq = state.seq + 1
      const entry: McpLogEntry = { id: makeId(seq), ...action.entry }
      const next = [...state.mcpLogs, entry]
      const mcpLogs = next.length > MAX_MCP_LOGS ? next.slice(next.length - MAX_MCP_LOGS) : next
      return { ...state, seq, mcpLogs }
    }

    case "MCP_LOG_CLEAR":
      return state.mcpLogs.length === 0 ? state : { ...state, mcpLogs: [] }

    case "LOG_APPEND_BATCH": {
      // One dispatch per coalescer flush window. Ids come from the same
      // monotonic `seq` as cells (no Date.now/Math.random here — the reducer
      // stays deterministic), ticked once PER ENTRY so a batch can't mint
      // duplicate row keys.
      if (action.entries.length === 0) return state
      let seq = state.seq
      const appended: LogEntry[] = action.entries.map((entry) => ({ id: makeId(++seq), ...entry }))
      // ONE buffer copy per flush, and the O(n) trim only once the high-water
      // mark is crossed — not on every line.
      const grown = state.logs.concat(appended)
      const logs = grown.length > LOG_HIGH_WATER ? grown.slice(grown.length - LOG_TRIM_TO) : grown
      return { ...state, seq, logs }
    }

    case "LOG_CLEAR":
      return state.logs.length === 0 ? state : { ...state, logs: [] }

    case "SKILL_ROW_TOGGLE": {
      if (state.overlay.kind !== "skills") return state
      const rows = state.overlay.rows.map((r) =>
        r.id === action.id ? { ...r, enabled: !r.enabled } : r
      )
      return { ...state, overlay: { kind: "skills", rows } }
    }

    case "SKILL_ROWS_SET_MANY": {
      if (state.overlay.kind !== "skills") return state
      const targets = new Set(action.ids)
      const rows = state.overlay.rows.map((r) =>
        targets.has(r.id) ? { ...r, enabled: action.enabled } : r
      )
      return { ...state, overlay: { kind: "skills", rows } }
    }

    // ── Input editor ─────────────────────────────────────────────────────────────
    case "INPUT_SET": {
      // Snapshot the prior buffer onto the undo stack only when the TEXT changed
      // — a cursor-only move (arrows, home/end) shouldn't create an undo step.
      // Any text edit invalidates the redo stack.
      const prev = state.input.buffer
      const textChanged = !sameBufferText(prev, action.buffer)
      return {
        ...state,
        input: {
          ...state.input,
          buffer: action.buffer,
          undo: textChanged ? pushBounded(state.input.undo, prev) : state.input.undo,
          redo: textChanged ? [] : state.input.redo,
        },
      }
    }
    case "INPUT_EDIT": {
      // Apply the op to the LIVE buffer so a burst of keystrokes batched into one
      // render compose sequentially (a→ab→abc) instead of each recomputing from a
      // stale closure and the last one winning (which dropped all but one key).
      const prev = state.input.buffer
      const next = applyInputEdit(prev, action.edit)
      const textChanged = !sameBufferText(prev, next)
      return {
        ...state,
        input: {
          ...state.input,
          buffer: next,
          undo: textChanged ? pushBounded(state.input.undo, prev) : state.input.undo,
          redo: textChanged ? [] : state.input.redo,
        },
      }
    }
    case "INPUT_UNDO": {
      if (state.input.undo.length === 0) return state
      const prev = state.input.undo[state.input.undo.length - 1]
      return {
        ...state,
        input: {
          ...state.input,
          buffer: prev,
          undo: state.input.undo.slice(0, -1),
          redo: pushBounded(state.input.redo, state.input.buffer),
        },
      }
    }
    case "INPUT_REDO": {
      if (state.input.redo.length === 0) return state
      const next = state.input.redo[state.input.redo.length - 1]
      return {
        ...state,
        input: {
          ...state.input,
          buffer: next,
          redo: state.input.redo.slice(0, -1),
          undo: pushBounded(state.input.undo, state.input.buffer),
        },
      }
    }
    case "INPUT_HISTORY":
      return { ...state, input: { ...state.input, history: action.history } }
    case "INPUT_ADD_PASTE":
      return {
        ...state,
        input: { ...state.input, pastes: { ...state.input.pastes, [action.id]: action.text } },
      }
    case "INPUT_CLEAR":
      // Clear the live draft (after a popup accept or turn start) but preserve
      // the accumulated composer history so ↑ keeps recalling past lines.
      return { ...state, input: { ...emptyInputState(), history: state.input.history } }
    case "INPUT_PUSH_HISTORY": {
      if (action.entry.trim().length === 0) return state
      const prev = state.input.history.entries
      // Skip a consecutive duplicate (re-running the same line shouldn't stack
      // it twice) and cap the in-memory ring so a long session can't grow it
      // without bound. Mirrors the persisted-history cap.
      const deduped = prev[prev.length - 1] === action.entry ? prev : [...prev, action.entry]
      const entries =
        deduped.length > HISTORY_LIMIT ? deduped.slice(deduped.length - HISTORY_LIMIT) : deduped
      return {
        ...state,
        input: { ...emptyInputState(), history: { entries, index: -1, draft: "" } },
      }
    }

    // ── Startup onboarding ───────────────────────────────────────────────────────
    case "STARTUP_TRUST":
      // Trust gates the spawn, not the other way round: only once the folder is
      // trusted may an external agent be started against it as a writable root.
      return {
        ...state,
        phase: isBuiltinBackend(state.config.agentBackend) ? "chat" : "connecting",
      }
    case "BACKEND_CONNECT_STAGE":
      return {
        ...state,
        phase: "connecting",
        backendConnect: { backend: action.backend, stage: action.stage },
      }
    case "BACKEND_CONNECT_OK": {
      const {
        backendConnect: _connect,
        backendFailure: _failure,
        backendInstallOption: _installOpt,
        backendInstall: _install,
        backendInstallError: _installErr,
        ...rest
      } = state
      // The launched preset is only known now (`codex` probes for the native CLI
      // and resolves to `codex-app-server`), and the per-backend model memory is
      // keyed by that resolved id. Without this re-resolve a model the user chose
      // for `codex-app-server` would never be found again: mount only knows the
      // alias the user typed, so it would silently fall back to "no model".
      return {
        ...rest,
        phase: "chat",
        backendCapabilities: action.capabilities,
        config: {
          ...state.config,
          model: resolveBackendModel(state.config, action.capabilities.presetId),
        },
      }
    }
    case "BACKEND_CONNECT_FAIL": {
      const {
        backendConnect: _connect,
        backendInstall: _install,
        backendInstallError: _installErr,
        ...rest
      } = state
      return {
        ...rest,
        phase: "connect-failed",
        backendFailure: action.failure,
        // Replaces any prior option — a fresh failure recomputes what can install.
        ...(action.installOption
          ? { backendInstallOption: action.installOption }
          : { backendInstallOption: undefined }),
      }
    }
    case "BACKEND_CONNECT_RETRY": {
      const {
        backendFailure: _failure,
        backendInstallOption: _installOpt,
        backendInstall: _install,
        backendInstallError: _installErr,
        ...rest
      } = state
      return {
        ...rest,
        phase: "connecting",
        backendConnect: { backend: action.backend, stage: "preset" },
      }
    }
    case "BACKEND_INSTALL_START": {
      // Keep `backendFailure` / `backendInstallOption` so a failed install can
      // return to a fully-formed failure page (and retry the install). Clear any
      // prior install error so a retry starts clean.
      const { backendInstallError: _installErr, ...rest } = state
      return {
        ...rest,
        phase: "installing",
        backendInstall: {
          name: action.name,
          display: action.display,
          output: "",
          status: "running",
        },
      }
    }
    case "BACKEND_INSTALL_OUTPUT": {
      // Ignore a late line that arrives after the phase moved on (retry / cancel).
      if (!state.backendInstall) return state
      return {
        ...state,
        backendInstall: {
          ...state.backendInstall,
          output: state.backendInstall.output + action.chunk,
        },
      }
    }
    case "BACKEND_INSTALL_FAIL": {
      // Back to the failure page. The original failure + install option are kept
      // (never cleared on START) so the user can retry the install or pick another
      // route; `backendInstallError` tells them why the last attempt failed.
      const { backendInstall: _install, ...rest } = state
      return { ...rest, phase: "connect-failed", backendInstallError: action.message }
    }
    case "SET_BACKEND": {
      // Drop the previous backend's capabilities immediately — rendering them
      // against the new one is exactly the stale-support lie the gate prevents.
      const {
        backendCapabilities: _caps,
        backendFailure: _failure,
        backendInstallOption: _installOpt,
        backendInstall: _install,
        backendInstallError: _installErr,
        ...rest
      } = state
      return {
        ...rest,
        config: { ...state.config, agentBackend: action.backend },
        ...(isBuiltinBackend(action.backend)
          ? { backendCapabilities: capabilitiesForBuiltin() }
          : {}),
      }
    }
    case "SET_CWD":
      return { ...state, config: { ...state.config, cwd: action.cwd } }

    case "SET_ADDITIONAL_ROOTS":
      return { ...state, config: { ...state.config, additionalRoots: action.roots } }

    // ── Lifecycle ────────────────────────────────────────────────────────────────
    case "CTRL_C":
      return { ...state, lastCtrlCAt: action.at }
    case "CLEAR_CTRL_C":
      // Dismiss the double-press window after the hint timeout expires so a
      // single Ctrl+C doesn't linger waiting for a second press forever.
      // The Footer's exit hint (if any) will exit the DOM alongside this.
      return { ...state, lastCtrlCAt: undefined }
    case "STEER_ENQUEUE": {
      const text = action.text.trim()
      if (!text) return state
      return { ...state, steerQueue: [...state.steerQueue, text] }
    }
    case "STEER_CLEAR":
      return state.steerQueue.length === 0 ? state : { ...state, steerQueue: [] }
    case "EXIT":
      return { ...state, exit: true }

    default:
      return state
  }
}
