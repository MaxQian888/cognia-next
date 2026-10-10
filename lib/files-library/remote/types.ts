// Wire types and validators for the Files library on a paired device
// (ADR-0223 §9).
//
// A paired phone manages the HOST's library: it reads the host's aggregate
// over `files_library_*` and sends every change back, where the same writers
// the desktop page uses apply it. These are the shapes that cross that wire,
// published in `protocol/companion-response-schemas.json` (`FilesRemote*`
// defs) and `protocol/companion-request-schemas.json` (`files_library_*`).
//
// The request parsers run on the host even though the companion server
// validates against the published schema first: the desktop-writes bridge is
// also reachable from a headless brain and from tests, and an arm that trusts
// its payload is how a caller would get to name a folder id or a key the
// library never offered it.

import type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
} from "@/lib/db/files-library-types"
import { LIBRARY_FOLDER_COLORS, LIBRARY_FOLDER_ICONS } from "@/lib/db/files-library-types"
import type { FilesEntry } from "../types"

/**
 * One Files entry as the host sends it: the aggregate's entry without its
 * search haystack and extracted excerpt, which can each run to tens of
 * kilobytes. The paired device searches titles itself and asks the host
 * (`files_library_search`) for matches inside bodies.
 */
export type FilesRemoteEntry = Omit<FilesEntry, "searchText" | "excerpt">

/**
 * Why a call was refused. The codes that already have a `files.errors.*`
 * message are the host's own write errors passed through unchanged; the rest
 * are about the remote path itself.
 */
export type FilesRemoteErrorCode =
  /** The host is a headless brain, which serves no Files library. */
  | "headless_host"
  /** A key, folder or upload the host does not have (or no longer has). */
  | "files_remote_not_found"
  /** A payload the host refused before doing anything. */
  | "files_remote_invalid_request"
  /** Larger than a paired device may move in one piece (10 MiB). */
  | "files_remote_too_large"
  /** The conversation to use the item in no longer accepts messages. */
  | "files_remote_session_unwritable"
  /** One of the host's own write errors (`files.errors.*`). */
  | (string & {})

export interface FilesRemoteRefused {
  ok: false
  code: FilesRemoteErrorCode
}

export type FilesRemoteResult<T extends object> = ({ ok: true } & T) | FilesRemoteRefused

export function refused(code: FilesRemoteErrorCode): FilesRemoteRefused {
  return { ok: false, code }
}

export function isRefused(value: unknown): value is FilesRemoteRefused {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string"
  )
}

// ── Answers ──────────────────────────────────────────────────────────────────

export interface FilesRemoteListPage {
  items: FilesRemoteEntry[]
  /** More images exist than the requested `imageLimit` loaded. */
  imagesTruncated: boolean
  /** Present while more of the list follows. */
  nextPageToken?: string
  /**
   * Fingerprint of the whole list this page was cut from. A page whose
   * revision differs from the first page's came from a library that changed
   * mid-read; the device starts over.
   */
  revision: string
}

/** One page of the host's folders, in id order. */
export interface FilesRemoteFolders {
  folders: LibraryFolder[]
  /** Hand back as `pageToken` for the next page; absent on the last. */
  nextPageToken?: string
}

export interface FilesRemoteSearchHit {
  key: string
  kind: FilesEntry["kind"]
  title: string
  mediaType?: string
  updatedAt: number
  projectIds: string[]
}

export interface FilesRemoteSearch {
  items: FilesRemoteSearchHit[]
}

/** `files_library_get`: the entry, and for a document its text for a read-only preview. */
export interface FilesRemoteDetail {
  entry: FilesRemoteEntry
  /** Artifact or canvas document text, cut at `FILES_REMOTE_TEXT_MAX` characters. */
  text?: string
  textTruncated?: boolean
}

/**
 * `files_library_read_chunk`: one slice of a workspace file's bytes, read off
 * the host's disk (ADR-0223 §8). Other kinds' bytes travel as session media.
 */
export interface FilesRemoteReadChunk {
  dataBase64: string
  /** The file's size when the slice was read; a change between slices restarts the read. */
  size: number
  eof: boolean
}

export interface FilesRemoteDuplicate {
  kind: "canvas" | "upload"
  key: string
}

/**
 * Where "Use in chat" put the item. `referenced` means nothing was bound on
 * the host: an artifact or canvas document becomes a chip in the device's own
 * composer, from the text `files_library_get` returns.
 */
export interface FilesRemoteAttach {
  sessionId: string
  created: boolean
  how: "bound" | "referenced"
}

export interface FilesRemoteUploadInit {
  uploadId: string
  chunkSize: number
  resumeOffset: number
  complete: boolean
}

export interface FilesRemoteUploadChunk {
  receivedBytes: number
  complete: boolean
}

export interface FilesRemoteUploadCommit {
  key: string
}

export interface FilesRemotePurge {
  /** Items whose source lives on, so they left the Trash without being deleted. */
  retired: number
}

// ── Bounds (mirrored by the request schemas) ─────────────────────────────────

/** Largest selection one call acts on. */
export const FILES_REMOTE_KEYS_MAX = 500
export const FILES_REMOTE_KEY_MAX = 300
/** Folder names, renames and new conversation titles. */
export const FILES_REMOTE_NAME_MAX = 255
export const FILES_REMOTE_SEARCH_MAX = 200
export const FILES_REMOTE_SEARCH_LIMIT_MAX = 200
export const FILES_REMOTE_PAGE_SIZE_DEFAULT = 200
export const FILES_REMOTE_PAGE_SIZE_MAX = 500
/** Never ask the host to load more images than this. */
export const FILES_REMOTE_IMAGE_LIMIT_MAX = 100_000
export const FILES_REMOTE_IDEMPOTENCY_KEY_MAX = 128
/** Characters of document text one `files_library_get` answers with. */
export const FILES_REMOTE_TEXT_MAX = 128 * 1024
/**
 * What a paired device may move in one piece: an upload, a download, a
 * preview. The same ceiling as session media and composer attachments, so a
 * phone is told up front instead of waiting out a dropped frame.
 */
export const FILES_REMOTE_MAX_BYTES = 10 * 1024 * 1024
/** Bytes one `files_library_read_chunk` answers with at most. */
export const FILES_REMOTE_READ_CHUNK_MAX = 512 * 1024

/** Bytes as the base64 the upload and read chunks carry. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

/** The other way; null when it is not base64. */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> | null {
  let binary: string
  try {
    binary = atob(data)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

// ── Request parsing (host side) ──────────────────────────────────────────────

export class FilesRemoteRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FilesRemoteRequestError"
  }
}

function boundedString(payload: Record<string, unknown>, field: string, max: number): string {
  const value = payload[field]
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new FilesRemoteRequestError(`${field} must be a string of 1–${max} characters`)
  }
  return value
}

function optionalBoundedString(
  payload: Record<string, unknown>,
  field: string,
  max: number
): string | undefined {
  if (payload[field] === undefined || payload[field] === null) return undefined
  return boundedString(payload, field, max)
}

function boundedInteger(
  payload: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  fallback: number
): number {
  const value = payload[field]
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new FilesRemoteRequestError(`${field} must be an integer in ${min}–${max}`)
  }
  return value
}

function requiredInteger(
  payload: Record<string, unknown>,
  field: string,
  min: number,
  max: number
): number {
  if (payload[field] === undefined || payload[field] === null) {
    throw new FilesRemoteRequestError(`${field} is required`)
  }
  return boundedInteger(payload, field, min, max, min)
}

export function parseCallerDeviceId(payload: Record<string, unknown>): string {
  return boundedString(payload, "callerDeviceId", 512)
}

export function parseIdempotencyKey(payload: Record<string, unknown>): string {
  return boundedString(payload, "idempotencyKey", FILES_REMOTE_IDEMPOTENCY_KEY_MAX)
}

export function parseKey(payload: Record<string, unknown>): string {
  return boundedString(payload, "key", FILES_REMOTE_KEY_MAX)
}

export function parseKeys(payload: Record<string, unknown>): string[] {
  const value = payload.keys
  if (!Array.isArray(value) || value.length === 0 || value.length > FILES_REMOTE_KEYS_MAX) {
    throw new FilesRemoteRequestError(`keys must list 1–${FILES_REMOTE_KEYS_MAX} item keys`)
  }
  const keys = value.map((key) => {
    if (typeof key !== "string" || key.length === 0 || key.length > FILES_REMOTE_KEY_MAX) {
      throw new FilesRemoteRequestError("every key must be a non-empty string")
    }
    return key
  })
  return [...new Set(keys)]
}

/** The images the device has loaded, so the host resolves the same entries. */
export function parseImageLimit(payload: Record<string, unknown>, fallback: number): number {
  return boundedInteger(payload, "imageLimit", 1, FILES_REMOTE_IMAGE_LIMIT_MAX, fallback)
}

/** `pageSize` / `pageToken`, as every paged `files_library_*` read takes them. */
export function parsePageRequest(payload: Record<string, unknown>): {
  pageSize: number
  offset: number
} {
  const pageSize = boundedInteger(
    payload,
    "pageSize",
    1,
    FILES_REMOTE_PAGE_SIZE_MAX,
    FILES_REMOTE_PAGE_SIZE_DEFAULT
  )
  const token = optionalBoundedString(payload, "pageToken", 64)
  return { pageSize, offset: token === undefined ? 0 : decodePageToken(token) }
}

export function parseListRequest(
  payload: Record<string, unknown>,
  fallbackImageLimit: number
): { imageLimit: number; pageSize: number; offset: number } {
  return { imageLimit: parseImageLimit(payload, fallbackImageLimit), ...parsePageRequest(payload) }
}

export function encodePageToken(offset: number): string {
  return `o${offset}`
}

export function decodePageToken(token: string): number {
  const match = /^o(\d{1,9})$/.exec(token)
  if (!match) throw new FilesRemoteRequestError("pageToken is not one this host issued")
  return Number(match[1])
}

export function parseSearchRequest(payload: Record<string, unknown>): {
  query: string
  limit: number
} {
  const query = boundedString(payload, "query", FILES_REMOTE_SEARCH_MAX)
  if (!query.trim()) throw new FilesRemoteRequestError("query must not be blank")
  const limit = boundedInteger(payload, "limit", 1, FILES_REMOTE_SEARCH_LIMIT_MAX, 50)
  return { query, limit }
}

export function parseFavoriteRequest(payload: Record<string, unknown>): {
  keys: string[]
  favorite: boolean
} {
  if (typeof payload.favorite !== "boolean") {
    throw new FilesRemoteRequestError("favorite must be a boolean")
  }
  return { keys: parseKeys(payload), favorite: payload.favorite }
}

/** `folderId: null` takes the items out of Folders. */
export function parseMoveRequest(payload: Record<string, unknown>): {
  keys: string[]
  folderId: string | null
} {
  const keys = parseKeys(payload)
  if (payload.folderId === null) return { keys, folderId: null }
  return { keys, folderId: boundedString(payload, "folderId", FILES_REMOTE_KEY_MAX) }
}

export function parseName(payload: Record<string, unknown>, field = "name"): string {
  const name = boundedString(payload, field, FILES_REMOTE_NAME_MAX)
  if (!name.trim()) throw new FilesRemoteRequestError(`${field} must not be blank`)
  return name
}

export function parseRenameRequest(payload: Record<string, unknown>): {
  key: string
  name: string
} {
  return { key: parseKey(payload), name: parseName(payload) }
}

export function parseDuplicateRequest(payload: Record<string, unknown>): {
  key: string
  suffix: string
  fallbackName: string
  projectId?: string
} {
  const projectId = optionalBoundedString(payload, "projectId", FILES_REMOTE_KEY_MAX)
  return {
    key: parseKey(payload),
    // The copy suffix is the device's locale, not the host's.
    suffix: boundedString(payload, "suffix", 40),
    fallbackName: parseName(payload, "fallbackName"),
    ...(projectId ? { projectId } : {}),
  }
}

export function parseAttachRequest(payload: Record<string, unknown>): {
  key: string
  sessionId?: string
  title: string
} {
  const sessionId = optionalBoundedString(payload, "sessionId", 512)
  return {
    key: parseKey(payload),
    ...(sessionId ? { sessionId } : {}),
    title: parseName(payload, "title"),
  }
}

export function parseFolderId(payload: Record<string, unknown>, field = "folderId"): string {
  return boundedString(payload, field, FILES_REMOTE_KEY_MAX)
}

export function parseFolderStyleRequest(payload: Record<string, unknown>): {
  folderId: string
  style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null }
} {
  const folderId = parseFolderId(payload)
  const style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null } = {}
  if ("color" in payload) {
    const color = payload.color
    if (color !== null && !(LIBRARY_FOLDER_COLORS as readonly unknown[]).includes(color)) {
      throw new FilesRemoteRequestError("color is not one of the folder colors")
    }
    style.color = color as LibraryFolderColor | null
  }
  if ("icon" in payload) {
    const icon = payload.icon
    if (icon !== null && !(LIBRARY_FOLDER_ICONS as readonly unknown[]).includes(icon)) {
      throw new FilesRemoteRequestError("icon is not one of the folder icons")
    }
    style.icon = icon as LibraryFolderIcon | null
  }
  if (!("color" in style) && !("icon" in style)) {
    throw new FilesRemoteRequestError("a style change names a color, an icon, or both")
  }
  return { folderId, style }
}

export function parseFolderDeleteRequest(payload: Record<string, unknown>): {
  folderId: string
  mode: "cascade" | "reparent"
} {
  if (typeof payload.cascade !== "boolean") {
    throw new FilesRemoteRequestError("cascade must be a boolean")
  }
  return { folderId: parseFolderId(payload), mode: payload.cascade ? "cascade" : "reparent" }
}

export function parseUploadInitRequest(payload: Record<string, unknown>): {
  name: string
  mediaType: string
  size: number
  hash: string
} {
  const hash = boundedString(payload, "hash", 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new FilesRemoteRequestError("hash must be SHA-256 hex")
  return {
    name: parseName(payload),
    mediaType: boundedString(payload, "mediaType", 255),
    size: requiredInteger(payload, "size", 1, FILES_REMOTE_MAX_BYTES),
    hash,
  }
}

export function parseUploadId(payload: Record<string, unknown>): string {
  return boundedString(payload, "uploadId", 128)
}

export function parseUploadChunkRequest(payload: Record<string, unknown>): {
  uploadId: string
  offset: number
  dataBase64: string
} {
  const dataBase64 = payload.dataBase64
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
    throw new FilesRemoteRequestError("dataBase64 must be a non-empty string")
  }
  return {
    uploadId: parseUploadId(payload),
    offset: requiredInteger(payload, "offset", 0, FILES_REMOTE_MAX_BYTES),
    dataBase64,
  }
}

export function parseReadChunkRequest(payload: Record<string, unknown>): {
  key: string
  offset: number
  length: number
} {
  return {
    key: parseKey(payload),
    offset: requiredInteger(payload, "offset", 0, FILES_REMOTE_MAX_BYTES),
    length: boundedInteger(
      payload,
      "length",
      1,
      FILES_REMOTE_READ_CHUNK_MAX,
      FILES_REMOTE_READ_CHUNK_MAX
    ),
  }
}

export function parseUploadCommitRequest(payload: Record<string, unknown>): {
  uploadId: string
  folderId?: string
  projectId?: string
} {
  const folderId = optionalBoundedString(payload, "folderId", FILES_REMOTE_KEY_MAX)
  const projectId = optionalBoundedString(payload, "projectId", FILES_REMOTE_KEY_MAX)
  return {
    uploadId: parseUploadId(payload),
    ...(folderId ? { folderId } : {}),
    ...(projectId ? { projectId } : {}),
  }
}

// ── Device side ──────────────────────────────────────────────────────────────

/**
 * The entry a paired device works with: the wire entry plus the haystack its
 * own search reads — titles and media type. Body text is matched on the host.
 */
export function entryFromRemote(remote: FilesRemoteEntry): FilesEntry {
  const searchText = [
    remote.title,
    remote.sourceTitle,
    remote.mediaType ?? "",
    // A workspace file is found by its path too, as it is on the host.
    remote.workspace?.relPath ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
  return { ...remote, searchText }
}

/** The wire entry for an aggregate entry (host side). */
export function entryToRemote(entry: FilesEntry): FilesRemoteEntry {
  // Destructured out, not deleted: the aggregate's object is shared.
  const { searchText: _searchText, excerpt: _excerpt, ...remote } = entry
  return remote
}

/** Structural check on what the host answered a list page with. */
export function isFilesRemoteListPage(value: unknown): value is { ok: true } & FilesRemoteListPage {
  if (typeof value !== "object" || value === null) return false
  const page = value as Partial<FilesRemoteListPage> & { ok?: unknown }
  return (
    page.ok === true &&
    Array.isArray(page.items) &&
    typeof page.imagesTruncated === "boolean" &&
    typeof page.revision === "string" &&
    page.items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as FilesRemoteEntry).key === "string" &&
        typeof (item as FilesRemoteEntry).kind === "string"
    )
  )
}
