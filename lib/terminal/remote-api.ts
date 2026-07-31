/**
 * Typed client for the request/response terminal RPCs.
 *
 * The live, interactive PTY stream stays on its own channels
 * (`Channel` over Tauri IPC locally, `/ws/terminal` remotely — see
 * `transport-ws.ts`); everything here is one-shot request/response and rides
 * the process-wide `Transport` (`@/lib/tauri`), so the SAME calls work from
 * the desktop renderer (Tauri `invoke`), the Capacitor mobile shell
 * (companion `/api/v1/_rpc/*`), and the WebRTC RPC tier.
 *
 * Server side: local arms in `src-tauri/src/terminal/`, remote arms in
 * `src-tauri/src/companion_api/rpc.rs` (the `terminal_*` section). Over the
 * companion transport, `exec` / `kill` / `killPort` / `completePaths` require
 * the device's remote-control capability (403 otherwise); the listings are
 * plain paired reads.
 */

import { transport } from "@/lib/tauri"

import type { SessionInfo } from "./types"

/** One-shot command capture — mirrors Rust `terminal::exec::ExecResult`. */
export interface RemoteExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

/** Path-completion candidate — mirrors Rust `terminal::complete::PathCandidate`. */
export interface RemotePathCandidate {
  name: string
  isDir: boolean
}

export interface RemoteExecRequest {
  /**
   * Program to run (PATH-resolvable name or absolute path) — or, with
   * `shell: true`, a complete shell command line.
   */
  command: string
  /** argv after the program. Must be omitted/empty when `shell` is true. */
  args?: string[]
  /** Working directory; defaults to the host process cwd. */
  cwd?: string
  /** Extra environment merged over the host process env. */
  env?: Record<string, string>
  /** Kill-after budget; host default 120 000, max 600 000. */
  timeoutMs?: number
  /**
   * Run `command` as a full shell line via the host's platform shell
   * (`cmd /C` on Windows, `sh -c` elsewhere) so pipes / `&&` / redirects
   * work — what replaying a history command needs.
   */
  shell?: boolean
}

/** List every live terminal session on the host. */
export async function listTerminalSessions(): Promise<SessionInfo[]> {
  return transport.call<SessionInfo[]>("terminal_list_all")
}

/** List the host's live terminal sessions for one project. */
export async function listTerminalSessionsForProject(projectId: string): Promise<SessionInfo[]> {
  return transport.call<SessionInfo[]>("terminal_list_for_project", { projectId })
}

/** Kill a live terminal session by id (idempotent on the host). */
export async function killTerminalSession(id: string): Promise<void> {
  await transport.call("terminal_kill", { id })
}

/**
 * Run a one-shot command to completion on the host and capture its output.
 * No PTY, no shell — `command` is exec'd directly with `args`.
 */
export async function execTerminalCommand(request: RemoteExecRequest): Promise<RemoteExecResult> {
  return transport.call<RemoteExecResult>("terminal_exec", {
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    shell: request.shell,
  })
}

/**
 * Host-side path completion for the fragment under the cursor, resolved
 * against `cwd`. Dirs rank before files; `limit` defaults to 50 on the host.
 */
export async function completeTerminalPaths(options: {
  cwd: string
  fragment: string
  showHidden?: boolean
  limit?: number
}): Promise<RemotePathCandidate[]> {
  return transport.call<RemotePathCandidate[]>("terminal_complete_paths", {
    cwd: options.cwd,
    fragment: options.fragment,
    showHidden: options.showHidden,
    limit: options.limit,
  })
}

/**
 * Free a TCP port on the host by killing its listener(s). Returns the PIDs
 * that were signalled (possibly empty — nothing was listening).
 */
export async function killTerminalPort(port: number): Promise<number[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`)
  }
  return transport.call<number[]>("terminal_kill_port", { port })
}
