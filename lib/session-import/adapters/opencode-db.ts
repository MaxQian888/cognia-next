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

export interface OpencodeMessage {
  role: string
  parts: OpencodePart[]
  createdAt: number
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

type Reader = (home: string) => Promise<OpencodeSession[]>

let reader: Reader | null = null

/** Override the SQLite reader (tests). Pass null to restore the default. */
export function __setOpencodeReaderForTesting(fn: Reader | null): void {
  reader = fn
}

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
