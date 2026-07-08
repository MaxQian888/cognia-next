/**
 * TS mirrors of the Rust fleet DTOs (`src-tauri/src/fleet/registry.rs`,
 * `terminal.rs`, `mod.rs`). Field names are camelCase and enum values
 * kebab-case — pinned by the Rust serde tests.
 */

export type FleetAgent = "claude-code" | "codex" | "opencode"

export type FleetStatus =
  | "idle"
  | "working"
  | "waiting-input"
  | "waiting-permission"
  | "plan-pending"
  | "ended"

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

/** The island's answer window (ms) — mirrors Rust `PERMISSION_WAIT_MS`. */
export const FLEET_PERMISSION_WAIT_MS = 20_000
