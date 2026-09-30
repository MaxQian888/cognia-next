/**
 * Pure merge of every Files source into `FilesEntry` cards (ADR-0200). No I/O:
 * `sources.ts` loads the raw records, this decides what a card is.
 *
 * Folding rules:
 *   - One card per canonical image hash, however many conversations show it.
 *   - One card per conversation upload's content hash; an image upload is
 *     already its canonical image card, so image-typed uploads are dropped.
 *   - A conversation upload whose bytes were also uploaded straight into Files
 *     folds into the Files-owned card.
 *   - A kept upload whose conversations are all gone is rebuilt from the
 *     snapshot on its `libraryItems` row while its bytes are still held.
 *   - A generated video (ADR-0205) is the upload its job stored — a
 *     conversation's asset or a Files upload — carrying what the job recorded
 *     (prompt, provider, model), not a card of its own. It is kept, moved and
 *     deleted as that upload.
 */

import {
  isLibraryItemKept,
  libraryItemKey,
  type LibraryItemKind,
  type LibraryItemRow,
} from "@/lib/db/files-library-types"
import type { FilesEntry, FilesGeneratedVideo } from "./types"

/** Characters of body text kept for search and for a kept item's snapshot. */
export const FILES_BODY_EXCERPT_CHARS = 20_000

/** Sentinel session of canvas documents created outside any conversation. */
export const STANDALONE_CANVAS_SESSION_ID = "standalone"

export interface RawArtifact {
  id: string
  sessionId: string
  projectId?: string
  type: string
  title: string
  content: string
  language?: string
  createdAt: number
  updatedAt: number
  lastAccessedAt?: number
}

export interface RawCanvas {
  id: string
  sessionId: string
  projectId?: string
  title: string
  content: string
  language?: string
  type: string
  createdAt: number
  updatedAt: number
}

export interface RawImage {
  hash: string
  mediaType: string
  byteSize: number
  createdAt: number
  /** Real conversations whose messages reference the hash. */
  sessionIds: string[]
}

export interface RawUpload {
  sessionId: string
  assetId: string
  contentHash: string
  filename: string
  mediaType: string
  byteSize: number
  createdAt: number
  updatedAt: number
  extractedText?: string
  sourceAvailable: boolean
}

/** A succeeded video generation job, keyed by where it stored the video. */
export interface RawGeneratedVideo extends FilesGeneratedVideo {
  home:
    | { kind: "session-asset"; sessionId: string; assetId: string }
    | { kind: "library"; assetId: string }
}

export interface FilesAggregateInput {
  artifacts: RawArtifact[]
  canvases: RawCanvas[]
  images: RawImage[]
  sessionUploads: RawUpload[]
  libraryUploads: RawUpload[]
  generatedVideos: RawGeneratedVideo[]
  items: LibraryItemRow[]
  /** Live conversations referenced by any source, with their workspace. */
  sessions: ReadonlyMap<string, { projectId?: string }>
  /** `original:<sha>` keys still held in `messageMedia` for kept uploads. */
  heldOriginals: ReadonlySet<string>
}

export function originalMediaKey(contentHash: string): string {
  return `original:${contentHash}`
}

export function isImageMediaType(mediaType: string | undefined): boolean {
  return typeof mediaType === "string" && mediaType.toLowerCase().startsWith("image/")
}

/** Newest of "last opened" and "last changed" — the Recent ordering. */
export function entryRecency(entry: Pick<FilesEntry, "lastAccessedAt" | "updatedAt">): number {
  return Math.max(entry.lastAccessedAt ?? 0, entry.updatedAt)
}

function haystack(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => part.slice(0, FILES_BODY_EXCERPT_CHARS))
    .join("\n")
    .slice(0, FILES_BODY_EXCERPT_CHARS)
    .toLowerCase()
}

function excerptOf(text: string | undefined): { excerpt?: string } {
  return text ? { excerpt: text.slice(0, FILES_BODY_EXCERPT_CHARS) } : {}
}

function unique(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => !!value))]
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number")
  return defined.length > 0 ? Math.max(...defined) : undefined
}

function withItem(
  base: Omit<
    FilesEntry,
    "favoritedAt" | "folderId" | "hidden" | "ownedByFiles" | "lastAccessedAt"
  > & { lastAccessedAt?: number; ownedByFiles?: boolean },
  item: LibraryItemRow | undefined
): FilesEntry {
  const projectIds = unique([...base.projectIds, item?.projectId])
  return {
    ...base,
    projectIds,
    originSessionId: base.originSessionId ?? item?.originSessionId,
    ownedByFiles: base.ownedByFiles ?? item?.ownedByFiles === true,
    lastAccessedAt: maxDefined(base.lastAccessedAt, item?.lastOpenedAt),
    ...(item?.favoritedAt !== undefined ? { favoritedAt: item.favoritedAt } : {}),
    ...(item?.folderId !== undefined ? { folderId: item.folderId } : {}),
    // A removed item comes back once its source changes after the removal.
    hidden: item?.hiddenAt !== undefined && item.hiddenAt >= base.updatedAt,
  }
}

function sessionAssetKey(sessionId: string, assetId: string): string {
  return `${sessionId}\u0000${assetId}`
}

function generatedFields(video: RawGeneratedVideo | undefined): {
  generated?: FilesGeneratedVideo
} {
  if (!video) return {}
  const { home: _home, ...generated } = video
  return { generated }
}

export function aggregateFilesEntries(input: FilesAggregateInput): FilesEntry[] {
  const items = new Map(input.items.map((item) => [item.key, item]))
  const generatedInLibrary = new Map<string, RawGeneratedVideo>()
  const generatedInSessions = new Map<string, RawGeneratedVideo>()
  for (const video of input.generatedVideos) {
    if (video.home.kind === "library") generatedInLibrary.set(video.home.assetId, video)
    else generatedInSessions.set(sessionAssetKey(video.home.sessionId, video.home.assetId), video)
  }
  const itemFor = (kind: LibraryItemKind, sourceId: string) =>
    items.get(libraryItemKey(kind, sourceId))
  const projectOf = (sessionId: string) => input.sessions.get(sessionId)?.projectId
  const entries: FilesEntry[] = []

  for (const artifact of input.artifacts) {
    const alive = input.sessions.has(artifact.sessionId)
    entries.push(
      withItem(
        {
          key: libraryItemKey("artifact", artifact.id),
          kind: "artifact",
          sourceId: artifact.id,
          title: artifact.title,
          subtype: artifact.type,
          ...(artifact.language ? { language: artifact.language } : {}),
          byteSize: new TextEncoder().encode(artifact.content).byteLength,
          projectIds: unique([artifact.projectId, projectOf(artifact.sessionId)]),
          sessionIds: alive ? [artifact.sessionId] : [],
          originSessionId: artifact.sessionId,
          originAlive: alive,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
          ...(artifact.lastAccessedAt !== undefined
            ? { lastAccessedAt: artifact.lastAccessedAt }
            : {}),
          searchText: haystack(artifact.title, artifact.type, artifact.language, artifact.content),
        },
        itemFor("artifact", artifact.id)
      )
    )
  }

  for (const canvas of input.canvases) {
    const standalone = canvas.sessionId === STANDALONE_CANVAS_SESSION_ID
    const alive = standalone || input.sessions.has(canvas.sessionId)
    entries.push(
      withItem(
        {
          key: libraryItemKey("canvas", canvas.id),
          kind: "canvas",
          sourceId: canvas.id,
          title: canvas.title,
          subtype: canvas.type,
          ...(canvas.language ? { language: canvas.language } : {}),
          byteSize: new TextEncoder().encode(canvas.content).byteLength,
          projectIds: unique([
            canvas.projectId,
            standalone ? undefined : projectOf(canvas.sessionId),
          ]),
          sessionIds: !standalone && alive ? [canvas.sessionId] : [],
          ...(standalone ? {} : { originSessionId: canvas.sessionId }),
          originAlive: alive,
          createdAt: canvas.createdAt,
          updatedAt: canvas.updatedAt,
          searchText: haystack(canvas.title, canvas.type, canvas.language, canvas.content),
        },
        itemFor("canvas", canvas.id)
      )
    )
  }

  for (const image of input.images) {
    const item = itemFor("image", image.hash)
    const sessionIds = image.sessionIds.filter((id) => input.sessions.has(id))
    const owned = item?.ownedByFiles === true
    // Referenced by nothing we can show and not kept: it is waiting for GC.
    if (sessionIds.length === 0 && !(item && isLibraryItemKept(item))) continue
    entries.push(
      withItem(
        {
          key: libraryItemKey("image", image.hash),
          kind: "image",
          sourceId: image.hash,
          title: item?.snapshot?.title ?? "",
          mediaType: image.mediaType,
          byteSize: image.byteSize,
          projectIds: unique(sessionIds.map(projectOf)),
          sessionIds,
          originAlive: sessionIds.length > 0 || owned,
          createdAt: image.createdAt,
          updatedAt: image.createdAt,
          mediaHash: image.hash,
          searchText: haystack(item?.snapshot?.title, image.mediaType),
        },
        item
      )
    )
  }

  const libraryByHash = new Map<string, FilesEntry>()
  for (const upload of input.libraryUploads) {
    const item = itemFor("upload", upload.assetId)
    const generated = generatedInLibrary.get(upload.assetId)
    const entry = withItem(
      {
        key: libraryItemKey("upload", upload.assetId),
        kind: "upload",
        sourceId: upload.assetId,
        title: upload.filename,
        mediaType: upload.mediaType,
        byteSize: upload.byteSize,
        projectIds: [],
        sessionIds: [],
        originAlive: true,
        ownedByFiles: true,
        createdAt: upload.createdAt,
        updatedAt: upload.updatedAt,
        mediaHash: originalMediaKey(upload.contentHash),
        contentHash: upload.contentHash,
        assetId: upload.assetId,
        ...excerptOf(upload.extractedText),
        ...generatedFields(generated),
        searchText: haystack(
          upload.filename,
          upload.mediaType,
          generated?.prompt,
          generated?.modelId,
          upload.extractedText
        ),
      },
      item
    )
    entries.push(entry)
    libraryByHash.set(upload.contentHash, entry)
  }

  const groups = new Map<string, RawUpload[]>()
  for (const upload of input.sessionUploads) {
    if (isImageMediaType(upload.mediaType) || !upload.sourceAvailable) continue
    const group = groups.get(upload.contentHash)
    if (group) group.push(upload)
    else groups.set(upload.contentHash, [upload])
  }
  for (const [contentHash, uploads] of groups) {
    const sessionIds = unique(uploads.map((upload) => upload.sessionId)).filter((id) =>
      input.sessions.has(id)
    )
    const generated = uploads
      .map((upload) => generatedInSessions.get(sessionAssetKey(upload.sessionId, upload.assetId)))
      .find((video) => video !== undefined)
    const owned = libraryByHash.get(contentHash)
    if (owned) {
      owned.sessionIds = unique([...owned.sessionIds, ...sessionIds])
      // A video generated in a chat and then saved into Files keeps its record.
      if (generated && !owned.generated) {
        Object.assign(owned, generatedFields(generated))
        owned.searchText = haystack(owned.searchText, generated.prompt, generated.modelId)
      }
      continue
    }
    const newest = [...uploads].sort((a, b) => b.updatedAt - a.updatedAt)[0]!
    const oldest = Math.min(...uploads.map((upload) => upload.createdAt))
    const item = itemFor("session-upload", contentHash)
    entries.push(
      withItem(
        {
          key: libraryItemKey("session-upload", contentHash),
          kind: "session-upload",
          sourceId: contentHash,
          title: newest.filename,
          mediaType: newest.mediaType,
          byteSize: newest.byteSize,
          projectIds: unique(sessionIds.map(projectOf)),
          sessionIds,
          originSessionId: newest.sessionId,
          originAlive: sessionIds.length > 0,
          createdAt: oldest,
          updatedAt: newest.updatedAt,
          mediaHash: originalMediaKey(contentHash),
          contentHash,
          assetId: newest.assetId,
          assetSessionId: newest.sessionId,
          ...excerptOf(newest.extractedText),
          ...generatedFields(generated),
          searchText: haystack(
            newest.filename,
            newest.mediaType,
            generated?.prompt,
            generated?.modelId,
            newest.extractedText
          ),
        },
        item
      )
    )
  }

  // Kept uploads whose conversations are all gone: rebuilt from the snapshot.
  for (const item of input.items) {
    if (item.kind !== "session-upload" || groups.has(item.sourceId)) continue
    if (!isLibraryItemKept(item) || !input.heldOriginals.has(originalMediaKey(item.sourceId)))
      continue
    const snapshot = item.snapshot
    entries.push(
      withItem(
        {
          key: item.key,
          kind: "session-upload",
          sourceId: item.sourceId,
          title: snapshot?.title ?? "",
          ...(snapshot?.mediaType ? { mediaType: snapshot.mediaType } : {}),
          ...(snapshot?.byteSize !== undefined ? { byteSize: snapshot.byteSize } : {}),
          projectIds: [],
          sessionIds: [],
          originAlive: false,
          createdAt: item.createdAt,
          updatedAt: item.keptAt ?? item.createdAt,
          mediaHash: originalMediaKey(item.sourceId),
          contentHash: item.sourceId,
          ...excerptOf(snapshot?.extractedText),
          searchText: haystack(snapshot?.title, snapshot?.mediaType, snapshot?.extractedText),
        },
        item
      )
    )
  }

  return entries
}
