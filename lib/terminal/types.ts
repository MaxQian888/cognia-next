/**
 * Shared types between the Rust terminal backend
 * (`src-tauri/src/terminal/`) and the TypeScript frontend
 * (`lib/terminal/`, `components/terminal/`).
 *
 * These mirror the `#[derive(Serialize)]` shapes in `session.rs` and
 * `osc633.rs`. Keep them aligned — any drift here means Channel events
 * deserialise incorrectly at runtime.
 */

export type SessionOrigin = "local" | "remote"

export interface SpawnRequest {
  /** Stable host-synchronized profile id; defaults to `default`. */
  profileId?: string
  /** Shell binary — absolute path or PATH-resolvable name. */
  shell: string
  /** Argv after the shell. Integration argv (e.g. `--rcfile`) is appended on top. */
  args?: string[]
  /** Initial cwd. Empty/missing → portable-pty default (`$HOME` / `%USERPROFILE%`). */
  cwd?: string
  /** Extra env. Integration env (e.g. `COGNIA_TERM_NONCE`) overrides this. */
  env?: Record<string, string>
  rows: number
  cols: number
  /** Project the session belongs to (drives dock tab filtering + audit). */
  projectId?: string
  /**
   * When set, this spawn was driven by a VS Code-style extension. The
   * renderer's hook dispatcher has already checked `terminal:spawn`
   * permission for the extension.
   */
  extensionId?: string
  /** Default `true`. Disables OSC 633 env injection when `false`. */
  enableShellIntegration?: boolean
  /**
   * Default `true`. Pins the spawned shell's console output encoding to
   * UTF-8 (PowerShell `[Console]::OutputEncoding` / cmd `chcp 65001`) so the
   * xterm.js renderer — which decodes PTY bytes as UTF-8 — doesn't garble
   * output on non-UTF-8 system codepages (e.g. GBK on Chinese Windows).
   */
  forceUtf8?: boolean
  /** Defaults to `"local"`. The LAN-only WS bridge sets `"remote"`. */
  origin?: SessionOrigin
  /**
   * ADR-0028 Phase 3 (P4.1) — opt-in OS sandbox for the interactive shell.
   * When `true` the backend launches the shell under `bwrap` / `sandbox-exec`
   * (writes confined to `cwd`, `$HOME` read-only, network on). Default
   * `false` keeps the dock byte-identical. Strict: a sandboxed spawn fails
   * closed when no backend is available (Windows runner pending).
   */
  sandboxed?: boolean
  /** Defaults true. Sites previews set false to deny all outbound network. */
  sandboxNetwork?: boolean
}

/** Lease role of one attached client, as the host reports it (ADR-0133). */
export type TerminalParticipantRole = "controller" | "viewer"

/**
 * One attached client of a hosted session. The host broadcasts the full
 * roster (as a refreshed `SessionInfo`) whenever a client attaches, detaches,
 * or the controller lease moves, so this is always the host's view — the
 * renderer never guesses at who else is watching.
 */
export interface TerminalParticipant {
  /** Host client id: `desktop` for the local app, `companion:<deviceId>` for paired devices. */
  clientId: string
  /** Paired device id for remote clients; `null` for the local desktop. */
  deviceId: string | null
  local: boolean
  role: TerminalParticipantRole
}

export interface SessionInfo {
  id: string
  projectId: string | null
  extensionId: string | null
  origin: SessionOrigin
  shell: string
  /**
   * Whether the PTY child is still running. Rust keeps exited sessions in its
   * store so scrollback survives the shell exiting, so a listed session is not
   * necessarily a live one. Optional: remote (WS/RTC) transports predate the
   * field, and `undefined` is treated as alive.
   */
  alive?: boolean
  /** Stable identity of the durable terminal host that owns the process. */
  hostId?: string
  /**
   * Process kind. `localPty` and `ssh` are host-owned and arrive on the wire.
   * `serial` never does: a serial port is not a host session, it is a device
   * node this client opened, and it appears here only so the dock can label
   * the tab and skip the affordances (resize, exit code, shell integration)
   * that a cable has no answer for.
   */
  kind?: "localPty" | "ssh" | "serial"
  profileId?: string
  /**
   * TOFU verdict for the remote server key, present only on `kind: "ssh"`
   * sessions (the host omits both fields otherwise). Carried on the listing so
   * a reattach after a reload can restore what the user was told on connect
   * rather than silently dropping the fingerprint.
   */
  sshHostKeyStatus?: "learned" | "verified"
  sshHostKeyFingerprint?: string
  createdAt?: number
  lastActivityAt?: number
  currentController?: string | null
  attachedClients?: number
  /**
   * Every attached client with its lease role (ADR-0133). Additive: hosts
   * that predate the roster omit it, and `undefined` renders as "just me".
   */
  participants?: TerminalParticipant[]
  sandboxed?: boolean
  integrationCapabilities?: {
    osc633: boolean
    commandStatus: boolean
    cwdTracking: boolean
    degradedReason: string | null
  }
  replay?: {
    firstSequence: number
    lastSequence: number
    retainedBytes: number
    truncated: boolean
  }
}

export interface TerminalControlState {
  role: "controller" | "viewer"
  controllerId: string | null
  reason?: "takeover" | "disconnected" | "released" | "revoked"
}

export interface TerminalReplayGap {
  requestedAfter: number
  firstAvailable: number
  lastAvailable: number
}

export type IntegrationEvent =
  | { kind: "prompt_start" }
  | { kind: "prompt_end" }
  | { kind: "command_start" }
  | { kind: "command_end"; exit_code: number | null }
  | { kind: "cwd_changed"; cwd: string }

/**
 * Tagged event the Rust side pushes through the `Channel<TerminalEvent>`.
 * `data.bytes` arrives as a number[] over JSON IPC; consumers convert
 * to `Uint8Array` before handing to xterm.js.
 */
export type TerminalEvent =
  | { kind: "data"; bytes: number[] }
  | { kind: "integration"; event: IntegrationEvent }
  | { kind: "exit"; code: number | null }
  | {
      kind: "replay_gap"
      requested_after: number
      first_available: number
      last_available: number
    }
  | { kind: "controller_changed"; controller: string | null }
  /**
   * The host re-sent the session's info block unsolicited — the participant
   * roster or the controller lease changed (ADR-0133). Carries the full,
   * current `SessionInfo`; the session replaces its own copy in place.
   */
  | { kind: "session_snapshot"; session: SessionInfo }
