/**
 * Row types for the local code-adoption tracker (Phase 1).
 *
 * Mirrors the Rust `CodeAdoptionTurn` / `FileAttribution` serde DTOs
 * (`src-tauri/src/code_adoption/mod.rs`) 1:1 (camelCase). Persisted to the
 * `codeAdoptionTurns` Dexie table (v108). Metrics + hunk line ranges only —
 * never the diff body — so the row is safe and is intentionally kept out of
 * mobile sync.
 */

/** One attributed file: metrics + hunk ranges, no code. */
export interface CodeAdoptionFile {
  /** Repo-relative path, forward slashes. */
  path: string
  added: number
  removed: number
  /** `true` when the file was created during the turn. */
  isNew: boolean
  /** Inclusive `[startLine, endLine]` ranges on the new side, one per hunk. */
  hunks: Array<[number, number]>
}

/** One turn's write-attribution record. */
export interface CodeAdoptionTurnRow {
  /** `"${sessionId}:${runId}"` — Dexie primary key. */
  id: string
  runId: number
  sessionId: string
  /** Canonicalized workspace root (resolved cwd). */
  workspaceRoot: string
  /** `"in-app"` in Phase 1; `"cc" | "codex" | "opencode"` later. */
  agentKind: string
  model: string | null
  /** Epoch milliseconds at reconcile time. */
  ts: number
  totalFiles: number
  totalAdded: number
  totalRemoved: number
  files: CodeAdoptionFile[]
  /** `true` when the per-turn file cap clamped the record. */
  truncated: boolean
}
