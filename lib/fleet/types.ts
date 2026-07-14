/**
 * TS mirrors of the Rust fleet DTOs (`src-tauri/src/fleet/registry.rs`,
 * `terminal.rs`, `mod.rs`). Field names are camelCase and enum values
 * kebab-case — pinned by the Rust serde tests.
 */

export type FleetAgent = "claude-code" | "codex" | "opencode"

export type FleetStatus =
  "idle" | "working" | "waiting-input" | "waiting-permission" | "plan-pending" | "ended"

export type TerminalAppId =
  | "iterm"
  | "apple-terminal"
  | "ghostty"
  | "vscode"
  | "warp"
  | "kitty"
  | "alacritty"
  | "wezterm"
  | "tmux"
  | "windows-terminal"
  | "jetbrains"
  | "cursor"
  | "unknown"

export interface TerminalSource {
  app: TerminalAppId
  label: string
  sessionRef?: string
}

export interface FleetCapabilities {
  approvePermission: boolean
  sendMessage: boolean
  focusTerminal: boolean
  openTranscript: boolean
}

export interface PendingPermission {
  requestId: string
  toolName: string | null
  detail: string | null
  requestedAt: number
}

export interface FleetActivity {
  toolName: string
  detail: string | null
}

/**
 * A parked AskUserQuestion. Rendered while the session is `waiting-input`; the
 * island lets the user pick options and answer it when `pendingQuestionRequest`
 * is also set, otherwise it is display-only. Mirrors Rust `PendingQuestion`.
 */
export interface PendingQuestion {
  question: string
  /** Short chip label ("Auth method") when the tool provided one. */
  header?: string | null
  /** Option labels in tool order (capped by the Rust side). */
  options: string[]
  multiSelect: boolean
}

/**
 * The answerable handle for a parked AskUserQuestion — present only while the
 * tool's `PermissionRequest` long-poll is waiting. The island posts the user's
 * option selections to `fleet_question_respond` with `requestId`; the answer
 * rides back as the hook's `allow` + `updatedInput.answers` decision. Mirrors
 * Rust `PendingQuestionRequest`.
 */
export interface PendingQuestionRequest {
  requestId: string
  /** Epoch ms the request arrived — drives the answer-window countdown. */
  requestedAt: number
}

/** One live subagent spawned by the session's Task tool. Mirrors Rust `FleetSubagent`. */
export interface FleetSubagent {
  description: string
  /** Subagent type ("Explore", "general-purpose", …) when provided. */
  agentType?: string | null
  /** True for run_in_background tasks, which outlive their tool call. */
  background: boolean
  startedAt: number
}

/** Whether an error came from a single tool call or a failed turn. */
export type FleetErrorKind = "tool" | "turn"

/**
 * Most recent error observed on a session. Orthogonal to `status` (a failed
 * tool doesn't change what the user must do); the island paints a separate
 * banner. Mirrors Rust `FleetError`.
 */
export interface FleetError {
  kind: FleetErrorKind
  detail?: string | null
  /** Epoch ms when the error was observed. */
  at: number
}

export interface FleetSession {
  agent: FleetAgent
  sessionId: string
  status: FleetStatus
  cwd: string | null
  projectName: string | null
  lastPrompt: string | null
  activity: FleetActivity | null
  permissionMode: string | null
  model: string | null
  terminal: TerminalSource | null
  transcriptPath: string | null
  agentPid: number | null
  pendingPermission: PendingPermission | null
  /** Plan text parked by ExitPlanMode while `plan-pending`. Optional: older snapshots omit it. */
  pendingPlan?: string | null
  /** Questions parked by AskUserQuestion while `waiting-input`. */
  pendingQuestions?: PendingQuestion[]
  /** Answerable handle for the parked questions (present only while the
   * AskUserQuestion `PermissionRequest` long-poll is waiting). */
  pendingQuestionRequest?: PendingQuestionRequest | null
  /** Live subagents (Task tool), foreground and background. */
  subagents?: FleetSubagent[]
  capabilities: FleetCapabilities
  startedAt: number
  lastEventAt: number
  endedAt?: number
  /** Most recent tool/turn error; cleared on a new turn or a later success. */
  lastError?: FleetError | null
  /** Tool invocations seen this session. Always present (0 default). */
  toolUseCount: number
  /** User turns seen this session. Always present (0 default). */
  turnCount: number
  /** How the session began: `startup` | `resume` | `clear` | `compact`. */
  startSource?: string | null
  /** Current git branch of `cwd`, captured once per turn by the runtime. */
  gitBranch?: string | null
}

export interface FleetSnapshot {
  sessions: FleetSession[]
  generatedAt: number
}

export interface FleetMonitorStatus {
  enabled: boolean
  port: number | null
  configPath: string | null
}

export type PermissionBehavior = "allow" | "deny"

/** Event topic (must match `src-tauri/src/fleet/mod.rs`). */
export const FLEET_UPDATE_EVENT = "fleet://update"

/**
 * Island-window geometry push (must match `src-tauri/src/fleet/island_window.rs`).
 * Emitted to the island webview when a placement path runs against a possibly
 * different monitor (re-show, set-monitor), so the shell re-pads below the notch.
 */
export const FLEET_ISLAND_GEOMETRY_EVENT = "fleet://island-geometry"

/** Payload of `FLEET_ISLAND_GEOMETRY_EVENT` (mirrors Rust `IslandGeometry`). */
export interface IslandGeometry {
  /** Top safe-area inset (logical px): notch height, 0 on non-notched displays. */
  topInset: number
}

/**
 * Cursor-over-island transitions pushed by the native hover monitor (must
 * match `src-tauri/src/fleet/island_window.rs`). Authoritative hover source:
 * a tucked island ignores cursor events at the OS level (click-through fix),
 * so DOM mouseenter/mouseleave never fire on it — Rust polls the global
 * cursor against the window frame and pushes enter/leave here instead.
 */
export const FLEET_ISLAND_HOVER_EVENT = "fleet://island-hover"

/** Payload of `FLEET_ISLAND_HOVER_EVENT` (mirrors Rust `IslandHover`). */
export interface IslandHover {
  hovering: boolean
}

/** The island's answer window (ms) — mirrors Rust `PERMISSION_WAIT_MS`. */
export const FLEET_PERMISSION_WAIT_MS = 20_000
