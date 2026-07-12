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
 * A parked AskUserQuestion (display-only — answered in the agent's own
 * terminal). Mirrors Rust `PendingQuestion`.
 */
export interface PendingQuestion {
  question: string
  /** Short chip label ("Auth method") when the tool provided one. */
  header?: string | null
  /** Option labels in tool order (capped by the Rust side). */
  options: string[]
  multiSelect: boolean
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
  /** Live subagents (Task tool), foreground and background. */
  subagents?: FleetSubagent[]
  capabilities: FleetCapabilities
  startedAt: number
  lastEventAt: number
  endedAt?: number
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

/** The island's answer window (ms) — mirrors Rust `PERMISSION_WAIT_MS`. */
export const FLEET_PERMISSION_WAIT_MS = 20_000
