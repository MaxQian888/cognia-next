/**
 * Shared type surface for the interactive TUI (the `cognia-agent chat` Ink app).
 *
 * Type-only module: it is excluded from coverage (TS strips it at runtime). The
 * runtime logic that operates on these shapes lives in `reducer.ts`,
 * `event-mapper.ts`, the `markdown/*` and `format/*` modules, each with its own
 * co-located test.
 */
import type { PermissionRequestEvent } from "@/lib/claude/types"
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { UsageInfo } from "@/lib/claude/adapter"

import type {
  ResolvedConfig,
  PERMISSION_MODES,
  StatusBarConfig,
  MascotConfig,
  OutputStyle,
  ThinkingLevel,
} from "../../config/schema"
import type { ProviderOption } from "../commands/provider-options"
import type { ConfigMenuRow } from "../commands/config-menu"
import type { ModelMeta } from "../runtime/model-meta"
import type { FormOverlayState } from "./form"

export type PermissionMode = (typeof PERMISSION_MODES)[number]

// ── Transcript cells (committed history) ──────────────────────────────────────

export interface UserCell {
  id: string
  kind: "user"
  text: string
}

/** An assistant reply. `raw` is the model's exact markdown; components tokenize. */
export interface AssistantCell {
  id: string
  kind: "assistant"
  raw: string
}

export interface ThinkingCell {
  id: string
  kind: "thinking"
  text: string
  collapsed: boolean
}

export type ToolStatus = "running" | "done" | "error"

export interface ToolCell {
  id: string
  kind: "tool"
  /** Correlation key from the capture stream (toolName + serialized input). */
  callKey: string
  toolName: string
  input: Record<string, unknown>
  status: ToolStatus
  result?: unknown
  isError?: boolean
  collapsed: boolean
}

export interface Todo {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

export interface TodoCell {
  id: string
  kind: "todo"
  todos: Todo[]
}

export interface ErrorCell {
  id: string
  kind: "error"
  message: string
}

/** Non-error system notice (e.g. "Pushed to desktop", "Fresh session"). */
export interface NoticeCell {
  id: string
  kind: "notice"
  message: string
}

/** A `!command` shell-out and its captured output. */
export interface BashCell {
  id: string
  kind: "bash"
  command: string
  output: string
  status: "running" | "done" | "error"
  exitCode?: number
}

/**
 * A plan proposed by the agent at the end of a plan-mode turn. Rendered as a
 * framed "Proposed plan" card (distinct from a normal assistant reply) so the
 * user can review it before approving. `raw` is the model's markdown.
 */
export interface PlanCell {
  id: string
  kind: "plan"
  raw: string
}

export type Cell =
  | UserCell
  | AssistantCell
  | ThinkingCell
  | ToolCell
  | TodoCell
  | ErrorCell
  | NoticeCell
  | BashCell
  | PlanCell

// ── In-flight (current streaming turn) ────────────────────────────────────────

export interface Inflight {
  /** Accumulated assistant text not yet committed to an AssistantCell. */
  text: string
  /** Accumulated reasoning not yet committed to a ThinkingCell. */
  thinking: string
}

export type TurnStatus = "idle" | "streaming" | "aborting"

// ── Background activity (goal loop, workflow run, subagent dispatch) ───────────
// These run outside the normal chat turn, so they get their own status pill.

export type ActivityKind = "goal" | "workflow" | "agent" | "team" | "loop"

export interface ActivityState {
  kind: ActivityKind
  label: string
  /** Turns completed so far (goal/agent loops). */
  turns?: number
  /** Total expected iterations, when known (e.g. a `/loop --n 5`). Enables a
   * determinate progress bar in the activity pill. */
  max?: number
  /** A short status note (e.g. the current step). */
  note?: string
  status: "running" | "done" | "error"
}

/**
 * Cumulative token/cost totals for the whole session. The per-turn SDK result
 * reports usage for that turn only (each CLI turn is a fresh query), so the
 * footer's "session cost / tokens" are summed here while {@link TuiState.usage}
 * keeps the latest turn's figures for the context-window gauge.
 */
export interface SessionTotals {
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  durationMs: number
}

/** Per-tool call/error tally for the usage panel's "top tools" breakdown. */
export interface ToolStat {
  calls: number
  errors: number
}

// ── Overlays (modal selection UIs over the composer) ──────────────────────────

export type PermissionChoiceValue = "allow" | "allow_always" | "deny"

export interface PermissionChoice {
  label: string
  value: PermissionChoiceValue
}

export interface SessionSummary {
  sessionId: string
  /** First user message, truncated — a human-readable label. */
  title: string
  turns: number
  updatedAt: number
}

/** Health + context snapshot shown by the `/status` panel. */
export interface StatusReport {
  version: string
  provider: string
  model: string
  modelValid: boolean
  auth: string
  credentialedProviders: string[]
  cwd: string
  gitBranch: string | null
  contextPct: number
  contextTokens: number
  contextWindow: number
  dbSnapshotExists: boolean
}

/** One crash report on disk, summarized for the `/doctor` panel. */
export interface CrashReportItem {
  stem: string
  capturedAt?: string
  kind?: "panic" | "native"
  sizeBytes: number
  hasTxt: boolean
  hasJson: boolean
  hasDmp: boolean
}

/** Comprehensive diagnostic report shown by the `/doctor` panel. */
export interface DoctorReport {
  version: string
  provider: string
  model: string
  modelValid: boolean
  auth: string
  credentialedProviders: string[]
  cwd: string
  dbSnapshotExists: boolean
  dbSnapshotPath: string
  crashReportsDir: string | null
  logsDir: string | null
  crashReportCount: number
  latestCrash?: CrashReportItem
  logDirBytes: number
}

/** A row in the generic {@link Overlay} `select` list. */
export interface SelectItem {
  /** Stable id passed to the `onSelectCommand` when this row is chosen. */
  id: string
  label: string
  hint?: string
}

export type Overlay =
  | { kind: "none" }
  | { kind: "permission"; req: PermissionRequestEvent; choices: PermissionChoice[]; index: number }
  | { kind: "slash"; query: string; index: number }
  | { kind: "files"; token: string; completions: string[]; index: number }
  | { kind: "model"; options: string[]; index: number }
  | { kind: "mode"; options: PermissionMode[]; index: number }
  | { kind: "thinking"; options: ThinkingLevel[]; index: number }
  | { kind: "provider"; options: ProviderOption[]; index: number }
  | { kind: "config"; rows: ConfigMenuRow[]; index: number }
  | { kind: "sessions"; items: SessionSummary[]; index: number }
  | { kind: "usage" }
  | { kind: "help" }
  | { kind: "status"; report: StatusReport }
  // Comprehensive diagnostic report shown by `/doctor`.
  | { kind: "doctor"; report: DoctorReport }
  // Generic list overlay any feature can open without touching App per-feature.
  // Picking row `i` re-dispatches `/${onSelectCommand} ${items[i].id}`. When
  // `onSelectCommand` is omitted the list is view-only — Enter just closes it.
  | { kind: "select"; title: string; items: SelectItem[]; index: number; onSelectCommand?: string }
  // Scrollable read-only pager. `markdown` bodies are rendered through the
  // Markdown tokenizer; `text` bodies are shown verbatim (optionally syntax-
  // highlighted by `lang`). Used by skill/tool detail and the `/view` file
  // viewer. Scroll position lives in the component (view-only state).
  | { kind: "document"; title: string; body: string; format: DocumentFormat; lang?: string }
  // Guided argument form. Navigation/edits go through FORM_UPDATE.
  | { kind: "form"; form: FormOverlayState }
  // Plan-approval prompt shown after a plan-mode turn proposes a plan. The user
  // approves (→ switch to build mode + proceed) or keeps planning. `raw` is the
  // proposed plan (already shown as a PlanCell above); `savedTo` is its on-disk
  // path when persistence succeeded; `prevPlan` is the previously proposed plan
  // in this session (when any) so the overlay can show a `+A −R` revision badge.
  | { kind: "plan"; raw: string; index: number; savedTo?: string; prevPlan?: string }

/** How a {@link Overlay} `document` body should be rendered. */
export type DocumentFormat = "markdown" | "text"

// ── Input editor state ────────────────────────────────────────────────────────

export interface InputBuffer {
  /** Logical lines (no trailing newlines). Always at least one line. */
  lines: string[]
  cursorRow: number
  cursorCol: number
}

export interface HistoryState {
  /** Past submissions, oldest first. */
  entries: string[]
  /** -1 = editing the live draft; otherwise an index into `entries`. */
  index: number
  /** The draft stashed when history navigation began. */
  draft: string
}

export interface InputState {
  buffer: InputBuffer
  history: HistoryState
  /** Collapsed paste placeholders → their full text, keyed by placeholder id. */
  pastes: Record<string, string>
}

// ── Root state ────────────────────────────────────────────────────────────────

export interface TuiState {
  sessionId: string
  config: ResolvedConfig
  /**
   * Session phase. `"startup"` shows only the welcome banner + trust gate (the
   * Claude-Code-style "do you trust this folder?" onboarding); `"chat"` is the
   * normal transcript + composer view. Starts `"chat"` when the cwd was already
   * trusted on a prior launch, otherwise `"startup"`.
   */
  phase: "startup" | "chat"
  cells: Cell[]
  inflight: Inflight
  overlay: Overlay
  input: InputState
  /** The latest turn's usage — drives the context-window gauge. */
  usage?: UsageInfo
  /**
   * Active model's context window + pricing, resolved from the models.dev
   * catalog. Drives the per-model context gauge and the cost fallback. Absent
   * until the async resolution lands (then the pattern-table window applies).
   */
  modelMeta?: ModelMeta
  /** Cumulative cost/token totals across every turn this session. */
  sessionTotals: SessionTotals
  /** Per-turn total tokens (prompt incl. cache + output), capped — feeds the
   * usage panel's token-trend sparkline. Oldest → newest. */
  usageHistory: number[]
  /** Per-tool call/error tallies this session — feeds the usage panel's
   * "top tools" breakdown. Keyed by the raw tool name. */
  toolStats: Record<string, ToolStat>
  /** Whether a `usage` stream event already landed this turn (guards double-count). */
  usageSeenThisTurn: boolean
  turnStatus: TurnStatus
  /** A background runtime run (goal / workflow / subagent), if one is active. */
  activity?: ActivityState
  /**
   * The most recent plan proposed in plan mode (raw markdown + the `seq` of the
   * PlanCell that carries it). Bumped on each plan capture so the App can react
   * exactly once — persist it and open the approval overlay. Drives `/plan`
   * (re-show the last plan). Absent until the first plan-mode turn proposes one.
   * `prevRaw` carries the plan this one superseded (when any) so the approval
   * overlay can show how the revision changed.
   */
  lastPlan?: { raw: string; seq: number; prevRaw?: string }
  /** True when an `ExitPlanMode` tool call captured a plan during the current
   * turn. Suppresses the `looksLikePlan` fallback in TURN_COMMIT (so a plan
   * isn't captured twice) and guards against a duplicate capture from an
   * assistant-snapshot echo. Reset at TURN_START and RESET. */
  planCapturedThisTurn: boolean
  /** Epoch ms of the last bare Ctrl+C (for the double-press-to-exit guard). */
  lastCtrlCAt?: number
  /** Persistent detailed-output mode (Ctrl+O). When on, tool/thinking cells
   * render expanded regardless of their per-cell collapsed flag. */
  verbose: boolean
  /** Bumped to force the `<Static>` transcript to re-key and re-print every cell
   * — the only way to repaint committed scrollback (after a resize, a verbose
   * toggle, or expand/collapse-all), since `<Static>` never re-renders in place. */
  renderEpoch: number
  exit: boolean
  /** Monotonic counter feeding unique cell ids without Date.now/Math.random. */
  seq: number
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type TuiAction =
  // Streaming (from the capture stream via event-mapper)
  | { type: "INFLIGHT_TEXT"; delta: string }
  | { type: "INFLIGHT_THINKING"; delta: string }
  | { type: "TOOL_CALL"; callKey: string; toolName: string; input: Record<string, unknown> }
  | {
      type: "TOOL_RESULT"
      toolName: string
      /** Correlation key (toolName + serialized input) when the result could be
       * matched back to its originating tool_use block — lets the reducer pair a
       * result with the exact running cell even when several share a tool name. */
      callKey?: string
      input?: Record<string, unknown>
      result: unknown
      isError?: boolean
    }
  // Streaming usage (from the SDK result message, via the capture stream)
  | { type: "SET_USAGE"; usage: UsageInfo }
  // A context-compaction boundary crossed (auto threshold or a manual `/compact`),
  // surfaced from the capture stream / the manual-compact runner.
  | { type: "COMPACT_BOUNDARY"; trigger: "manual" | "auto"; preTokens: number; postTokens: number }
  // Active model's resolved context window + pricing (from the catalog)
  | { type: "SET_MODEL_META"; meta: ModelMeta }
  // Turn lifecycle (from the turn engine)
  | { type: "TURN_START"; prompt: string }
  | { type: "TURN_COMMIT"; result: RunAndCaptureResult }
  | { type: "TURN_ERROR"; message: string }
  | { type: "TURN_ABORTED" }
  // Background activity (goal / workflow / subagent runs)
  | { type: "ACTIVITY_START"; kind: ActivityKind; label: string; max?: number }
  | { type: "ACTIVITY_PROGRESS"; turns?: number; note?: string }
  | { type: "ACTIVITY_END"; status: "done" | "error"; summary?: string }
  // Shell-out (`!command`)
  | { type: "BASH_START"; command: string }
  | { type: "BASH_RESULT"; output: string; status: "done" | "error"; exitCode?: number }
  // Cells
  | { type: "TOGGLE_COLLAPSE"; id: string }
  /** Expand every collapsed tool/thinking cell, or collapse them all when none
   * is collapsed. Bound to a global key since the transcript has no per-cell
   * cursor — one keystroke reveals (or hides) all tool output. */
  | { type: "TOGGLE_COLLAPSE_ALL" }
  /** Toggle persistent detailed-output mode (Ctrl+O). */
  | { type: "TOGGLE_VERBOSE" }
  /** Force a full transcript repaint (resize recovery). */
  | { type: "REPAINT" }
  | { type: "NOTICE"; message: string }
  | { type: "LOAD_CELLS"; cells: Cell[] }
  | { type: "RESET"; sessionId: string }
  // Config switches
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_MODE"; mode: PermissionMode }
  | { type: "SET_THINKING"; level: ThinkingLevel }
  | { type: "SET_PROVIDER"; provider: string }
  | { type: "SET_STATUS_BAR"; statusBar: StatusBarConfig }
  | { type: "SET_MASCOT"; mascot: MascotConfig }
  | { type: "SET_THEME"; theme: string }
  | { type: "SET_OUTPUT_STYLE"; style: OutputStyle }
  // Overlays
  | { type: "OVERLAY_OPEN"; overlay: Overlay }
  | { type: "OVERLAY_CLOSE" }
  | { type: "OVERLAY_MOVE"; delta: number }
  | { type: "OVERLAY_SET_INDEX"; index: number }
  | { type: "FORM_UPDATE"; form: FormOverlayState }
  // Input editor
  | { type: "INPUT_SET"; buffer: InputBuffer }
  | { type: "INPUT_HISTORY"; history: HistoryState }
  | { type: "INPUT_ADD_PASTE"; id: string; text: string }
  | { type: "INPUT_CLEAR" }
  | { type: "INPUT_PUSH_HISTORY"; entry: string }
  // Startup onboarding (trust gate + folder picker)
  /** Trust the current cwd and enter the chat phase. */
  | { type: "STARTUP_TRUST" }
  /** Switch the working directory (from the startup folder picker). */
  | { type: "SET_CWD"; cwd: string }
  // Lifecycle
  | { type: "CTRL_C"; at: number }
  | { type: "EXIT" }

export type { RunAndCaptureResult, CapturePermissionDecision, PermissionRequestEvent, UsageInfo }
