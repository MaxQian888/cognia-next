/** Portable source metadata and bounded binary records shared by v3 and v4 backups. */
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import { getDb } from "@/lib/db/schema"
import {
  checkSessionAssetQuota,
  hashSessionAssetSource,
  SESSION_ASSET_MAX_BYTES,
  SESSION_ASSET_QUOTA_BYTES,
  type SessionAsset,
} from "@/lib/db/session-assets"
import { revokeClaimsForChangedAttachment } from "@/lib/memory/lifecycle/claim-deletion-closure"
import { SESSION_ASSET_OWNER_PREFIX } from "@/lib/db/message-media-refs"
import { collectMessageMediaHashes } from "@/lib/db/message-media-refs"
import type { MessageMediaRow } from "@/lib/db/message-media"

export interface MessageMediaBackupRow extends Omit<
  MessageMediaRow,
  "blob" | "thumbBlob" | "originalBlob"
> {
  blobHash: string
  thumbHash?: string
  thumbByteSize?: number
  thumbMediaType?: string
  originalHash?: string
}

export type MessageMediaBackupRecord =
  | { section: "messageMedia"; rows: MessageMediaBackupRow[] }
  | { section: "messageMediaChunks"; rows: SessionAssetSourceChunk[] }

export interface SessionAssetSourceChunk {
  contentHash: string
  offset: number
  /** Base64 of at most 48 KiB, avoiding full-source binary arrays. */
  data: string
}

export type SessionAssetBackupRecord =
  | { section: "sessionAssets"; rows: SessionAsset[] }
  | { section: "sessionAssetSourceChunks"; rows: SessionAssetSourceChunk[] }

async function* encodeSourceChunks(
  blob: Blob,
  contentHash: string,
  chunkBytes: number
): AsyncIterable<SessionAssetSourceChunk> {
  const size = Math.min(48 * 1024, Math.max(1, Math.floor(chunkBytes)))
  for (let offset = 0; offset < blob.size; offset += size) {
    const bytes = new Uint8Array(await readBlobAsArrayBuffer(blob.slice(offset, offset + size)))
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    yield { contentHash, offset, data: btoa(binary) }
  }
}

/** Canonical images, thumbnails and their retained originals follow the exported transcript. */
export async function* exportMessageMediaRecords(
  sessionIds: ReadonlySet<string>,
  chunkBytes = 48 * 1024
): AsyncIterable<MessageMediaBackupRecord> {
  const db = getDb()
  const hashes = new Set<string>()
  if (!sessionIds.size) return
  await db.messages
    .where("sessionId")
    .anyOf([...sessionIds])
    .each((message) => {
      for (const hash of collectMessageMediaHashes(message.parts)) hashes.add(hash)
    })
  const emitted = new Set<string>()
  let byteTotal = 0
  for (const hash of hashes) {
    const row = await db.messageMedia.get(hash)
    if (!row || !(row.blob instanceof Blob)) throw new Error("message_media_backup_source_missing")
    const { blob, thumbBlob, originalBlob, ...metadata } = row
    const variants = [blob, thumbBlob, originalBlob].filter(
      (value): value is Blob => value !== undefined
    )
    if (variants.some((value) => !(value instanceof Blob)))
      throw new Error("message_media_backup_invalid_blob")
    const blobHash = await hashSessionAssetSource(blob)
    const thumbHash = thumbBlob ? await hashSessionAssetSource(thumbBlob) : undefined
    const originalHash = originalBlob ? await hashSessionAssetSource(originalBlob) : undefined
    yield {
      section: "messageMedia",
      rows: [
        {
          ...metadata,
          blobHash,
          ...(thumbHash
            ? { thumbHash, thumbByteSize: thumbBlob!.size, thumbMediaType: thumbBlob!.type }
            : {}),
          ...(originalHash ? { originalHash, originalByteSize: originalBlob!.size } : {}),
        },
      ],
    }
    for (const variant of variants) {
      const variantHash = await hashSessionAssetSource(variant)
      if (emitted.has(variantHash)) continue
      if (
        variant.size > SESSION_ASSET_MAX_BYTES ||
        (byteTotal += variant.size) > SESSION_ASSET_QUOTA_BYTES
      )
        throw new Error("message_media_backup_quota_exceeded")
      emitted.add(variantHash)
      for await (const chunk of encodeSourceChunks(variant, variantHash, chunkBytes))
        yield { section: "messageMediaChunks", rows: [chunk] }
    }
  }
}

/** Every referenced original must exist; an incomplete backup is an error. */
export async function* exportSessionAssetRecords(
  sessionIds: ReadonlySet<string>,
  chunkBytes = 48 * 1024
): AsyncIterable<SessionAssetBackupRecord> {
  const db = getDb()
  const refs = await db.messageMediaRefs.filter((row) => !!row.sessionAsset).toArray()
  const assets = refs.flatMap((row) =>
    row.sessionAsset && sessionIds.has(row.sessionId) ? [row.sessionAsset] : []
  )
  const emitted = new Set<string>()
  for (const asset of assets) {
    if (asset.sourceRetained === false) {
      yield { section: "sessionAssets", rows: [asset] }
      continue
    }
    const media = await db.messageMedia.get(`original:${asset.contentHash}`)
    if (!(media?.blob instanceof Blob) || media.blob.size !== asset.byteSize)
      throw new Error("session_asset_backup_source_missing")
    yield { section: "sessionAssets", rows: [asset] }
    if (emitted.has(asset.contentHash)) continue
    emitted.add(asset.contentHash)
    for await (const chunk of encodeSourceChunks(media.blob, asset.contentHash, chunkBytes)) {
      yield {
        section: "sessionAssetSourceChunks",
        rows: [chunk],
      }
    }
  }
}

export interface PreparedSessionAssetBackup {
  assets: SessionAsset[]
  sources: Map<string, Blob>
}

/** Validate the complete source bundle before any restore mutation. */
export async function prepareSessionAssetBackup(
  input: SessionAsset[] | undefined,
  chunks: SessionAssetSourceChunk[] | undefined,
  sessionIds: ReadonlySet<string>,
  decodedSources?: ReadonlyMap<string, Blob>
): Promise<PreparedSessionAssetBackup> {
  if (
    (input !== undefined && !Array.isArray(input)) ||
    (chunks !== undefined && !Array.isArray(chunks))
  )
    throw new Error("session_asset_backup_invalid")
  const assets = input ?? []
  const identities = new Set<string>()
  const sizes = new Map<string, number>()
  for (const asset of assets) {
    if (
      !asset ||
      typeof asset !== "object" ||
      typeof asset.sessionId !== "string" ||
      !sessionIds.has(asset.sessionId) ||
      typeof asset.assetId !== "string" ||
      !asset.assetId ||
      typeof asset.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.contentHash) ||
      typeof asset.filename !== "string" ||
      typeof asset.mediaType !== "string" ||
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize < 0 ||
      asset.byteSize > SESSION_ASSET_MAX_BYTES ||
      !Number.isFinite(asset.createdAt) ||
      !Number.isFinite(asset.updatedAt) ||
      !Number.isSafeInteger(asset.revision) ||
      asset.revision < 1 ||
      asset.temporary !== false
    )
      throw new Error("session_asset_backup_invalid")
    const identity = JSON.stringify([asset.sessionId, asset.assetId])
    if (identities.has(identity)) throw new Error("session_asset_backup_duplicate")
    identities.add(identity)
    if (asset.sourceRetained !== undefined && typeof asset.sourceRetained !== "boolean")
      throw new Error("session_asset_backup_invalid")
    if (
      asset.deletedAt !== undefined &&
      (!Number.isFinite(asset.deletedAt) ||
        asset.sourceRetained !== false ||
        asset.extractedContent)
    )
      throw new Error("session_asset_backup_invalid")
    if (asset.sourceRetained === false) {
      if (asset.byteSize !== 0) throw new Error("session_asset_backup_invalid")
    } else {
      const previousSize = sizes.get(asset.contentHash)
      if (previousSize !== undefined && previousSize !== asset.byteSize)
        throw new Error("session_asset_backup_invalid")
      sizes.set(asset.contentHash, asset.byteSize)
    }
    if (
      asset.extractedContent &&
      (!readAttachmentExtractedContent(asset.extractedContent) ||
        asset.extractedContent.attachmentId !== asset.assetId ||
        asset.extractedContent.contentHash !== asset.contentHash)
    )
      throw new Error("session_asset_backup_invalid_extraction")
  }
  checkSessionAssetQuota(assets)
  const sources = await decodeSourceChunks(sizes, chunks, decodedSources)
  return { assets, sources }
}

/** Incremental binary consumer: base64 text is released after each bounded record. */
export class BackupSourceCollector {
  private pieces = new Map<string, Blob[]>()
  private offsets = new Map<string, number>()
  private totalBytes = 0

  append(chunk: SessionAssetSourceChunk): void {
    if (
      !chunk ||
      typeof chunk !== "object" ||
      !/^[a-f0-9]{64}$/.test(chunk.contentHash) ||
      !Number.isSafeInteger(chunk.offset) ||
      chunk.offset !== (this.offsets.get(chunk.contentHash) ?? 0) ||
      typeof chunk.data !== "string" ||
      !chunk.data ||
      chunk.data.length > 65536 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
    )
      throw new Error("session_asset_backup_invalid_chunk")
    const binary = atob(chunk.data)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const nextOffset = chunk.offset + bytes.length
    this.totalBytes += bytes.length
    if (nextOffset > SESSION_ASSET_MAX_BYTES || this.totalBytes > SESSION_ASSET_QUOTA_BYTES)
      throw new Error("session_asset_backup_invalid_chunk")
    this.offsets.set(chunk.contentHash, nextOffset)
    const pieces = this.pieces.get(chunk.contentHash) ?? []
    pieces.push(new Blob([bytes]))
    this.pieces.set(chunk.contentHash, pieces)
  }

  finish(): Map<string, Blob> {
    return new Map([...this.pieces].map(([hash, pieces]) => [hash, new Blob(pieces)]))
  }
}

async function decodeSourceChunks(
  sizes: ReadonlyMap<string, number>,
  chunks: SessionAssetSourceChunk[] | undefined,
  decodedSources?: ReadonlyMap<string, Blob>
): Promise<Map<string, Blob>> {
  let decoded = decodedSources
  if (decoded && chunks?.length) throw new Error("session_asset_backup_duplicate_chunks")
  if (!decoded) {
    const collector = new BackupSourceCollector()
    for (const chunk of chunks ?? []) collector.append(chunk)
    decoded = collector.finish()
  }
  for (const hash of decoded.keys())
    if (!sizes.has(hash)) throw new Error("session_asset_backup_invalid_chunk")
  const sources = new Map<string, Blob>()
  let total = 0
  for (const [hash, size] of sizes) {
    const blob = decoded.get(hash) ?? new Blob([])
    total += blob.size
    if (!(blob instanceof Blob) || blob.size !== size || total > SESSION_ASSET_QUOTA_BYTES)
      throw new Error("session_asset_backup_source_incomplete")
    if ((await hashSessionAssetSource(blob)) !== hash)
      throw new Error("session_asset_backup_hash_mismatch")
    sources.set(hash, blob)
  }
  return sources
}

export async function prepareMessageMediaBackup(
  rows: MessageMediaBackupRow[] | undefined,
  chunks: SessionAssetSourceChunk[] | undefined,
  allowedHashes: ReadonlySet<string>,
  decodedSources?: ReadonlyMap<string, Blob>
): Promise<MessageMediaRow[]> {
  if (
    (rows !== undefined && !Array.isArray(rows)) ||
    (chunks !== undefined && !Array.isArray(chunks))
  )
    throw new Error("message_media_backup_invalid")
  const sizes = new Map<string, number>()
  const identities = new Set<string>()
  const addSize = (hash: unknown, size: unknown) => {
    if (
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > SESSION_ASSET_MAX_BYTES ||
      (sizes.has(hash) && sizes.get(hash) !== size)
    )
      throw new Error("message_media_backup_invalid")
    sizes.set(hash, size)
  }
  for (const row of rows ?? []) {
    if (
      !row ||
      typeof row !== "object" ||
      !allowedHashes.has(row.hash) ||
      identities.has(row.hash) ||
      typeof row.mediaType !== "string" ||
      !Number.isFinite(row.createdAt) ||
      !Number.isFinite(row.lastUsedAt) ||
      !Number.isInteger(row.width) ||
      row.width < 0 ||
      !Number.isInteger(row.height) ||
      row.height < 0 ||
      (row.canonicalAvailable !== undefined && typeof row.canonicalAvailable !== "boolean")
    )
      throw new Error("message_media_backup_invalid")
    identities.add(row.hash)
    addSize(row.blobHash, row.byteSize)
    if (row.thumbHash !== undefined) {
      addSize(row.thumbHash, row.thumbByteSize)
      if (
        typeof row.thumbMediaType !== "string" ||
        (row.thumbWidth !== undefined &&
          (!Number.isInteger(row.thumbWidth) || row.thumbWidth < 0)) ||
        (row.thumbHeight !== undefined &&
          (!Number.isInteger(row.thumbHeight) || row.thumbHeight < 0))
      )
        throw new Error("message_media_backup_invalid")
    }
    if (row.originalHash !== undefined) {
      addSize(row.originalHash, row.originalByteSize)
      if (typeof row.originalMediaType !== "string") throw new Error("message_media_backup_invalid")
    }
  }
  const sources = await decodeSourceChunks(sizes, chunks, decodedSources)
  return (rows ?? []).map((row) => {
    const {
      blobHash,
      thumbHash,
      thumbByteSize: _thumbBytes,
      thumbMediaType,
      originalHash,
      ...metadata
    } = row
    const blob = sources.get(blobHash)!
    return {
      ...metadata,
      blob: blob.slice(0, blob.size, row.mediaType),
      ...(thumbHash
        ? { thumbBlob: sources.get(thumbHash)!.slice(0, undefined, thumbMediaType) }
        : {}),
      ...(originalHash
        ? { originalBlob: sources.get(originalHash)!.slice(0, undefined, row.originalMediaType) }
        : {}),
    }
  })
}

/** Caller owns the transaction containing sessions, media and references. */
export async function restoreSessionAssetBackup(
  prepared: PreparedSessionAssetBackup,
  sessionMapping: ReadonlyMap<string, string>,
  strategy: "skip" | "overwrite" | "duplicate"
): Promise<void> {
  const db = getDb()
  const refs = await db.messageMediaRefs.filter((row) => !!row.sessionAsset).toArray()
  const combined = new Map(refs.map((row) => [row.messageId, row.sessionAsset!]))
  const writes: SessionAsset[] = []
  const orphanHashes = new Set<string>()
  for (const asset of prepared.assets) {
    const sessionId = sessionMapping.get(asset.sessionId)
    if (!sessionId || !(await db.sessions.get(sessionId)))
      throw new Error("session_asset_backup_session_missing")
    const next = { ...asset, sessionId }
    const key = `${SESSION_ASSET_OWNER_PREFIX}${JSON.stringify([sessionId, asset.assetId])}`
    if (combined.has(key) && strategy === "skip") continue
    const prior = combined.get(key)
    if (
      prior &&
      (prior.contentHash !== next.contentHash ||
        JSON.stringify(prior.extractedContent) !== JSON.stringify(next.extractedContent))
    ) {
      await revokeClaimsForChangedAttachment(sessionId, asset.assetId, db)
      orphanHashes.add(`original:${prior.contentHash}`)
    }
    combined.set(key, next)
    writes.push(next)
  }
  checkSessionAssetQuota([...combined.values()])
  for (const asset of writes) {
    const messageId = `${SESSION_ASSET_OWNER_PREFIX}${JSON.stringify([asset.sessionId, asset.assetId])}`
    const hash =
      asset.sourceRetained === false
        ? `${asset.deletedAt ? "deleted" : "derived"}:${messageId}`
        : `original:${asset.contentHash}`
    if (asset.sourceRetained !== false && !(await db.messageMedia.get(hash))) {
      const blob = prepared.sources.get(asset.contentHash)!
      await db.messageMedia.put({
        hash,
        blob: blob.slice(0, blob.size, asset.mediaType),
        byteSize: blob.size,
        mediaType: asset.mediaType,
        width: 0,
        height: 0,
        createdAt: asset.createdAt,
        lastUsedAt: Date.now(),
      })
    }
    // Remove an overwritten binding to another hash before putting its new compound key.
    await db.messageMediaRefs.where("messageId").equals(messageId).delete()
    await db.messageMediaRefs.put({
      messageId,
      sessionId: asset.sessionId,
      hash,
      sessionAsset: asset,
    })
  }
  for (const hash of orphanHashes) {
    if (!(await db.messageMediaRefs.where("hash").equals(hash).count()))
      await db.messageMedia.delete(hash)
  }
}
