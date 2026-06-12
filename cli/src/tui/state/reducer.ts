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
import { formatCompactBoundary } from "../format/compaction"
import { accumulateUsage, contextTokens, emptySessionTotals } from "../format/usage"
import { resolveActiveModel } from "../../config/active-model"
import {
  isExitPlanTool,
  looksLikePlan,
  looksLikeQuestion,
  planBodyFromExitInput,
  PLAN_APPROVAL_CHOICES,
} from "../runtime/plan"
import type {
  Cell,
  Inflight,
  Overlay,
  ToolCell,
  TodoCell,
  ToolStat,
  TuiAction,
  TuiState,
  UsageInfo,
} from "./types"

function makeId(seq: number): string {
  return `c${seq}`
}

/** Max per-turn token samples kept for the usage-panel sparkline. */
const USAGE_HISTORY_LIMIT = 60

/** Append one turn's total tokens (prompt incl. cache + output) to the history. */
function pushUsageHistory(history: number[], usage: UsageInfo): number[] {
  const next = [...history, contextTokens(usage) + (usage.outputTokens ?? 0)]
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
    inflight: { text: "", thinking: "" },
    lastPlan: { raw, seq: planSeq, ...(prevRaw ? { prevRaw } : {}) },
  }
}

/** How many selectable rows an overlay has (null = not a movable list). */
function overlayLength(overlay: Overlay): number | null {
  switch (overlay.kind) {
    case "permission":
      return overlay.choices.length
    case "model":
    case "mode":
    case "thinking":
    case "provider":
      return overlay.options.length
    case "config":
      return overlay.rows.length
    case "sessions":
      return overlay.items.length
    case "select":
      return overlay.items.length
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
      // Defensive dedup: if the most recent cell is already a running tool with
      // this exact callKey, this is a repeated emission for the same invocation
      // (assistant snapshots echo completed tool_use blocks). Ignore it so we
      // don't commit the inflight text again and stack duplicate ⏳ tool cells —
      // which previously flooded the transcript and froze the terminal.
      const last = state.cells[state.cells.length - 1]
      if (
        last &&
        last.kind === "tool" &&
        last.status === "running" &&
        last.callKey === action.callKey
      ) {
        return state
      }
      const committed = commitInflight(state.cells, state.inflight, state.seq)
      let seq = committed.seq
      const cells = committed.cells
      const toolStats = bumpToolStat(state.toolStats, action.toolName, "calls")
      if (isTodoTool(action.toolName)) {
        const todos = parseTodos(action.input)
        const existingIdx = cells.findIndex((c) => c.kind === "todo")
        if (existingIdx >= 0) {
          const updated = [...cells]
          updated[existingIdx] = { ...(updated[existingIdx] as TodoCell), todos }
          return { ...state, cells: updated, seq, inflight: committed.inflight, toolStats }
        }
        cells.push({ id: makeId(seq++), kind: "todo", todos })
        return { ...state, cells, seq, inflight: committed.inflight, toolStats }
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
      return { ...state, cells, seq, inflight: committed.inflight, toolStats }
    }
    case "TOOL_RESULT": {
      // Pair the result with its running tool cell, most-specific match first:
      //   1. exact callKey (set when the result correlated to its tool_use),
      //   2. oldest running cell of the same tool name,
      //   3. oldest running cell of ANY name.
      // Step 3 is the load-bearing fallback: a result whose originating
      // tool_use id couldn't be correlated arrives with an empty toolName, so
      // without it the cell would hang on ⏳ forever after the call completed.
      const runningOf = (pred: (c: ToolCell) => boolean): number =>
        state.cells.findIndex((c) => c.kind === "tool" && c.status === "running" && pred(c))
      let idx = action.callKey ? runningOf((c) => c.callKey === action.callKey) : -1
      if (idx < 0 && action.toolName) idx = runningOf((c) => c.toolName === action.toolName)
      if (idx < 0) idx = runningOf(() => true)
      if (idx < 0) return state
      const updated = [...state.cells]
      const matched = updated[idx] as ToolCell
      updated[idx] = {
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
    case "SET_USAGE":
      return {
        ...state,
        usage: action.usage,
        sessionTotals: accumulateUsage(state.sessionTotals, action.usage, state.modelMeta?.pricing),
        usageHistory: pushUsageHistory(state.usageHistory, action.usage),
        usageSeenThisTurn: true,
      }
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
        inflight: { text: "", thinking: "" },
        turnStatus: "streaming",
        usageSeenThisTurn: false,
        planCapturedThisTurn: false,
        overlay: { kind: "none" },
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
      let committed: { cells: Cell[]; seq: number; inflight: Inflight }
      let lastPlan = state.lastPlan
      if (isPlan) {
        const p = commitPlan(
          state.cells,
          state.inflight,
          state.seq,
          state.inflight.text,
          state.lastPlan?.raw,
          { keepText: false }
        )
        committed = { cells: p.cells, seq: p.seq, inflight: p.inflight }
        lastPlan = p.lastPlan
      } else {
        committed = commitInflight(state.cells, state.inflight, state.seq)
      }
      // The native Anthropic path streams usage via SET_USAGE; only fall back to
      // the resolved result's usage when no stream event landed (ai-sdk path),
      // so a turn's tokens/cost are never counted twice.
      const fallbackUsage =
        !state.usageSeenThisTurn && action.result.usage ? action.result.usage : undefined
      return {
        ...state,
        cells: committed.cells,
        seq: committed.seq,
        inflight: committed.inflight,
        turnStatus: "idle",
        lastPlan,
        ...(fallbackUsage
          ? {
              usage: fallbackUsage,
              sessionTotals: accumulateUsage(
                state.sessionTotals,
                fallbackUsage,
                state.modelMeta?.pricing
              ),
              usageHistory: pushUsageHistory(state.usageHistory, fallbackUsage),
            }
          : {}),
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
      const cells = action.summary
        ? [
            ...state.cells,
            { id: makeId(state.seq), kind: "notice" as const, message: action.summary },
          ]
        : state.cells
      return {
        ...state,
        cells,
        seq: action.summary ? state.seq + 1 : state.seq,
        activity: undefined,
      }
    }

    // ── Shell-out ────────────────────────────────────────────────────────────────
    case "BASH_START":
      return {
        ...state,
        cells: [
          ...state.cells,
          {
            id: makeId(state.seq),
            kind: "bash",
            command: action.command,
            output: "",
            status: "running",
          },
        ],
        seq: state.seq + 1,
      }
    case "BASH_RESULT": {
      // Fill the most recent still-running bash cell.
      let idx = -1
      for (let i = state.cells.length - 1; i >= 0; i--) {
        const c = state.cells[i]
        if (c.kind === "bash" && c.status === "running") {
          idx = i
          break
        }
      }
      if (idx < 0) return state
      const updated = [...state.cells]
      updated[idx] = {
        ...(updated[idx] as Extract<Cell, { kind: "bash" }>),
        output: action.output,
        status: action.status,
        ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
      }
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
    case "NOTICE":
      return {
        ...state,
        cells: [...state.cells, { id: makeId(state.seq), kind: "notice", message: action.message }],
        seq: state.seq + 1,
      }
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
      return { ...state, cells: action.cells, inflight: { text: "", thinking: "" } }
    case "RESET":
      return {
        ...state,
        sessionId: action.sessionId,
        cells: [],
        inflight: { text: "", thinking: "" },
        overlay: { kind: "none" },
        usage: undefined,
        sessionTotals: emptySessionTotals(),
        usageHistory: [],
        toolStats: {},
        usageSeenThisTurn: false,
        turnStatus: "idle",
        lastPlan: undefined,
        planCapturedThisTurn: false,
      }

    // ── Config switches ──────────────────────────────────────────────────────────
    case "SET_MODEL":
      // Remember the model for the ACTIVE provider (per-provider memory) and
      // mirror it onto the top-level `model` the displays read. Keying it to the
      // provider is what stops the pick from bleeding onto other providers.
      return {
        ...state,
        config: {
          ...state.config,
          model: action.model,
          providers: {
            ...state.config.providers,
            [state.config.provider]: {
              ...state.config.providers[state.config.provider],
              model: action.model,
            },
          },
        },
        overlay: { kind: "none" },
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
        config: { ...state.config, thinkingLevel: action.level },
        overlay: { kind: "none" },
      }
    case "SET_PROVIDER": {
      // Switching provider re-points the displayed model to THAT provider's
      // remembered model (or its catalog default) so a previous provider's model
      // never lingers on screen. `resolveActiveModel` ignores the stale top-level
      // pin for a known provider, so no Claude-id bleed.
      const nextConfig = { ...state.config, provider: action.provider }
      return {
        ...state,
        config: { ...nextConfig, model: resolveActiveModel(nextConfig) },
        overlay: { kind: "none" },
      }
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
    case "FORM_UPDATE":
      if (state.overlay.kind !== "form") return state
      return { ...state, overlay: { kind: "form", form: action.form } }

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
      return { ...state, phase: "chat" }
    case "SET_CWD":
      return { ...state, config: { ...state.config, cwd: action.cwd } }

    // ── Lifecycle ────────────────────────────────────────────────────────────────
    case "CTRL_C":
      return { ...state, lastCtrlCAt: action.at }
    case "EXIT":
      return { ...state, exit: true }

    default:
      return state
  }
}
