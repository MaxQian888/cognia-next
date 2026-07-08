// Shared types for the @file/@folder picker. These mirror the Rust shapes
// returned by the `fs_search_workspace` and `fs_read_workspace_file` Tauri
// commands but live here so the rest of the frontend never has to import
// from the Tauri bindings layer directly.

export interface WorkspaceEntry {
  /** Path relative to the search root, normalised to forward slashes. */
  relPath: string
  absolutePath: string
  isDir: boolean
  size: number
  /** Last-modified time in ms since epoch, or `null` when unavailable. */
  mtimeMs: number | null
}

/** Raw shape coming back from the Rust side (snake_case fields). */
export interface RawWorkspaceEntry {
  rel_path: string
  absolute_path: string
  is_dir: boolean
  size: number
  mtime_ms?: number | null
}

export function fromRawWorkspaceEntry(raw: RawWorkspaceEntry): WorkspaceEntry {
  return {
    relPath: raw.rel_path,
    absolutePath: raw.absolute_path,
    isDir: raw.is_dir,
    size: raw.size,
    mtimeMs: raw.mtime_ms ?? null,
  }
}

/** Metadata for a single workspace path (mirrors the Rust `WorkspaceStat`). */
export interface WorkspaceStat {
  exists: boolean
  isDir: boolean
  size: number
  mtimeMs: number | null
}

/** Raw shape from the Rust `fs_stat_workspace_file` command (snake_case). */
export interface RawWorkspaceStat {
  exists: boolean
  is_dir: boolean
  size: number
  mtime_ms?: number | null
}

export function fromRawWorkspaceStat(raw: RawWorkspaceStat): WorkspaceStat {
  return {
    exists: raw.exists,
    isDir: raw.is_dir,
    size: raw.size,
    mtimeMs: raw.mtime_ms ?? null,
  }
}

/** A single content-search hit (mirrors Rust `WorkspaceContentMatch`). */
export interface WorkspaceContentMatch {
  relPath: string
  absolutePath: string
  /** 1-based line number. */
  line: number
  /** 1-based column (char offset) where the match starts. */
  column: number
  /** The matching line, trimmed on the Rust side. */
  preview: string
}

/** Raw shape from `fs_search_content_workspace` (snake_case). */
export interface RawWorkspaceContentMatch {
  rel_path: string
  absolute_path: string
  line: number
  column: number
  preview: string
}

export function fromRawWorkspaceContentMatch(raw: RawWorkspaceContentMatch): WorkspaceContentMatch {
  return {
    relPath: raw.rel_path,
    absolutePath: raw.absolute_path,
    line: raw.line,
    column: raw.column,
    preview: raw.preview,
  }
}
