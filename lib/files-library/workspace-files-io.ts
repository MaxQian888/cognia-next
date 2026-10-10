/**
 * The host side of workspace files (ADR-0223 §8): asking the ledger for its
 * resource index, finding a file on disk, reading its bytes and opening it in
 * its conversation's Files panel (ADR-0222). Files only ever reads here.
 */

import { loggers } from "@cognia/logging"
import { loadConversationFileSpace } from "@/lib/filespace/load"
import { openFileSpacePath } from "@/lib/filespace/open"
import { toFileSpacePath } from "@/lib/filespace/paths"
import {
  readWorkspaceFileChunk,
  statWorkspaceFile,
  WORKSPACE_CHUNK_READ_MAX_BYTES,
  type WorkspaceFileChunk,
} from "@/lib/files/workspace-fs"
import type { WorkspaceStat } from "@/lib/files/types"
import type { LibraryItemWorkspaceLocation } from "@/lib/db/files-library-types"
import { isTauri } from "@/lib/tauri"
import type { FileSpacePath, OpenFileSpacePathResult } from "@/types/filespace"
import { listTaskResourceIndex } from "@/lib/task-workspace/client"
import type { TaskResourceIndexEntry } from "@/lib/task-workspace/types"
import { goToSession, type FilesNavigator } from "./open"
import type { FilesEntry } from "./types"

const log = loggers.store

/** Why a workspace file could not be read or opened; `files.errors.<code>`. */
export type FilesWorkspaceFileErrorCode =
  "files_workspace_missing" | "files_workspace_unavailable" | "files_workspace_too_large"

export class FilesWorkspaceFileError extends Error {
  constructor(readonly code: FilesWorkspaceFileErrorCode) {
    super(code)
    this.name = "FilesWorkspaceFileError"
  }
}

/**
 * Largest workspace file Files reads into memory on this device, for a
 * preview, a download, a zip, a copy or Use in chat. A paired device's own
 * ceiling (`FILES_REMOTE_MAX_BYTES`) is lower and applies on top.
 */
export const FILES_WORKSPACE_READ_MAX_BYTES = 256 * 1024 * 1024

/**
 * Whether this device lists its own workspace files: only the desktop app
 * has the task-workspace ledger and a disk to read them from. Everywhere
 * else the kind is held back (`ops.ts`, `workspaceFiles`), and a paired
 * device sees the host's instead.
 */
export function hasLocalWorkspaceFiles(): boolean {
  return isTauri()
}

/**
 * The ledger's resource index, or null when it could not be asked (the
 * code-adoption turn rows then stand in alone).
 */
export async function loadWorkspaceFileIndex(
  deps: { list?: () => Promise<TaskResourceIndexEntry[]> } = {}
): Promise<TaskResourceIndexEntry[] | null> {
  try {
    return await (deps.list ?? listTaskResourceIndex)()
  } catch (error) {
    log.warn("files workspace index unavailable", { error: String(error) })
    return null
  }
}

export interface WorkspaceFileOnDisk {
  /** The root the file was found under. */
  root: string
  relPath: string
  size: number
}

export interface WorkspaceFileIoDeps {
  stat?: (root: string, relPath: string) => Promise<WorkspaceStat>
  readChunk?: (
    root: string,
    relPath: string,
    offset: number,
    length: number
  ) => Promise<WorkspaceFileChunk>
}

/**
 * The roots that may hold the file, in the order to try them. An applied
 * change is in the workspace root only: a copy left in the run's root would be
 * the agent's version, not the file as it is now. A pending one is in the
 * run's root only: the workspace root holds the person's version. Not known:
 * the run's root while it exists, then the workspace root.
 */
export function workspaceFileRoots(location: LibraryItemWorkspaceLocation): string[] {
  if (location.adoption === "applied") return [location.workspaceRoot]
  if (location.adoption === "pending") return [location.executionRoot]
  return [...new Set([location.executionRoot, location.workspaceRoot])]
}

/**
 * Where the file is now (see `workspaceFileRoots`). Null when no root it may
 * be under holds a file at that path.
 */
export async function locateWorkspaceFile(
  location: LibraryItemWorkspaceLocation,
  deps: WorkspaceFileIoDeps = {}
): Promise<WorkspaceFileOnDisk | null> {
  const stat = deps.stat ?? statWorkspaceFile
  const roots = workspaceFileRoots(location)
  for (const root of roots) {
    try {
      const found = await stat(root, location.relPath)
      if (found.exists && !found.isDir) {
        return { root, relPath: location.relPath, size: found.size }
      }
    } catch {
      // The root is gone, or the host does not serve it: try the next one.
    }
  }
  return null
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * A slice of the file's bytes, from where it is now. Throws
 * `files_workspace_missing` when it is gone.
 */
export async function readWorkspaceFileSlice(
  location: LibraryItemWorkspaceLocation,
  offset: number,
  length: number,
  deps: WorkspaceFileIoDeps = {}
): Promise<{ bytes: Uint8Array<ArrayBuffer>; size: number; eof: boolean }> {
  const found = await locateWorkspaceFile(location, deps)
  if (!found) throw new FilesWorkspaceFileError("files_workspace_missing")
  const chunk = await (deps.readChunk ?? readWorkspaceFileChunk)(
    found.root,
    found.relPath,
    offset,
    Math.min(length, WORKSPACE_CHUNK_READ_MAX_BYTES)
  )
  return { bytes: decodeBase64(chunk.dataBase64), size: chunk.size, eof: chunk.eof }
}

/**
 * The whole file, read a chunk at a time. Throws `files_workspace_missing`
 * when it is gone and `files_workspace_too_large` over `maxBytes`.
 */
export async function readWorkspaceFileBytes(
  location: LibraryItemWorkspaceLocation,
  options: { maxBytes?: number } = {},
  deps: WorkspaceFileIoDeps = {}
): Promise<Uint8Array<ArrayBuffer>> {
  const maxBytes = options.maxBytes ?? FILES_WORKSPACE_READ_MAX_BYTES
  const found = await locateWorkspaceFile(location, deps)
  if (!found) throw new FilesWorkspaceFileError("files_workspace_missing")
  if (found.size > maxBytes) throw new FilesWorkspaceFileError("files_workspace_too_large")
  const readChunk = deps.readChunk ?? readWorkspaceFileChunk
  const parts: Uint8Array[] = []
  let offset = 0
  for (;;) {
    const chunk = await readChunk(found.root, found.relPath, offset, WORKSPACE_CHUNK_READ_MAX_BYTES)
    const bytes = decodeBase64(chunk.dataBase64)
    offset += bytes.byteLength
    // A file that grew while it was read past the ceiling stops here.
    if (offset > maxBytes) throw new FilesWorkspaceFileError("files_workspace_too_large")
    if (bytes.byteLength > 0) parts.push(bytes)
    if (chunk.eof || bytes.byteLength === 0) break
  }
  const whole = new Uint8Array(offset)
  let at = 0
  for (const part of parts) {
    whole.set(part, at)
    at += part.byteLength
  }
  return whole
}

function joinHostPath(root: string, relPath: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/"
  const trimmed = root.endsWith(separator) ? root.slice(0, -1) : root
  return `${trimmed}${separator}${separator === "/" ? relPath : relPath.replaceAll("/", "\\")}`
}

/** What opening a workspace file in its conversation came to. */
export type OpenWorkspaceFileResult =
  | "opened"
  /** Not inside the conversation's FileSpace (a run root it does not mount): preview it here. */
  | "outside"
  | "session-changed"

export interface OpenWorkspaceFileDeps extends WorkspaceFileIoDeps {
  loadSpace?: typeof loadConversationFileSpace
  openPath?: (args: { sessionId: string; path: FileSpacePath }) => Promise<OpenFileSpacePathResult>
  goTo?: (sessionId: string, navigator: FilesNavigator) => Promise<void>
}

/**
 * Leave Files for the file's conversation and show it in that conversation's
 * Files panel, through the same opener a `view=files` link uses. Checks the
 * file is still on disk first, so a gone file says so here instead of
 * opening a conversation to show nothing.
 */
export async function openWorkspaceFileInConversation(
  entry: Pick<FilesEntry, "workspace">,
  navigator: FilesNavigator,
  deps: OpenWorkspaceFileDeps = {}
): Promise<OpenWorkspaceFileResult> {
  const location = entry.workspace
  if (!location) throw new FilesWorkspaceFileError("files_workspace_missing")
  const found = await locateWorkspaceFile(location, deps)
  if (!found) throw new FilesWorkspaceFileError("files_workspace_missing")
  const { space } = await (deps.loadSpace ?? loadConversationFileSpace)(location.sessionId)
  if (space.status === "deleted") return "outside"
  const path = toFileSpacePath(space, joinHostPath(found.root, found.relPath))
  if (!path) return "outside"
  await (deps.goTo ?? goToSession)(location.sessionId, navigator)
  const result = await (deps.openPath ?? openFileSpacePath)({ sessionId: location.sessionId, path })
  switch (result) {
    case "opened":
      return "opened"
    case "session-changed":
      return "session-changed"
    case "not-found":
      throw new FilesWorkspaceFileError("files_workspace_missing")
    case "no-backend":
    case "offline":
      throw new FilesWorkspaceFileError("files_workspace_unavailable")
    case "outside":
      return "outside"
  }
}
