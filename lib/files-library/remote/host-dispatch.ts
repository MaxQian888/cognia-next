// Host-side arms for the Files library on a paired device (ADR-0223 §9).
//
// A paired phone manages the DESKTOP's library. Its `files_library_*` calls
// reach the companion server, ride the generic desktop-writes bridge
// (`crates/cognia-companion-rpc/src/rpc/data_sync.rs`) to this renderer, and are
// delegated here by `lib/companion/desktop-write-source.ts`, the way the
// `pet_*` family is. Every change goes through the code the desktop's own
// page uses — `lib/db/files-library-*`, rename, duplicate, the Trash purge
// rule, the upload pipeline — so the library moves once, in the one place
// that owns it.
//
// The host never takes the device's word for an entry. A call names keys; the
// host rebuilds its own aggregate and acts on the entries it finds there, so a
// phone can neither claim an item is Files-owned (and get it deleted for good)
// nor reach a source its library never listed. Unknown keys are skipped, the
// same way a selection that went stale on the desktop is.
//
// Two hosts install the desktop-write source, and the bridge prefers a
// connected headless brain. The brain serves no Files page, so every arm
// answers `headless_host` there instead of reading a library nobody manages.

import type { Platform } from "@/lib/platform/detect"
import { detectPlatform } from "@/lib/platform/detect"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import {
  restoreLibraryItems,
  setLibraryItemsFavorite,
  setLibraryItemsFolder,
  touchLibraryItemOpened,
  trashLibraryItems,
} from "@/lib/db/files-library-items"
import {
  createLibraryFolder,
  deleteLibraryFolder,
  listLibraryFolders,
  moveLibraryFolder,
  renameLibraryFolder,
  setLibraryFolderStyle,
} from "@/lib/db/files-library-folders"
import { libraryItemKey, ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"
import { LIBRARY_REF_SESSION_ID } from "@/lib/db/message-media-refs"
import {
  abortAttachmentUpload,
  appendAttachmentChunk,
  beginAttachmentUpload,
  commitAttachmentUpload,
  consumeAttachmentRefs,
  resolveAttachmentRef,
} from "@/lib/db/session-attachment-uploads"
import { createSession, getSession } from "@/lib/db/sessions"
import { getDb } from "@/lib/db/schema"
import { sha256Hex } from "@/lib/share/hash"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { aggregateFilesEntries } from "../aggregate"
import { documentDraftOf } from "../document-draft"
import { duplicateFilesEntry } from "../duplicate"
import { matchesSearch } from "../filter"
import { renameFilesEntry } from "../rename"
import { FILES_IMAGE_PAGE_SIZE, loadFilesSources } from "../sources"
import {
  hasLocalWorkspaceFiles,
  loadWorkspaceFileIndex,
  readWorkspaceFileSlice,
} from "../workspace-files-io"
import { purgeTrashedItems } from "../trash"
import { entrySource, type FilesEntry } from "../types"
import { uploadFileToLibrary } from "../upload"
import { bindEntryToSession } from "../use-in-chat"
import { FILES_REMOTE_COMMANDS, isFilesRemoteCommand } from "./commands"
import { createFilesIdempotencyLedger, type FilesIdempotencyLedger } from "./idempotency"
import {
  bytesToBase64,
  encodePageToken,
  entryToRemote,
  FILES_REMOTE_MAX_BYTES,
  FILES_REMOTE_TEXT_MAX,
  FilesRemoteRequestError,
  parseAttachRequest,
  parseCallerDeviceId,
  parseDuplicateRequest,
  parseFavoriteRequest,
  parseFolderDeleteRequest,
  parseFolderId,
  parseFolderStyleRequest,
  parseIdempotencyKey,
  parseImageLimit,
  parseKey,
  parseKeys,
  parseListRequest,
  parsePageRequest,
  parseMoveRequest,
  parseName,
  parseReadChunkRequest,
  parseRenameRequest,
  parseSearchRequest,
  parseUploadChunkRequest,
  parseUploadCommitRequest,
  parseUploadId,
  parseUploadInitRequest,
  refused,
  type FilesRemoteAttach,
  type FilesRemoteReadChunk,
  type FilesRemoteDetail,
  type FilesRemoteDuplicate,
  type FilesRemoteFolders,
  type FilesRemoteListPage,
  type FilesRemotePurge,
  type FilesRemoteRefused,
  type FilesRemoteResult,
  type FilesRemoteSearch,
  type FilesRemoteUploadChunk,
  type FilesRemoteUploadCommit,
  type FilesRemoteUploadInit,
} from "./types"

/** The library as the host sees it right now. */
export interface FilesHostLibrary {
  entries: FilesEntry[]
  imagesTruncated: boolean
}

export interface FilesHostDispatchDeps {
  platform?: Platform
  loadLibrary?: (imageLimit: number) => Promise<FilesHostLibrary>
  ledger?: FilesIdempotencyLedger
  /** The text of an artifact or canvas document, or null when it is gone. */
  readDocumentText?: (entry: FilesEntry) => string | null
}

async function loadHostLibrary(imageLimit: number): Promise<FilesHostLibrary> {
  const { artifacts, canvasDocuments } = useArtifactStore.getState()
  // The host's own workspace files go to the paired device too (§8).
  const workspace = hasLocalWorkspaceFiles() ? { index: await loadWorkspaceFileIndex() } : null
  const loaded = await loadFilesSources({
    artifacts,
    canvasDocuments,
    imageLimit,
    ...(workspace ? { workspace } : {}),
  })
  return {
    entries: aggregateFilesEntries(loaded.input),
    imagesTruncated: loaded.imagesTruncated,
  }
}

function readHostDocumentText(entry: FilesEntry): string | null {
  return documentDraftOf(entry, useArtifactStore.getState())?.content ?? null
}

let sharedLedger: FilesIdempotencyLedger | null = null

function hostLedger(): FilesIdempotencyLedger {
  if (!sharedLedger) sharedLedger = createFilesIdempotencyLedger()
  return sharedLedger
}

/** Test helper: drop the process-wide ledger. */
export function __resetFilesHostLedgerForTesting(): void {
  sharedLedger = null
}

interface Resolved {
  loadLibrary: (imageLimit: number) => Promise<FilesHostLibrary>
  ledger: FilesIdempotencyLedger
  readDocumentText: (entry: FilesEntry) => string | null
}

/** The entries the keys name, in the order given; keys the host lacks are dropped. */
async function resolveEntries(
  d: Resolved,
  payload: Record<string, unknown>,
  keys: readonly string[]
): Promise<FilesEntry[]> {
  const { entries } = await d.loadLibrary(parseImageLimit(payload, FILES_IMAGE_PAGE_SIZE))
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  return keys.flatMap((key) => {
    const entry = byKey.get(key)
    return entry ? [entry] : []
  })
}

async function resolveEntry(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesEntry | undefined> {
  const [entry] = await resolveEntries(d, payload, [parseKey(payload)])
  return entry
}

/**
 * Fingerprint of everything a device renders from the list, so a page cut
 * from a library that changed mid-read is detected rather than stitched.
 */
async function revisionOf(entries: readonly FilesEntry[]): Promise<string> {
  const parts = entries.map((entry) =>
    [
      entry.key,
      entry.updatedAt,
      entry.title,
      entry.favoritedAt ?? "",
      entry.folderId ?? "",
      entry.trashedAt ?? "",
      entry.hidden ? 1 : 0,
      entry.sharedLinks ?? 0,
      entry.lastAccessedAt ?? "",
    ].join("|")
  )
  return (await sha256Hex(parts.join("\n"))).slice(0, 32)
}

async function list(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteListPage>> {
  const request = parseListRequest(payload, FILES_IMAGE_PAGE_SIZE)
  const library = await d.loadLibrary(request.imageLimit)
  // Key order is stable across calls; the device sorts for display itself.
  const ordered = [...library.entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const page = ordered.slice(request.offset, request.offset + request.pageSize)
  const next = request.offset + page.length
  return {
    ok: true,
    items: page.map(entryToRemote),
    imagesTruncated: library.imagesTruncated,
    revision: await revisionOf(ordered),
    ...(next < ordered.length ? { nextPageToken: encodePageToken(next) } : {}),
  }
}

async function search(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteSearch>> {
  const { query, limit } = parseSearchRequest(payload)
  const { entries } = await d.loadLibrary(parseImageLimit(payload, FILES_IMAGE_PAGE_SIZE))
  // The same rule as the page: trashed and removed items are not found.
  const hits = entries
    .filter((entry) => entry.trashedAt === undefined && !entry.hidden)
    .filter((entry) => matchesSearch(entry, query))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1))
    .slice(0, limit)
  return {
    ok: true,
    items: hits.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      title: entry.title,
      ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
      updatedAt: entry.updatedAt,
      projectIds: entry.projectIds,
    })),
  }
}

/**
 * One slice of a workspace file, read off the host's disk where the file is
 * now (ADR-0223 §8). Only for a workspace file the host itself lists, so the
 * device never names a path; only under the paired ceiling, so a preview is
 * refused up front rather than streamed past what the device would show.
 */
async function readChunk(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteReadChunk>> {
  const request = parseReadChunkRequest(payload)
  const entry = await resolveEntry(d, payload)
  if (!entry) return refused("files_remote_not_found")
  if (entry.kind !== "workspace-file" || !entry.workspace) {
    return refused("files_remote_invalid_request")
  }
  const slice = await readWorkspaceFileSlice(entry.workspace, request.offset, request.length)
  if (slice.size > FILES_REMOTE_MAX_BYTES) return refused("files_remote_too_large")
  return {
    ok: true,
    dataBase64: bytesToBase64(slice.bytes),
    size: slice.size,
    eof: slice.eof,
  }
}

async function get(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteDetail>> {
  const entry = await resolveEntry(d, payload)
  if (!entry) return refused("files_remote_not_found")
  if (entry.kind !== "artifact" && entry.kind !== "canvas") {
    return { ok: true, entry: entryToRemote(entry) }
  }
  const text = d.readDocumentText(entry)
  if (text === null) return { ok: true, entry: entryToRemote(entry) }
  const truncated = text.length > FILES_REMOTE_TEXT_MAX
  return {
    ok: true,
    entry: entryToRemote(entry),
    text: truncated ? text.slice(0, FILES_REMOTE_TEXT_MAX) : text,
    ...(truncated ? { textTruncated: true } : {}),
  }
}

async function favorite(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<{ count: number }>> {
  const request = parseFavoriteRequest(payload)
  const entries = await resolveEntries(d, payload, request.keys)
  if (entries.length > 0) await setLibraryItemsFavorite(entries.map(entrySource), request.favorite)
  return { ok: true, count: entries.length }
}

async function move(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<{ count: number }>> {
  const request = parseMoveRequest(payload)
  const entries = await resolveEntries(d, payload, request.keys)
  if (entries.length > 0) await setLibraryItemsFolder(entries.map(entrySource), request.folderId)
  return { ok: true, count: entries.length }
}

async function trash(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<{ count: number }>> {
  const entries = (await resolveEntries(d, payload, parseKeys(payload))).filter(
    (entry) => entry.trashedAt === undefined
  )
  if (entries.length > 0) await trashLibraryItems(entries.map(entrySource))
  return { ok: true, count: entries.length }
}

async function restore(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<{ count: number }>> {
  const entries = (await resolveEntries(d, payload, parseKeys(payload))).filter(
    (entry) => entry.trashedAt !== undefined
  )
  if (entries.length > 0) {
    await restoreLibraryItems(
      entries.map((entry) => ({ ...entrySource(entry), originAlive: entry.originAlive }))
    )
  }
  return { ok: true, count: entries.length }
}

async function purge(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemotePurge & { count: number }>> {
  // Only what is in the Trash ends for good, whatever the device asked for.
  const entries = (await resolveEntries(d, payload, parseKeys(payload))).filter(
    (entry) => entry.trashedAt !== undefined
  )
  if (entries.length === 0) return { ok: true, retired: 0, count: 0 }
  const outcome = await purgeTrashedItems(
    entries.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      sourceId: entry.sourceId,
      ownedByFiles: entry.ownedByFiles,
      originAlive: entry.originAlive,
    }))
  )
  return { ok: true, retired: outcome.retired, count: entries.length }
}

async function touch(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<object>> {
  const entry = await resolveEntry(d, payload)
  if (!entry) return refused("files_remote_not_found")
  await touchLibraryItemOpened(entrySource(entry))
  return { ok: true }
}

async function rename(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<{ name: string }>> {
  const request = parseRenameRequest(payload)
  const entry = await resolveEntry(d, payload)
  if (!entry) return refused("files_remote_not_found")
  await renameFilesEntry(entry, request.name)
  return { ok: true, name: request.name.trim() }
}

async function duplicate(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteDuplicate>> {
  const request = parseDuplicateRequest(payload)
  const entry = await resolveEntry(d, payload)
  if (!entry) return refused("files_remote_not_found")
  const result = await duplicateFilesEntry(entry, {
    suffix: request.suffix,
    fallbackName: request.fallbackName,
    ...(request.projectId ? { projectId: request.projectId } : {}),
  })
  return result.kind === "canvas"
    ? { ok: true, kind: "canvas", key: libraryItemKey("canvas", result.id) }
    : { ok: true, kind: "upload", key: result.key }
}

/**
 * "Use in chat" from a paired device. The conversation is the one the device
 * names when it still takes messages, otherwise a new one titled for the
 * item. An image or file is bound to it here, as a conversation asset — the
 * device's composer is not this host's, so a draft attachment would never
 * reach it. An artifact or canvas document binds nothing: the device stages
 * it as a chip in its own composer, from `files_library_get`.
 */
async function attach(
  d: Resolved,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteAttach>> {
  const request = parseAttachRequest(payload)
  const entry = await resolveEntry(d, payload)
  if (!entry) return refused("files_remote_not_found")
  let sessionId: string | undefined
  let created = false
  if (request.sessionId) {
    const session = await getSession(request.sessionId)
    if (session && isSessionExposed(session, "external-connector")) {
      try {
        assertSessionWritable(session, "send-message")
        sessionId = session.id
      } catch {
        return refused("files_remote_session_unwritable")
      }
    }
  }
  if (!sessionId) {
    sessionId = (await createSession({ title: request.title })).id
    created = true
  }
  if (entry.kind === "artifact" || entry.kind === "canvas") {
    return { ok: true, sessionId, created, how: "referenced" }
  }
  await bindEntryToSession(entry, sessionId)
  return { ok: true, sessionId, created, how: "bound" }
}

async function folderList(
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteFolders>> {
  const request = parsePageRequest(payload)
  const ordered = [...(await listLibraryFolders())].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  const page = ordered.slice(request.offset, request.offset + request.pageSize)
  const next = request.offset + page.length
  return {
    ok: true,
    folders: page,
    ...(next < ordered.length ? { nextPageToken: encodePageToken(next) } : {}),
  }
}

async function folderCreate(
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<{ folderId: string }>> {
  const name = parseName(payload).trim()
  const parentFolderId =
    payload.parentId === undefined || payload.parentId === null
      ? ROOT_LIBRARY_FOLDER_ID
      : parseFolderId(payload, "parentId")
  const folder = await createLibraryFolder({ name, parentFolderId })
  return { ok: true, folderId: folder.id }
}

async function folderRename(payload: Record<string, unknown>): Promise<FilesRemoteResult<object>> {
  await renameLibraryFolder(parseFolderId(payload), parseName(payload).trim())
  return { ok: true }
}

async function folderMove(payload: Record<string, unknown>): Promise<FilesRemoteResult<object>> {
  await moveLibraryFolder(parseFolderId(payload), parseFolderId(payload, "parentId"))
  return { ok: true }
}

async function folderStyle(payload: Record<string, unknown>): Promise<FilesRemoteResult<object>> {
  const { folderId, style } = parseFolderStyleRequest(payload)
  await setLibraryFolderStyle(folderId, style)
  return { ok: true }
}

async function folderDelete(payload: Record<string, unknown>): Promise<FilesRemoteResult<object>> {
  const { folderId, mode } = parseFolderDeleteRequest(payload)
  await deleteLibraryFolder(folderId, mode)
  return { ok: true }
}

/**
 * Uploads stage in the session attachment table under the library's sentinel
 * session, so they get its resume, its device binding, its hash and magic-byte
 * checks and its collector. The sentinel never names a real conversation, so a
 * staged library file can never be sent as a message attachment.
 */
async function uploadInit(
  callerDeviceId: string,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteUploadInit>> {
  const request = parseUploadInitRequest(payload)
  const result = await beginAttachmentUpload({
    sessionId: LIBRARY_REF_SESSION_ID,
    deviceId: callerDeviceId,
    name: request.name,
    mediaType: request.mediaType,
    size: request.size,
    hash: request.hash,
    maxBytes: FILES_REMOTE_MAX_BYTES,
    acceptAnyType: true,
  })
  return {
    ok: true,
    uploadId: result.uploadId,
    chunkSize: result.chunkSize,
    resumeOffset: result.resumeOffset,
    complete: result.complete,
  }
}

/** The staged row, only when it is this device's library upload. */
async function ownLibraryUpload(uploadId: string, callerDeviceId: string): Promise<boolean> {
  const row = await getDb().sessionAttachmentUploads.get(uploadId)
  return (
    row !== undefined && row.deviceId === callerDeviceId && row.sessionId === LIBRARY_REF_SESSION_ID
  )
}

function decodeBase64(raw: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw new FilesRemoteRequestError("dataBase64 is not valid base64")
  }
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function uploadChunk(
  callerDeviceId: string,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteUploadChunk>> {
  const request = parseUploadChunkRequest(payload)
  if (!(await ownLibraryUpload(request.uploadId, callerDeviceId))) {
    return refused("files_remote_not_found")
  }
  const result = await appendAttachmentChunk({
    uploadId: request.uploadId,
    deviceId: callerDeviceId,
    offset: request.offset,
    bytes: decodeBase64(request.dataBase64),
  })
  return { ok: true, ...result }
}

async function uploadCommit(
  callerDeviceId: string,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<FilesRemoteUploadCommit>> {
  const request = parseUploadCommitRequest(payload)
  if (!(await ownLibraryUpload(request.uploadId, callerDeviceId))) {
    return refused("files_remote_not_found")
  }
  const committed = await commitAttachmentUpload({
    uploadId: request.uploadId,
    deviceId: callerDeviceId,
  })
  const staged = await resolveAttachmentRef(committed.ref, {
    sessionId: LIBRARY_REF_SESSION_ID,
    deviceId: callerDeviceId,
  })
  if (!staged?.bytes) return refused("files_remote_not_found")
  // Copied into a fresh buffer: the stored view may sit on a shared one.
  const file = new File([new Uint8Array(staged.bytes)], committed.name, {
    type: committed.mediaType,
  })
  const uploaded = await uploadFileToLibrary(file, {
    ...(request.projectId ? { projectId: request.projectId } : {}),
    ...(request.folderId ? { folderId: request.folderId } : {}),
  })
  // The library holds the bytes now; the staging copy is spent.
  await consumeAttachmentRefs([committed.ref])
  return { ok: true, key: uploaded.key }
}

async function uploadAbort(
  callerDeviceId: string,
  payload: Record<string, unknown>
): Promise<FilesRemoteResult<object>> {
  const uploadId = parseUploadId(payload)
  if (await ownLibraryUpload(uploadId, callerDeviceId)) {
    await abortAttachmentUpload({ uploadId, deviceId: callerDeviceId })
  }
  return { ok: true }
}

/** Host write errors carry their `files.errors.*` code; pass it through. */
function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code) ? code : null
}

export async function dispatchFilesHostCommand(
  command: string,
  payload: Record<string, unknown>,
  deps: FilesHostDispatchDeps = {}
): Promise<unknown> {
  if (!isFilesRemoteCommand(command)) throw new Error(`unsupported files command: ${command}`)
  if ((deps.platform ?? detectPlatform()) !== "tauri") return refused("headless_host")
  const d: Resolved = {
    loadLibrary: deps.loadLibrary ?? loadHostLibrary,
    ledger: deps.ledger ?? hostLedger(),
    readDocumentText: deps.readDocumentText ?? readHostDocumentText,
  }
  let callerDeviceId: string
  try {
    callerDeviceId = parseCallerDeviceId(payload)
  } catch {
    return refused("files_remote_invalid_request")
  }
  const keyed = <T>(run: () => Promise<T>): Promise<T> =>
    d.ledger.run(callerDeviceId, `${command}:${parseIdempotencyKey(payload)}`, run)

  try {
    switch (command) {
      case FILES_REMOTE_COMMANDS.list:
        return await list(d, payload)
      case FILES_REMOTE_COMMANDS.folderList:
        return await folderList(payload)
      case FILES_REMOTE_COMMANDS.search:
        return await search(d, payload)
      case FILES_REMOTE_COMMANDS.get:
        return await get(d, payload)
      case FILES_REMOTE_COMMANDS.readChunk:
        return await readChunk(d, payload)
      case FILES_REMOTE_COMMANDS.favorite:
        return await favorite(d, payload)
      case FILES_REMOTE_COMMANDS.move:
        return await move(d, payload)
      case FILES_REMOTE_COMMANDS.trash:
        return await trash(d, payload)
      case FILES_REMOTE_COMMANDS.restore:
        return await restore(d, payload)
      case FILES_REMOTE_COMMANDS.purge:
        return await purge(d, payload)
      case FILES_REMOTE_COMMANDS.touch:
        return await touch(d, payload)
      case FILES_REMOTE_COMMANDS.rename:
        return await rename(d, payload)
      case FILES_REMOTE_COMMANDS.duplicate:
        return await keyed(() => duplicate(d, payload))
      case FILES_REMOTE_COMMANDS.attach:
        return await keyed(() => attach(d, payload))
      case FILES_REMOTE_COMMANDS.folderCreate:
        return await keyed(() => folderCreate(payload))
      case FILES_REMOTE_COMMANDS.folderRename:
        return await folderRename(payload)
      case FILES_REMOTE_COMMANDS.folderMove:
        return await folderMove(payload)
      case FILES_REMOTE_COMMANDS.folderStyle:
        return await folderStyle(payload)
      case FILES_REMOTE_COMMANDS.folderDelete:
        return await folderDelete(payload)
      case FILES_REMOTE_COMMANDS.uploadInit:
        return await uploadInit(callerDeviceId, payload)
      case FILES_REMOTE_COMMANDS.uploadChunk:
        return await uploadChunk(callerDeviceId, payload)
      case FILES_REMOTE_COMMANDS.uploadCommit:
        return await keyed(() => uploadCommit(callerDeviceId, payload))
      case FILES_REMOTE_COMMANDS.uploadAbort:
        return await uploadAbort(callerDeviceId, payload)
    }
  } catch (error) {
    if (error instanceof FilesRemoteRequestError) return refused("files_remote_invalid_request")
    const code = codeOf(error)
    if (code) return refused(code)
    throw error
  }
}

export type { FilesRemoteRefused }
