/**
 * Multiplexer detection and integration.
 *
 * Detects whether the terminal session is running inside a multiplexer
 * (tmux, screen, zellij) and exposes utilities to list/attach sessions.
 *
 * Detection uses Tauri commands on desktop (inspecting env vars + running
 * queries). In browser/mobile, detection returns "none".
 */

import { isTauri } from "@/lib/tauri"

/** Supported multiplexer types. */
export type MultiplexerType = "tmux" | "screen" | "zellij" | "none"

/** Detected multiplexer info. */
export interface MultiplexerInfo {
  /** Which multiplexer was detected. */
  type: MultiplexerType
  /** The multiplexer's socket/session path (e.g., $TMUX value). */
  socketPath: string | null
  /** Version string if available. */
  version: string | null
}

/** A tmux session as returned by `tmux list-sessions`. */
export interface TmuxSession {
  /** Session name. */
  name: string
  /** Number of windows in the session. */
  windowCount: number
  /** Whether a client is attached. */
  attached: boolean
  /** Creation timestamp (unix seconds). */
  createdAt: number
}

/** A tmux window within a session. */
export interface TmuxWindow {
  /** Window index. */
  index: number
  /** Window name. */
  name: string
  /** Whether this is the active window. */
  active: boolean
  /** Number of panes. */
  paneCount: number
}

/**
 * Detect which multiplexer (if any) is active in the current environment.
 * Checks $TMUX, $STY (screen), $ZELLIJ environment variables via Tauri.
 */
export async function detectMultiplexer(): Promise<MultiplexerInfo> {
  if (!isTauri()) {
    return { type: "none", socketPath: null, version: null }
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<MultiplexerInfo>("terminal_detect_multiplexer")
  } catch {
    return { type: "none", socketPath: null, version: null }
  }
}

/**
 * List available tmux sessions.
 * Returns empty array if tmux is not installed or not detected.
 */
export async function listTmuxSessions(): Promise<TmuxSession[]> {
  if (!isTauri()) return []

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<TmuxSession[]>("terminal_list_tmux_sessions")
  } catch {
    return []
  }
}

/**
 * List windows for a specific tmux session.
 */
export async function listTmuxWindows(sessionName: string): Promise<TmuxWindow[]> {
  if (!isTauri()) return []

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<TmuxWindow[]>("terminal_list_tmux_windows", { sessionName })
  } catch {
    return []
  }
}

/**
 * Get the command string to attach to a tmux session.
 * Does NOT execute the command — the caller writes it to the PTY.
 */
export function buildTmuxAttachCommand(sessionName: string): string {
  // Use `-t` for target session; `-d` is not included since we want
  // to share the session (not detach other clients).
  return `tmux attach-session -t ${escapeShellArg(sessionName)}`
}

/**
 * Get the command to create a new tmux session.
 */
export function buildTmuxNewSessionCommand(sessionName?: string): string {
  if (sessionName) {
    return `tmux new-session -s ${escapeShellArg(sessionName)}`
  }
  return "tmux new-session"
}

/**
 * Get the command to detach from the current tmux session.
 */
export function buildTmuxDetachCommand(): string {
  return "tmux detach-client"
}

/**
 * Detect multiplexer from raw environment variable values.
 * Pure function for testing — no Tauri dependency.
 */
export function detectMultiplexerFromEnv(env: Record<string, string | undefined>): MultiplexerInfo {
  // Check tmux first (most common)
  if (env.TMUX) {
    return {
      type: "tmux",
      socketPath: env.TMUX.split(",")[0] ?? null,
      version: null,
    }
  }

  // screen: $STY contains the session name
  if (env.STY) {
    return {
      type: "screen",
      socketPath: env.STY,
      version: null,
    }
  }

  // zellij
  if (env.ZELLIJ) {
    return {
      type: "zellij",
      socketPath: env.ZELLIJ,
      version: env.ZELLIJ_VERSION ?? null,
    }
  }

  return { type: "none", socketPath: null, version: null }
}

/**
 * Parse `tmux list-sessions` output into structured data.
 * Pure function for testing.
 *
 * Expected format per line:
 *   name: windows (created timestamp) (attached)
 *   e.g.: "main: 3 windows (created Mon Aug  5 10:30:00 2024) (attached)"
 */
export function parseTmuxSessionList(output: string): TmuxSession[] {
  if (!output.trim()) return []

  const sessions: TmuxSession[] = []
  const lines = output.trim().split("\n")

  for (const line of lines) {
    const match = line.match(
      /^([^:]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)\s*(\(attached\))?$/
    )
    if (!match) continue

    const [, name, windowCount, createdStr, attachedStr] = match
    sessions.push({
      name: name.trim(),
      windowCount: parseInt(windowCount, 10),
      attached: !!attachedStr,
      createdAt: Math.floor(new Date(createdStr).getTime() / 1000),
    })
  }

  return sessions
}

/**
 * Parse `tmux list-windows` output into structured data.
 * Pure function for testing.
 *
 * Expected format per line:
 *   index: name* (panes) [size] (active)
 *   e.g.: "0: zsh* (1 panes) [200x50] (active)"
 */
export function parseTmuxWindowList(output: string): TmuxWindow[] {
  if (!output.trim()) return []

  const windows: TmuxWindow[] = []
  const lines = output.trim().split("\n")

  for (const line of lines) {
    const match = line.match(/^(\d+):\s+(\S+?)([*-]?)\s+\((\d+)\s+panes?\)/)
    if (!match) continue

    const [, index, name, activeMarker, paneCount] = match
    windows.push({
      index: parseInt(index, 10),
      name: name.replace(/[*-]$/, ""),
      active: activeMarker === "*",
      paneCount: parseInt(paneCount, 10),
    })
  }

  return windows
}

/** Escape a string for safe use in a shell command. */
function escapeShellArg(arg: string): string {
  // If it's a simple alphanumeric + dash/underscore, no quoting needed
  if (/^[a-zA-Z0-9_.-]+$/.test(arg)) return arg
  // Otherwise, single-quote it (escaping existing single quotes)
  return `'${arg.replace(/'/g, "'\\''")}'`
}
