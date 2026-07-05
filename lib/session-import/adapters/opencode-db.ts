// Thin, mockable bridge to the Rust `opencode_sessions_read` command, which
// reads OpenCode's SQLite store (`~/.local/share/opencode/opencode.db`) and
// returns already-normalized sessions. Isolated here so the `opencode` adapter
// (and its tests) can stub the SQLite access without touching Tauri.

import { isTauri } from "@/lib/tauri"

/** A normalized OpenCode message part (superset of what we render). */
export interface OpencodePart {
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    error?: string
  }
  mediaType?: string
  filename?: string
  url?: string
}

/** Normalized per-turn token counts projected by the readers. */
export interface OpencodeTokens {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface OpencodeMessage {
  role: string
  parts: OpencodePart[]
  createdAt: number
  /** Per-message model id (assistant turns). */
  model?: string
  /** OpenCode's own USD cost estimate for the turn. */
  cost?: number
  /** Token counts for the turn (assistant messages). */
  tokens?: OpencodeTokens
}

export interface OpencodeSession {
  id: string
  title: string
  cwd?: string
  model?: string
  createdAt: number
  updatedAt: number
  messages: OpencodeMessage[]
}

export type OpencodeReader = (home: string) => Promise<OpencodeSession[]>

let reader: OpencodeReader | null = null

/**
 * Inject the SQLite reader. Desktop leaves this unset (falls through to the Rust
 * command); the standalone CLI installs a Node `node:sqlite` reader; tests stub
 * it. Pass `null` to restore the default path.
 */
export function setOpencodeReader(fn: OpencodeReader | null): void {
  reader = fn
}

/** @deprecated Test alias for {@link setOpencodeReader}. */
export const __setOpencodeReaderForTesting = setOpencodeReader

/** Read every OpenCode session from the SQLite store. [] off-desktop. */
export async function readOpencodeSessions(home: string): Promise<OpencodeSession[]> {
  if (reader) return reader(home)
  if (!isTauri()) return []
  const { invoke } = await import("@tauri-apps/api/core")
  try {
    return await invoke<OpencodeSession[]>("opencode_sessions_read", { home })
  } catch {
    return []
  }
}
