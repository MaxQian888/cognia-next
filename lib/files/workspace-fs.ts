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
import { parseInvokeError } from "@/lib/tauri/command-error"
import {
  fromRawWorkspaceEntry,
  fromRawWorkspaceStat,
  fromRawWorkspaceContentMatch,
  type RawWorkspaceEntry,
  type RawWorkspaceStat,
  type RawWorkspaceContentMatch,
  type WorkspaceEntry,
  type WorkspaceRoot,
  type WorkspaceStat,
  type WorkspaceContentMatch,
} from "@/lib/files/types"
import type {
  WorkspaceWalkOptions,
  WorkspaceWalkResult,
} from "@cognia/plugin-contract/lib/files/workspace-fs"
export type {
  WorkspaceWalkOptions,
  WorkspaceWalkResult,
} from "@cognia/plugin-contract/lib/files/workspace-fs"

export interface WorkspaceContentSearchOptions {
  /** Interpret `query` as a Rust regex. Invalid patterns reject. */
  isRegex?: boolean
  /** Case-sensitive match (default: false). */
  caseSensitive?: boolean
  /** Cap the number of returned matches (Rust hard-limit: 500). */
  maxResults?: number
}

/**
 * Ask the Host which directories it will browse.
 *
 * Nothing else in this module can be called without already knowing a `root`,
 * and a client that guesses one gets a refusal it cannot act on. That is the
 * whole reason this exists: the confinement differs per Host (a headless server
 * browses only `COGNIA_WORKSPACES_DIR`, a desktop browses what the active
 * project registered) and the client has no other way to learn it.
 *
 * Resolves to an empty list rather than throwing when the Host is too old to
 * know the command. An empty list means "this Host did not say", NOT "nothing
 * is browsable", so callers must keep whatever fallback they had instead of
 * rendering a dead end.
 */
export async function listWorkspaceRoots(): Promise<WorkspaceRoot[]> {
  let report: { roots?: unknown } | null
  try {
    report = await transport.call<{ roots?: unknown } | null>("fs_workspace_roots")
  } catch {
    return []
  }
  const roots = report?.roots
  if (!Array.isArray(roots)) return []
  return roots.filter(isWorkspaceRoot)
}

function isWorkspaceRoot(value: unknown): value is WorkspaceRoot {
  if (!value || typeof value !== "object") return false
  const candidate = value as { path?: unknown; source?: unknown }
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    (candidate.source === "desktop-project" || candidate.source === "headless-workspaces-dir")
  )
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

export interface WorkspaceFileWriteResult {
  sha256: string
  size: number
  mtimeMs: number | null
}

export interface WorkspaceFileVersioned extends WorkspaceFileWriteResult {
  content: string
}

/** Read text and the hash of exactly the raw bytes decoded by the host. */
export async function readWorkspaceFileVersioned(
  root: string,
  relPath: string,
  maxBytes?: number
): Promise<WorkspaceFileVersioned> {
  return transport.call<WorkspaceFileVersioned>("fs_read_workspace_file_versioned", {
    root,
    relPath,
    maxBytes,
  })
}

/**
 * Read a workspace file's raw bytes as base64 — the binary counterpart to
 * {@link readWorkspaceFile}, for file types text cannot represent (image
 * previews). Rejects when the file exceeds `maxBytes` (or the host's hard
 * cap), so a caller can bound the frame before it is read.
 */
export async function readWorkspaceFileBase64(
  root: string,
  relPath: string,
  maxBytes?: number
): Promise<string> {
  return transport.call<string>("fs_read_workspace_file_base64", {
    root,
    relPath,
    maxBytes,
  })
}

/** Largest slice {@link readWorkspaceFileChunk} returns: one share chunk (ADR-0222). */
export const WORKSPACE_CHUNK_READ_MAX_BYTES = 4 * 1024 * 1024

/** One slice of a workspace file. */
export interface WorkspaceFileChunk {
  /** The bytes read, base64. */
  dataBase64: string
  offset: number
  /** Below the requested length only at the end of the file. */
  bytesRead: number
  /** The file's size when this slice was read — compare across slices to notice a file changing. */
  size: number
  eof: boolean
}

/**
 * Read `length` bytes of a workspace file from `offset` — the streaming
 * counterpart of {@link readWorkspaceFileBase64} for files too large to read
 * whole (sharing a file uploads it chunk by chunk). The host caps `length` at
 * {@link WORKSPACE_CHUNK_READ_MAX_BYTES}; a read at or past the end resolves to
 * an empty slice with `eof`, so a loop ends on `eof` alone.
 */
export async function readWorkspaceFileChunk(
  root: string,
  relPath: string,
  offset: number,
  length: number
): Promise<WorkspaceFileChunk> {
  return transport.call<WorkspaceFileChunk>("fs_read_workspace_file_chunk", {
    root,
    relPath,
    offset,
    length,
  })
}

/** Write a text file relative to `root`, creating parent directories. */
export async function writeWorkspaceFile(
  root: string,
  relPath: string,
  content: string
): Promise<void> {
  await transport.call<WorkspaceFileWriteResult>("fs_write_workspace_file", {
    root,
    relPath,
    content,
  })
}

export type WorkspaceFileWritePrecondition =
  { expectedSha256: string; expectAbsent?: never } | { expectAbsent: true; expectedSha256?: never }

const WORKSPACE_FILE_CONFLICT = "workspace_file_conflict"

export class WorkspaceFileConflictError extends Error {
  readonly code = WORKSPACE_FILE_CONFLICT

  constructor(readonly currentSha256: string | null) {
    super(WORKSPACE_FILE_CONFLICT)
    this.name = "WorkspaceFileConflictError"
  }
}

/** Recognize the error returned by checked writes on either host transport. */
export function isWorkspaceFileConflict(error: unknown): error is WorkspaceFileConflictError {
  return error instanceof WorkspaceFileConflictError
}

function workspaceFileConflictFrom(error: unknown): WorkspaceFileConflictError | null {
  if (isWorkspaceFileConflict(error)) return error
  if (error && typeof error === "object" && "code" in error && "currentSha256" in error) {
    if (
      error.code === WORKSPACE_FILE_CONFLICT &&
      (error.currentSha256 === null || typeof error.currentSha256 === "string")
    ) {
      return new WorkspaceFileConflictError(error.currentSha256)
    }
  }
  // Companion errors retain code/message but discard arbitrary payload fields.
  // The stable prefix carries the hash through them and legacy Tauri strings.
  const { message } = parseInvokeError(error)
  const prefix = `${WORKSPACE_FILE_CONFLICT}:`
  if (!message.startsWith(prefix)) return null
  try {
    const payload: unknown = JSON.parse(message.slice(prefix.length))
    if (payload && typeof payload === "object" && "currentSha256" in payload) {
      if (payload.currentSha256 === null || typeof payload.currentSha256 === "string") {
        return new WorkspaceFileConflictError(payload.currentSha256)
      }
    }
  } catch {
    // A malformed payload must not be treated as "missing file": that would
    // turn an unknown failure into permission to recreate it on retry.
  }
  return null
}

/** Atomically replace a file only if the host still observes the given base. */
export async function writeWorkspaceFileChecked(
  root: string,
  relPath: string,
  content: string,
  precondition: WorkspaceFileWritePrecondition
): Promise<WorkspaceFileWriteResult> {
  try {
    return await transport.call<WorkspaceFileWriteResult>("fs_write_workspace_file", {
      root,
      relPath,
      content,
      ...precondition,
    })
  } catch (error) {
    throw workspaceFileConflictFrom(error) ?? error
  }
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
