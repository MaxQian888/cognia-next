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
  /** OpenCode `FilePart` MIME field (the SDK sends/stores `mime`). */
  mime?: string
  /** Legacy/normalized spelling kept for share exports that used it. */
  mediaType?: string
  filename?: string
  url?: string
  /** Agent-delegation part: the subagent's name. */
  name?: string
}

/** Normalized per-turn token counts projected by the readers. */
export interface OpencodeTokens {
  input?: number
  output?: number
  reasoning?: number
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
  /** Parent session id when this is a subagent (child) session. */
  parentId?: string
  createdAt: number
  updatedAt: number
  messages: OpencodeMessage[]
}

/**
 * Candidate directories that may contain `opencode.db`, most-specific first.
 * MUST stay in sync with `candidate_db_paths` in `src-tauri/src/session_import.rs`
 * and `candidateDbPaths` in `cli/src/tui/runtime/node-opencode-reader.ts`.
 * Used as the watch roots so the fs-watcher picks up OpenCode writes.
 *
 * `dataDir` is the environment-resolved root from `lib/agent-roots/` (which
 * honours `$XDG_DATA_HOME` and `%APPDATA%`); it takes precedence when known.
 */
export function opencodeDataDirs(
  home: string,
  dataDir?: string,
  platformDataDir?: string
): string[] {
  const out: string[] = []
  if (dataDir) out.push(dataDir)
  if (platformDataDir) out.push(platformDataDir)
  if (home) {
    const sep = home.includes("\\") ? "\\" : "/"
    const join = (...parts: string[]) => [home, ...parts].join(sep)
    out.push(join(".local", "share", "opencode"))
    // Rust/CLI also probe the macOS platform data fallback. It is safe to
    // include on other POSIX hosts: the watcher discards missing directories.
    if (sep === "/") out.push(join("Library", "Application Support", "opencode"))
    out.push(join("AppData", "Roaming", "opencode"))
  }
  return out.filter((dir, i) => out.indexOf(dir) === i)
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
