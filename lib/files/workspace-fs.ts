// Workspace file-tree operations exposed by the Rust `fs_*_workspace` commands.
//
// Every call goes through `transport.call` (NOT a raw `invoke`) so the same
// wrapper works on the desktop (Tauri invoke) and from a paired/remote client
// (the companion V2 API gateway) without the call site knowing which. All paths
// are `root` + `relPath` and are path-traversal checked inside Rust — a
// `relPath` that escapes `root` is rejected on-disk.
//
// Reads (list/stat/read) are ungated. Writes (create/delete/rename/copy/write)
// require the remote-control capability when issued from a paired device.

import { transport } from "@/lib/tauri"
import {
  fromRawWorkspaceEntry,
  fromRawWorkspaceStat,
  fromRawWorkspaceContentMatch,
  type RawWorkspaceEntry,
  type RawWorkspaceStat,
  type RawWorkspaceContentMatch,
  type WorkspaceEntry,
  type WorkspaceStat,
  type WorkspaceContentMatch,
} from "@/lib/files/types"

export interface WorkspaceContentSearchOptions {
  /** Interpret `query` as a Rust regex. Invalid patterns reject. */
  isRegex?: boolean
  /** Case-sensitive match (default: false). */
  caseSensitive?: boolean
  /** Cap the number of returned matches (Rust hard-limit: 500). */
  maxResults?: number
}

/**
 * List the immediate children of `root`/`relPath` (omit `relPath` for the root
 * itself). Non-recursive — expand one directory at a time for a lazy file tree.
 * Directories come before files, each sorted case-insensitively by name.
 * Respects `.gitignore` by default; pass `includeIgnored` to show everything.
 */
export async function listWorkspaceDir(
  root: string,
  relPath?: string,
  includeIgnored?: boolean
): Promise<WorkspaceEntry[]> {
  const raw = await transport.call<RawWorkspaceEntry[]>("fs_list_workspace_dir", {
    root,
    relPath,
    includeIgnored,
  })
  return raw.map(fromRawWorkspaceEntry)
}

/** What a recursive walk found, and what it withheld. */
export interface WorkspaceWalkResult {
  entries: WorkspaceEntry[]
  /** A cap stopped the walk before the tree was exhausted. */
  truncated: boolean
  /** Files refused by the host's sensitive-name floor (`.env`, `id_rsa`, …). */
  skippedSensitive: number
}

export interface WorkspaceWalkOptions {
  relPath?: string
  includeIgnored?: boolean
  /** Include directories as well as files. Default: files only. */
  includeDirs?: boolean
  /** Entry cap. Default 5 000, hard ceiling 50 000. */
  maxEntries?: number
  /** Directory depth. Default 24. */
  maxDepth?: number
}

/**
 * Recursively enumerate a workspace, honouring `.gitignore`.
 *
 * The counterpart to {@link listWorkspaceDir}, which is depth-1 on purpose for
 * the file tree's lazy expansion. Use this when a consumer needs the whole
 * repository — before it existed, the only recursive walker was
 * `searchWorkspace`, capped at 200 hits.
 *
 * Caps are reported rather than silent: check `truncated` before treating the
 * result as the repository's full contents. `skippedSensitive` counts files the
 * host refused outright; that floor cannot be disabled, including by
 * `includeIgnored`.
 */
export async function walkWorkspace(
  root: string,
  options: WorkspaceWalkOptions = {}
): Promise<WorkspaceWalkResult> {
  const raw = await transport.call<{
    entries: RawWorkspaceEntry[]
    truncated: boolean
    skippedSensitive: number
  }>("fs_walk_workspace", {
    root,
    relPath: options.relPath,
    includeIgnored: options.includeIgnored,
    includeDirs: options.includeDirs,
    maxEntries: options.maxEntries,
    maxDepth: options.maxDepth,
  })
  return {
    entries: raw.entries.map(fromRawWorkspaceEntry),
    truncated: raw.truncated,
    skippedSensitive: raw.skippedSensitive,
  }
}

/**
 * Metadata for a single workspace path. Returns `{ exists: false }` (never
 * throws) when the path is absent, so callers can probe before a create/rename.
 */
export async function statWorkspaceFile(root: string, relPath: string): Promise<WorkspaceStat> {
  const raw = await transport.call<RawWorkspaceStat>("fs_stat_workspace_file", {
    root,
    relPath,
  })
  return fromRawWorkspaceStat(raw)
}

/**
 * Project-wide content search under `root` (respects `.gitignore`). Returns
 * per-line matches with 1-based line/column and a trimmed preview. Empty query
 * returns `[]`. Throws if `root` isn't a directory or the regex is invalid.
 */
export async function searchWorkspaceContent(
  root: string,
  query: string,
  options: WorkspaceContentSearchOptions = {}
): Promise<WorkspaceContentMatch[]> {
  const raw = await transport.call<RawWorkspaceContentMatch[]>("fs_search_content_workspace", {
    root,
    query,
    isRegex: options.isRegex,
    caseSensitive: options.caseSensitive,
    maxResults: options.maxResults,
  })
  return raw.map(fromRawWorkspaceContentMatch)
}

/** Read a text file relative to `root` (truncated to `maxBytes` when given). */
export async function readWorkspaceFile(
  root: string,
  relPath: string,
  maxBytes?: number
): Promise<string> {
  return transport.call<string>("fs_read_workspace_file", { root, relPath, maxBytes })
}

/** Write a text file relative to `root`, creating parent directories. */
export async function writeWorkspaceFile(
  root: string,
  relPath: string,
  content: string
): Promise<void> {
  await transport.call<null>("fs_write_workspace_file", { root, relPath, content })
}

/** Create a directory (and missing parents) relative to `root`. */
export async function createWorkspaceDir(root: string, relPath: string): Promise<void> {
  await transport.call<null>("fs_create_workspace_dir", { root, relPath })
}

/**
 * Delete a file or directory relative to `root`. A non-empty directory needs
 * `recursive: true`.
 */
export async function deleteWorkspaceEntry(
  root: string,
  relPath: string,
  recursive?: boolean
): Promise<void> {
  await transport.call<null>("fs_delete_workspace_entry", { root, relPath, recursive })
}

/** Rename/move an entry within `root`. Refuses to clobber an existing dest. */
export async function renameWorkspaceEntry(
  root: string,
  fromRelPath: string,
  toRelPath: string
): Promise<void> {
  await transport.call<null>("fs_rename_workspace_entry", { root, fromRelPath, toRelPath })
}

/**
 * Copy an entry within `root`. A directory needs `recursive: true`. Refuses to
 * clobber an existing dest.
 */
export async function copyWorkspaceEntry(
  root: string,
  fromRelPath: string,
  toRelPath: string,
  recursive?: boolean
): Promise<void> {
  await transport.call<null>("fs_copy_workspace_entry", {
    root,
    fromRelPath,
    toRelPath,
    recursive,
  })
}
