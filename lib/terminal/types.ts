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
}

export interface SessionInfo {
  id: string
  projectId: string | null
  extensionId: string | null
  origin: SessionOrigin
  shell: string
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
