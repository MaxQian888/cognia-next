/**
 * Loaders feeding `aggregateFilesEntries` (ADR-0200). Artifacts and canvas
 * documents come from the artifact store (hydrated from Dexie by the root
 * bridges); images, uploads and Files metadata come straight from Dexie.
 * Only metadata and Blob handles are read — no image or upload bytes.
 */

import type { Artifact, CanvasDocument } from "@/types/artifact/artifact"
import { getDb } from "@/lib/db/schema"
import { getSessionsByIds } from "@/lib/db/sessions"
import { listLibraryItems } from "@/lib/db/files-library-items"
import { isLibraryItemKept } from "@/lib/db/files-library-types"
import { LIBRARY_REF_SESSION_ID } from "@/lib/db/message-media-refs"
import {
  listAllSessionAssets,
  listLibraryAssets,
  type ListedSessionAsset,
} from "@/lib/db/session-assets"
import {
  FILES_BODY_EXCERPT_CHARS,
  isImageMediaType,
  originalMediaKey,
  STANDALONE_CANVAS_SESSION_ID,
  type FilesAggregateInput,
  type RawArtifact,
  type RawCanvas,
  type RawImage,
  type RawUpload,
} from "./aggregate"

/** Images read per load; the page asks for more as the user scrolls. */
export const FILES_IMAGE_PAGE_SIZE = 500

function toMillis(value: Date | string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export function rawArtifacts(artifacts: Record<string, Artifact>): RawArtifact[] {
  return Object.values(artifacts).map((artifact) => ({
    id: artifact.id,
    sessionId: artifact.sessionId,
    ...(artifact.projectId ? { projectId: artifact.projectId } : {}),
    type: artifact.type,
    title: artifact.title,
    content: artifact.content,
    ...(artifact.language ? { language: artifact.language } : {}),
    createdAt: toMillis(artifact.createdAt) ?? 0,
    updatedAt: toMillis(artifact.updatedAt) ?? 0,
    ...(artifact.metadata?.lastAccessedAt
      ? { lastAccessedAt: toMillis(artifact.metadata.lastAccessedAt) }
      : {}),
  }))
}

export function rawCanvases(documents: Record<string, CanvasDocument>): RawCanvas[] {
  return Object.values(documents).map((doc) => ({
    id: doc.id,
    sessionId: doc.sessionId,
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    title: doc.title,
    content: doc.content,
    language: doc.language,
    type: doc.type,
    createdAt: toMillis(doc.createdAt) ?? 0,
    updatedAt: toMillis(doc.updatedAt) ?? 0,
  }))
}

function extractedText(asset: ListedSessionAsset): string | undefined {
  const segments = asset.extractedContent?.segments
  if (!segments?.length) return undefined
  let text = ""
  for (const segment of segments) {
    if (text.length >= FILES_BODY_EXCERPT_CHARS) break
    text += (text ? "\n" : "") + segment.text
  }
  return text.slice(0, FILES_BODY_EXCERPT_CHARS)
}

function rawUpload(asset: ListedSessionAsset): RawUpload {
  const text = extractedText(asset)
  return {
    sessionId: asset.sessionId,
    assetId: asset.assetId,
    contentHash: asset.contentHash,
    filename: asset.filename,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    ...(text ? { extractedText: text } : {}),
    sourceAvailable: asset.sourceAvailable,
  }
}

async function describeImages(
  rows: Array<{ hash: string; mediaType: string; byteSize: number; createdAt: number }>
): Promise<RawImage[]> {
  const db = getDb()
  const hashes = rows.map((row) => row.hash)
  const refs = hashes.length ? await db.messageMediaRefs.where("hash").anyOf(hashes).toArray() : []
  const sessionsByHash = new Map<string, Set<string>>()
  for (const ref of refs) {
    if (ref.sessionId === LIBRARY_REF_SESSION_ID) continue
    const set = sessionsByHash.get(ref.hash) ?? new Set<string>()
    set.add(ref.sessionId)
    sessionsByHash.set(ref.hash, set)
  }
  return rows.map((row) => ({
    hash: row.hash,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    sessionIds: [...(sessionsByHash.get(row.hash) ?? [])],
  }))
}

/**
 * The newest `limit` canonical images plus every image in `alsoHashes` (kept
 * images older than the page), with the conversations that show them. Keys
 * carrying ":" are originals / derived / tombstones, not images.
 */
export async function loadImages(
  limit: number,
  alsoHashes: readonly string[] = []
): Promise<{ images: RawImage[]; truncated: boolean }> {
  const db = getDb()
  const rows = await db.messageMedia
    .orderBy("createdAt")
    .reverse()
    .filter((row) => !row.hash.includes(":") && isImageMediaType(row.mediaType))
    .limit(limit + 1)
    .toArray()
  const page = rows.slice(0, limit)
  const onPage = new Set(page.map((row) => row.hash))
  const missing = alsoHashes.filter((hash) => !onPage.has(hash))
  const extra = missing.length
    ? (await db.messageMedia.bulkGet(missing)).filter(
        (row): row is NonNullable<typeof row> =>
          row !== undefined && isImageMediaType(row.mediaType)
      )
    : []
  return { images: await describeImages([...page, ...extra]), truncated: rows.length > limit }
}

export interface LoadedFilesSources {
  input: FilesAggregateInput
  /** More images exist beyond `imageLimit`. */
  imagesTruncated: boolean
}

/** Everything the aggregate needs besides the artifact store snapshot. */
export async function loadFilesSources(options: {
  artifacts: Record<string, Artifact>
  canvasDocuments: Record<string, CanvasDocument>
  imageLimit?: number
}): Promise<LoadedFilesSources> {
  const [sessionAssets, libraryAssets, items] = await Promise.all([
    listAllSessionAssets(),
    listLibraryAssets(),
    listLibraryItems(),
  ])
  const { images, truncated } = await loadImages(
    options.imageLimit ?? FILES_IMAGE_PAGE_SIZE,
    items
      .filter((item) => item.kind === "image" && isLibraryItemKept(item))
      .map((item) => item.sourceId)
  )
  const artifacts = rawArtifacts(options.artifacts)
  const canvases = rawCanvases(options.canvasDocuments)
  const sessionIds = new Set<string>()
  for (const artifact of artifacts) sessionIds.add(artifact.sessionId)
  for (const canvas of canvases) {
    if (canvas.sessionId !== STANDALONE_CANVAS_SESSION_ID) sessionIds.add(canvas.sessionId)
  }
  for (const image of images) for (const id of image.sessionIds) sessionIds.add(id)
  for (const asset of sessionAssets) sessionIds.add(asset.sessionId)
  const sessions = new Map(
    (await getSessionsByIds([...sessionIds])).map((session) => [
      session.id,
      session.projectId ? { projectId: session.projectId } : {},
    ])
  )
  const keptUploadKeys = items
    .filter((item) => item.kind === "session-upload" && isLibraryItemKept(item))
    .map((item) => originalMediaKey(item.sourceId))
  const heldOriginals = new Set(
    keptUploadKeys.length
      ? ((await getDb().messageMedia.where("hash").anyOf(keptUploadKeys).primaryKeys()) as string[])
      : []
  )
  return {
    input: {
      artifacts,
      canvases,
      images,
      sessionUploads: sessionAssets.map(rawUpload),
      libraryUploads: libraryAssets.map(rawUpload),
      items,
      sessions,
      heldOriginals,
    },
    imagesTruncated: truncated,
  }
}
