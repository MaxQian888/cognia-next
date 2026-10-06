// Thin, mockable bridge to the Rust `opencode_sessions_read` command, which
// reads OpenCode's SQLite store (`~/.local/share/opencode/opencode.db`) and
// returns already-normalized sessions. Isolated here so the `opencode` adapter
// (and its tests) can stub the SQLite access without touching Tauri.

import { isTauri } from "@/lib/tauri"

// The normalized record shapes are owned by the OpenCode history reader
// (ADR-0217); both readers produce them and the session source consumes them.
import type { OpencodeSession } from "@cognia/agent-opencode/history"
export type {
  OpencodeBackgroundJob,
  OpencodeMessage,
  OpencodePart,
  OpencodeSession,
  OpencodeTokens,
} from "@cognia/agent-opencode/history"

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

/**
 * Read every OpenCode session from the SQLite store.
 *
 * `[]` off-desktop (no Tauri command to call, and the picker path handles the
 * share-export JSON instead) — but a real read FAILURE throws.
 *
 * It used to swallow the invoke error and return `[]`, which quietly defeated
 * the one surface built for exactly this: `scanAllSources` collects per-source
 * failures so the dialog can say "some sources couldn't be read", and its own
 * comment names OpenCode's DB as the motivating example. Because nothing ever
 * threw, OpenCode could only ever report "no sessions" — indistinguishable from
 * "you have no OpenCode history" even when the database was locked, corrupt, or
 * unreadable.
 */
export async function readOpencodeSessions(home: string): Promise<OpencodeSession[]> {
  if (reader) return reader(home)
  if (!isTauri()) return []
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<OpencodeSession[]>("opencode_sessions_read", { home })
}
