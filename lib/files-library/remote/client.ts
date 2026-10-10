// The paired device's typed calls for the host's Files library (ADR-0223 §9).
//
// Every call goes straight over the companion transport, live. None is part
// of `MOBILE_OUTBOUND_COMMANDS`, on purpose: a move or a Trash replayed later
// would act on a library that has moved on. A call that cannot reach the host
// fails, and the page says so.
//
// Writes send a UUID `idempotencyKey` transport option (the companion
// server's own header ledger); the four that would otherwise make a second
// copy also send it in the body, where the host's per-device ledger folds a
// retry over another channel onto the first answer.
//
// Bytes do not travel as JSON. Previews, thumbnails and downloads read the
// existing `session-media` binary resource: an item Files keeps is pinned
// under the library's sentinel session (`library:files`), anything else is
// read through a conversation that shows it. The host checks the pin or the
// conversation on every read (`lib/companion/desktop-message-source.ts`).

import type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
} from "@/lib/db/files-library-types"
import { isLibraryItemKept } from "@/lib/db/files-library-types"
import { LIBRARY_REF_SESSION_ID } from "@/lib/db/message-media-refs"
import { sha256Bytes } from "@/lib/ocr/hash"
import type {
  Transport,
  TransportBinaryResource,
  TransportBinaryResponse,
} from "@/lib/tauri/transport-types"
import type { FilesEntry } from "../types"
import { FILES_REMOTE_COMMANDS } from "./commands"
import {
  base64ToBytes,
  bytesToBase64,
  entryFromRemote,
  FILES_REMOTE_MAX_BYTES,
  FILES_REMOTE_READ_CHUNK_MAX,
  FILES_REMOTE_PAGE_SIZE_DEFAULT,
  isFilesRemoteListPage,
  isRefused,
  type FilesRemoteAttach,
  type FilesRemoteDetail,
  type FilesRemoteDuplicate,
  type FilesRemoteErrorCode,
  type FilesRemoteFolders,
  type FilesRemotePurge,
  type FilesRemoteReadChunk,
  type FilesRemoteSearch,
  type FilesRemoteSearchHit,
  type FilesRemoteUploadChunk,
  type FilesRemoteUploadCommit,
  type FilesRemoteUploadInit,
} from "./types"

/** A refusal the host answered with, or one this client raised itself. */
export class FilesRemoteError extends Error {
  constructor(readonly code: FilesRemoteErrorCode) {
    super(code)
    this.name = "FilesRemoteError"
  }
}

/** A fresh key for one user intent. Reuse it only to retry that same intent. */
export function newFilesIntentKey(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID()
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new Error("no secure random source for a Files intent key")
}

/** How many times a list read starts over when the library changes mid-read. */
const LIST_ATTEMPTS = 3

export type FilesMediaVariant = "thumbnail" | "canonical" | "original"

/**
 * The binary reads that may answer for an entry's bytes, in the order to try
 * them: the library's pin first when Files keeps the item, then each
 * conversation that shows it. Null when the entry has no stored bytes
 * (artifacts and canvas documents are text, read through `get`).
 */
export function mediaResourcesFor(
  entry: Pick<
    FilesEntry,
    | "kind"
    | "sourceId"
    | "mediaHash"
    | "sessionIds"
    | "favoritedAt"
    | "folderId"
    | "ownedByFiles"
    | "trashedAt"
  >,
  variant: FilesMediaVariant
): TransportBinaryResource[] | null {
  const key = entry.kind === "image" ? entry.sourceId : entry.mediaHash
  if (!key) return null
  // A held original (`original:<sha>`) only has an original variant.
  const held = key.startsWith("original:")
  const hash = held ? key.slice("original:".length) : key
  if (!/^[a-f0-9]{64}$/.test(hash)) return null
  const kept = isLibraryItemKept({
    favoritedAt: entry.favoritedAt,
    folderId: entry.folderId,
    // The row type spells "owned" as `true | undefined`.
    ...(entry.ownedByFiles ? { ownedByFiles: true as const } : {}),
    trashedAt: entry.trashedAt,
  })
  const sessions = [...(kept ? [LIBRARY_REF_SESSION_ID] : []), ...entry.sessionIds]
  return sessions.map((sessionId) => ({
    kind: "session-media",
    sessionId,
    hash,
    variant: held ? "original" : variant,
  }))
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : ""
}

export interface FilesRemoteLibrary {
  entries: FilesEntry[]
  imagesTruncated: boolean
}

export interface FilesRemoteUploadProgress {
  uploadedBytes: number
  totalBytes: number
}

export interface FilesRemoteClient {
  /** Every entry the host lists, read page by page. */
  list(imageLimit: number): Promise<FilesRemoteLibrary>
  folders(): Promise<LibraryFolder[]>
  search(query: string, imageLimit: number, limit?: number): Promise<FilesRemoteSearchHit[]>
  get(key: string, imageLimit: number): Promise<FilesRemoteDetail>
  favorite(keys: readonly string[], favorite: boolean, imageLimit: number): Promise<void>
  move(keys: readonly string[], folderId: string | null, imageLimit: number): Promise<void>
  trash(keys: readonly string[], imageLimit: number): Promise<void>
  restore(keys: readonly string[], imageLimit: number): Promise<void>
  purge(keys: readonly string[], imageLimit: number): Promise<FilesRemotePurge>
  touch(key: string, imageLimit: number): Promise<void>
  rename(key: string, name: string, imageLimit: number): Promise<void>
  duplicate(
    key: string,
    opts: { suffix: string; fallbackName: string; projectId?: string; imageLimit: number }
  ): Promise<FilesRemoteDuplicate>
  attach(
    key: string,
    opts: { sessionId?: string; title: string; imageLimit: number }
  ): Promise<FilesRemoteAttach>
  createFolder(name: string, parentId: string): Promise<string>
  renameFolder(folderId: string, name: string): Promise<void>
  moveFolder(folderId: string, parentId: string): Promise<void>
  setFolderStyle(
    folderId: string,
    style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null }
  ): Promise<void>
  deleteFolder(folderId: string, cascade: boolean): Promise<void>
  /** Upload one file (at most `FILES_REMOTE_MAX_BYTES`) into the host's library. */
  upload(
    file: File,
    opts: {
      folderId?: string
      projectId?: string
      onProgress?: (p: FilesRemoteUploadProgress) => void
    }
  ): Promise<string>
  /** The entry's stored bytes, through the first resource that answers. */
  readMedia(entry: FilesEntry, variant: FilesMediaVariant): Promise<TransportBinaryResponse>
  /**
   * A workspace file's bytes off the host's disk, a slice at a time (ADR-0223
   * §8), at most `FILES_REMOTE_MAX_BYTES`. Starts over once if the file
   * changes size mid-read.
   */
  readWorkspaceFile(entry: FilesEntry, imageLimit: number): Promise<Uint8Array<ArrayBuffer>>
}

/**
 * Bind the calls to a transport. Callers pass the companion transport the
 * shell routes through (`live-transport.ts`); tests pass a stub.
 */
export function createFilesRemoteClient(
  transport: Pick<Transport, "call" | "readBinary">,
  deps: { newKey?: () => string } = {}
): FilesRemoteClient {
  const newKey = deps.newKey ?? newFilesIntentKey

  const unwrap = <T>(value: unknown): T => {
    if (isRefused(value)) throw new FilesRemoteError(value.code)
    return value as T
  }
  const read = async <T>(command: string, args: Record<string, unknown>): Promise<T> =>
    unwrap<T>(await transport.call<unknown>(command, args))
  const write = async <T>(
    command: string,
    args: Record<string, unknown>,
    opts: { bodyKey?: boolean } = {}
  ): Promise<T> => {
    const key = newKey()
    return unwrap<T>(
      await transport.call<unknown>(
        command,
        opts.bodyKey ? { ...args, idempotencyKey: key } : args,
        { idempotencyKey: key }
      )
    )
  }

  return {
    async list(imageLimit) {
      for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt++) {
        const items: FilesEntry[] = []
        let revision: string | undefined
        let imagesTruncated = false
        let pageToken: string | undefined
        let changed = false
        do {
          const page = await transport.call<unknown>(FILES_REMOTE_COMMANDS.list, {
            imageLimit,
            pageSize: FILES_REMOTE_PAGE_SIZE_DEFAULT,
            ...(pageToken ? { pageToken } : {}),
          })
          if (isRefused(page)) throw new FilesRemoteError(page.code)
          if (!isFilesRemoteListPage(page))
            throw new FilesRemoteError("files_remote_invalid_answer")
          if (revision !== undefined && page.revision !== revision) {
            changed = true
            break
          }
          revision = page.revision
          imagesTruncated = page.imagesTruncated
          items.push(...page.items.map(entryFromRemote))
          pageToken = page.nextPageToken
        } while (pageToken)
        if (!changed) {
          const seen = new Set<string>()
          return {
            entries: items.filter((entry) => !seen.has(entry.key) && Boolean(seen.add(entry.key))),
            imagesTruncated,
          }
        }
      }
      throw new FilesRemoteError("files_remote_busy")
    },
    async folders() {
      const byId = new Map<string, LibraryFolder>()
      let pageToken: string | undefined
      do {
        const page = await read<FilesRemoteFolders>(FILES_REMOTE_COMMANDS.folderList, {
          pageSize: FILES_REMOTE_PAGE_SIZE_DEFAULT,
          ...(pageToken ? { pageToken } : {}),
        })
        for (const folder of page.folders) byId.set(folder.id, folder)
        pageToken = page.nextPageToken
      } while (pageToken)
      return [...byId.values()]
    },
    async search(query, imageLimit, limit = 50) {
      return (
        await read<FilesRemoteSearch>(FILES_REMOTE_COMMANDS.search, { query, imageLimit, limit })
      ).items
    },
    get(key, imageLimit) {
      return read<FilesRemoteDetail>(FILES_REMOTE_COMMANDS.get, { key, imageLimit })
    },
    async favorite(keys, favorite, imageLimit) {
      await write(FILES_REMOTE_COMMANDS.favorite, { keys, favorite, imageLimit })
    },
    async move(keys, folderId, imageLimit) {
      await write(FILES_REMOTE_COMMANDS.move, { keys, folderId, imageLimit })
    },
    async trash(keys, imageLimit) {
      await write(FILES_REMOTE_COMMANDS.trash, { keys, imageLimit })
    },
    async restore(keys, imageLimit) {
      await write(FILES_REMOTE_COMMANDS.restore, { keys, imageLimit })
    },
    purge(keys, imageLimit) {
      return write<FilesRemotePurge>(FILES_REMOTE_COMMANDS.purge, { keys, imageLimit })
    },
    async touch(key, imageLimit) {
      await write(FILES_REMOTE_COMMANDS.touch, { key, imageLimit })
    },
    async rename(key, name, imageLimit) {
      await write(FILES_REMOTE_COMMANDS.rename, { key, name, imageLimit })
    },
    duplicate(key, opts) {
      return write<FilesRemoteDuplicate>(
        FILES_REMOTE_COMMANDS.duplicate,
        {
          key,
          suffix: opts.suffix,
          fallbackName: opts.fallbackName,
          imageLimit: opts.imageLimit,
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
        },
        { bodyKey: true }
      )
    },
    attach(key, opts) {
      return write<FilesRemoteAttach>(
        FILES_REMOTE_COMMANDS.attach,
        {
          key,
          title: opts.title,
          imageLimit: opts.imageLimit,
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        },
        { bodyKey: true }
      )
    },
    async createFolder(name, parentId) {
      return (
        await write<{ folderId: string }>(
          FILES_REMOTE_COMMANDS.folderCreate,
          { name, parentId },
          { bodyKey: true }
        )
      ).folderId
    },
    async renameFolder(folderId, name) {
      await write(FILES_REMOTE_COMMANDS.folderRename, { folderId, name })
    },
    async moveFolder(folderId, parentId) {
      await write(FILES_REMOTE_COMMANDS.folderMove, { folderId, parentId })
    },
    async setFolderStyle(folderId, style) {
      await write(FILES_REMOTE_COMMANDS.folderStyle, { folderId, ...style })
    },
    async deleteFolder(folderId, cascade) {
      await write(FILES_REMOTE_COMMANDS.folderDelete, { folderId, cascade })
    },
    async upload(file, opts) {
      if (file.size > FILES_REMOTE_MAX_BYTES) throw new FilesRemoteError("files_remote_too_large")
      const bytes = new Uint8Array(await file.arrayBuffer())
      const hash = await sha256Bytes(bytes)
      const total = bytes.byteLength
      const init = await write<FilesRemoteUploadInit>(FILES_REMOTE_COMMANDS.uploadInit, {
        name: file.name || "file",
        mediaType: file.type || "application/octet-stream",
        size: total,
        hash,
      })
      try {
        const chunkSize = init.chunkSize > 0 ? init.chunkSize : 32 * 1024
        let offset = init.complete ? total : Math.min(Math.max(init.resumeOffset, 0), total)
        opts.onProgress?.({ uploadedBytes: offset, totalBytes: total })
        while (offset < total) {
          const end = Math.min(offset + chunkSize, total)
          const chunk = await write<FilesRemoteUploadChunk>(FILES_REMOTE_COMMANDS.uploadChunk, {
            uploadId: init.uploadId,
            offset,
            dataBase64: bytesToBase64(bytes.subarray(offset, end)),
          })
          // Follow the host's write head: it knows what it kept.
          const confirmed = Number.isFinite(chunk.receivedBytes) ? chunk.receivedBytes : end
          offset = Math.min(Math.max(confirmed, end), total)
          opts.onProgress?.({ uploadedBytes: offset, totalBytes: total })
        }
        const committed = await write<FilesRemoteUploadCommit>(
          FILES_REMOTE_COMMANDS.uploadCommit,
          {
            uploadId: init.uploadId,
            ...(opts.folderId ? { folderId: opts.folderId } : {}),
            ...(opts.projectId ? { projectId: opts.projectId } : {}),
          },
          { bodyKey: true }
        )
        return committed.key
      } catch (error) {
        // Free the staging slot; the collector would take it anyway.
        await write(FILES_REMOTE_COMMANDS.uploadAbort, { uploadId: init.uploadId }).catch(
          () => undefined
        )
        throw error
      }
    },
    async readWorkspaceFile(entry, imageLimit) {
      if (entry.byteSize !== undefined && entry.byteSize > FILES_REMOTE_MAX_BYTES) {
        throw new FilesRemoteError("files_remote_too_large")
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const parts: Uint8Array<ArrayBuffer>[] = []
        let offset = 0
        let size: number | undefined
        let changed = false
        for (;;) {
          const chunk = await read<FilesRemoteReadChunk>(FILES_REMOTE_COMMANDS.readChunk, {
            key: entry.key,
            offset,
            length: FILES_REMOTE_READ_CHUNK_MAX,
            imageLimit,
          })
          if (size !== undefined && chunk.size !== size) {
            changed = true
            break
          }
          size = chunk.size
          const bytes = base64ToBytes(chunk.dataBase64)
          if (!bytes) throw new FilesRemoteError("files_remote_invalid_answer")
          if (bytes.byteLength > 0) parts.push(bytes)
          offset += bytes.byteLength
          if (offset > FILES_REMOTE_MAX_BYTES) throw new FilesRemoteError("files_remote_too_large")
          if (chunk.eof || bytes.byteLength === 0) break
        }
        if (changed) continue
        const whole = new Uint8Array(offset)
        let at = 0
        for (const part of parts) {
          whole.set(part, at)
          at += part.byteLength
        }
        return whole
      }
      throw new FilesRemoteError("files_remote_busy")
    },
    async readMedia(entry, variant) {
      const resources = mediaResourcesFor(entry, variant)
      if (!resources || resources.length === 0) throw new FilesRemoteError("files_source_missing")
      if (!transport.readBinary) throw new FilesRemoteError("files_remote_media_unavailable")
      if (
        entry.byteSize !== undefined &&
        entry.byteSize > FILES_REMOTE_MAX_BYTES &&
        variant !== "thumbnail"
      ) {
        throw new FilesRemoteError("files_remote_too_large")
      }
      for (const resource of resources) {
        try {
          return await transport.readBinary(resource)
        } catch (error) {
          const code = errorCode(error)
          if (/too_large/i.test(code)) throw new FilesRemoteError("files_remote_too_large")
          // Not held under this session: the next one may show it.
          if (/not_found/i.test(code)) continue
          throw error
        }
      }
      throw new FilesRemoteError("files_source_missing")
    },
  }
}

export type { TransportBinaryResponse }
