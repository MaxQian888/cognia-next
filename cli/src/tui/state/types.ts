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

import type { ResolvedConfig, PERMISSION_MODES } from "../../config/schema"

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

export type Cell =
  | UserCell
  | AssistantCell
  | ThinkingCell
  | ToolCell
  | TodoCell
  | ErrorCell
  | NoticeCell

// ── In-flight (current streaming turn) ────────────────────────────────────────

export interface Inflight {
  /** Accumulated assistant text not yet committed to an AssistantCell. */
  text: string
  /** Accumulated reasoning not yet committed to a ThinkingCell. */
  thinking: string
}

export type TurnStatus = "idle" | "streaming" | "aborting"

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

export type Overlay =
  | { kind: "none" }
  | { kind: "permission"; req: PermissionRequestEvent; choices: PermissionChoice[]; index: number }
  | { kind: "slash"; query: string; index: number }
  | { kind: "files"; token: string; completions: string[]; index: number }
  | { kind: "model"; options: string[]; index: number }
  | { kind: "mode"; options: PermissionMode[]; index: number }
  | { kind: "sessions"; items: SessionSummary[]; index: number }
  | { kind: "usage" }
  | { kind: "help" }

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
  cells: Cell[]
  inflight: Inflight
  overlay: Overlay
  input: InputState
  usage?: UsageInfo
  turnStatus: TurnStatus
  /** Epoch ms of the last bare Ctrl+C (for the double-press-to-exit guard). */
  lastCtrlCAt?: number
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
      input?: Record<string, unknown>
      result: unknown
      isError?: boolean
    }
  // Turn lifecycle (from the turn engine)
  | { type: "TURN_START"; prompt: string }
  | { type: "TURN_COMMIT"; result: RunAndCaptureResult }
  | { type: "TURN_ERROR"; message: string }
  | { type: "TURN_ABORTED" }
  // Cells
  | { type: "TOGGLE_COLLAPSE"; id: string }
  | { type: "NOTICE"; message: string }
  | { type: "LOAD_CELLS"; cells: Cell[] }
  | { type: "RESET"; sessionId: string }
  // Config switches
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_MODE"; mode: PermissionMode }
  // Overlays
  | { type: "OVERLAY_OPEN"; overlay: Overlay }
  | { type: "OVERLAY_CLOSE" }
  | { type: "OVERLAY_MOVE"; delta: number }
  | { type: "OVERLAY_SET_INDEX"; index: number }
  // Input editor
  | { type: "INPUT_SET"; buffer: InputBuffer }
  | { type: "INPUT_HISTORY"; history: HistoryState }
  | { type: "INPUT_ADD_PASTE"; id: string; text: string }
  | { type: "INPUT_CLEAR" }
  | { type: "INPUT_PUSH_HISTORY"; entry: string }
  // Lifecycle
  | { type: "CTRL_C"; at: number }
  | { type: "EXIT" }

export type { RunAndCaptureResult, CapturePermissionDecision, PermissionRequestEvent, UsageInfo }
