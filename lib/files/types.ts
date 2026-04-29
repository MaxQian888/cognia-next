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
}

/** Raw shape coming back from the Rust side (snake_case fields). */
export interface RawWorkspaceEntry {
  rel_path: string
  absolute_path: string
  is_dir: boolean
  size: number
}

export function fromRawWorkspaceEntry(raw: RawWorkspaceEntry): WorkspaceEntry {
  return {
    relPath: raw.rel_path,
    absolutePath: raw.absolute_path,
    isDir: raw.is_dir,
    size: raw.size,
  }
}
