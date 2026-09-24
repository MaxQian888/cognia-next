/**
 * Session-owned original attachments, independent of transcript messages.
 * Reuses the content-addressed Blob store and its indexed ownership ledger.
 * Original keys are separate from canonical image keys so saving a source
 * cannot make image ingestion mistake an unprocessed upload for a preview.
 */
import {
  readAttachmentExtractedContent,
  type AttachmentExtractedContent,
  type AttachmentSegment,
} from "@cognia/agent-config-types/attachment"
import { BM25Index } from "@cognia/rag/hybrid-search"
import { createContextManager } from "@cognia/rag/context-manager"
import { tokenizeMultilingual } from "@cognia/rag/cjk-tokenizer"
import { sha256Blob } from "@/lib/ocr/hash"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { getDb } from "./schema"
import { revokeClaimsForChangedAttachment } from "@/lib/memory/lifecycle/claim-deletion-closure"
import type { UIMessage } from "ai"
import { SESSION_ASSET_OWNER_PREFIX } from "./message-media-refs"

export const SESSION_ASSET_MAX_BYTES = 500 * 1024 * 1024
export const SESSION_ASSET_QUOTA_BYTES = 1024 * 1024 * 1024
const MAX_ASSETS = 5_000

export interface SessionAsset {
  sessionId: string
  assetId: string
  contentHash: string
  filename: string
  mediaType: string
  byteSize: number
  extractedContent?: AttachmentExtractedContent
  createdAt: number
  updatedAt: number
  revision: number
  temporary: boolean
  /** False for remote/imported derived text whose original never reached this host. */
  sourceRetained?: boolean
  /** Content-free tombstone prevents stale transcript snapshots resurrecting a deleted asset. */
  deletedAt?: number
}

export interface StoredSessionAsset extends SessionAsset {
  /** Untouched local source; callers must separately authorize model delivery. */
  blob: Blob
}

export class SessionAssetError extends Error {
  constructor(
    readonly code:
      | "session_asset_not_found"
      | "session_asset_session_missing"
      | "session_asset_scope_changed"
      | "session_asset_identity_conflict"
      | "session_asset_invalid_extraction"
      | "session_asset_too_large"
      | "session_asset_invalid_original"
      | "session_asset_quota_exceeded"
  ) {
    super(code)
    this.name = "SessionAssetError"
  }
}

export interface PutSessionAssetInput {
  sessionId: string
  assetId: string
  blob: Blob
  filename: string
  mediaType: string
  extractedContent?: AttachmentExtractedContent
  temporary?: boolean
  /** Host-selected storage ceiling; never evicts another referenced source. */
  quotaBytes?: number
  now?: number
}

// Per database object: switching host/account cannot expose another target's
// temporary originals. Reloading the process drops these bytes by design.
type TemporarySessionAsset = SessionAsset & { blob?: Blob }
const temporaryAssets = new WeakMap<ReturnType<typeof getDb>, Map<string, TemporarySessionAsset>>()
const sourceHashes = new WeakMap<Blob, Promise<string>>()

/** Bounded-memory hashing for video originals; identical Blob objects share work. */
export function hashSessionAssetSource(blob: Blob): Promise<string> {
  let hash = sourceHashes.get(blob)
  if (!hash) {
    hash = (async () => {
      const chunkSize = 1024 * 1024
      if (blob.size <= chunkSize * 4) return sha256Blob(blob)
      const { sha256 } = await import("@noble/hashes/sha256")
      const { bytesToHex } = await import("@noble/hashes/utils")
      const digest = sha256.create()
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        digest.update(
          new Uint8Array(await readBlobAsArrayBuffer(blob.slice(offset, offset + chunkSize)))
        )
        // Yield between chunks so hashing a large upload does not monopolize UI work.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      return bytesToHex(digest.digest())
    })().catch((error) => {
      sourceHashes.delete(blob)
      throw error
    })
    sourceHashes.set(blob, hash)
  }
  return hash
}

function ownerKey(sessionId: string, assetId: string): string {
  return `${SESSION_ASSET_OWNER_PREFIX}${JSON.stringify([sessionId, assetId])}`
}

function originalKey(hash: string): string {
  return `original:${hash}`
}

function temporaryStore(db = getDb()): Map<string, TemporarySessionAsset> {
  let rows = temporaryAssets.get(db)
  if (!rows) {
    rows = new Map()
    temporaryAssets.set(db, rows)
  }
  return rows
}

function validateExtraction(
  asset: Pick<SessionAsset, "assetId" | "contentHash">,
  extractedContent: AttachmentExtractedContent | undefined
): void {
  if (
    extractedContent &&
    (!readAttachmentExtractedContent(extractedContent) ||
      extractedContent.attachmentId !== asset.assetId ||
      extractedContent.contentHash !== asset.contentHash)
  ) {
    throw new SessionAssetError("session_asset_invalid_extraction")
  }
}

async function availableStorageBytes(): Promise<number | undefined> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return undefined
    const { quota, usage } = await navigator.storage.estimate()
    if (
      quota === undefined ||
      usage === undefined ||
      !Number.isFinite(quota) ||
      !Number.isFinite(usage)
    )
      return undefined
    return Math.max(0, quota - usage)
  } catch {
    // IndexedDB still enforces the browser's own quota if probing is unavailable.
    return undefined
  }
}

export function checkSessionAssetQuota(
  rows: SessionAsset[],
  quotaBytes = SESSION_ASSET_QUOTA_BYTES
): void {
  if (
    !Number.isFinite(quotaBytes) ||
    quotaBytes < 0 ||
    rows.filter((row) => !row.deletedAt).length > MAX_ASSETS
  ) {
    throw new SessionAssetError("session_asset_quota_exceeded")
  }
  const unique = new Map<string, number>()
  let metadataBytes = 0
  for (const row of rows) {
    unique.set(row.contentHash, Math.max(unique.get(row.contentHash) ?? 0, row.byteSize))
    metadataBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength
  }
  const bytes = [...unique.values()].reduce((sum, size) => sum + size, metadataBytes)
  if (bytes > quotaBytes) throw new SessionAssetError("session_asset_quota_exceeded")
}

function withoutBlob(row: TemporarySessionAsset): SessionAsset {
  const { blob: _blob, ...metadata } = row
  return metadata
}

async function ownedRef(db: ReturnType<typeof getDb>, sessionId: string, assetId: string) {
  const refs = await db.messageMediaRefs
    .where("messageId")
    .equals(ownerKey(sessionId, assetId))
    .toArray()
  return refs.find((row) => row.sessionId === sessionId && row.sessionAsset?.assetId === assetId)
}

/** Save the immutable source before creating any message that refers to it. */
export async function putSessionAsset(input: PutSessionAssetInput): Promise<SessionAsset> {
  if (!input.sessionId || !input.assetId)
    throw new SessionAssetError("session_asset_identity_conflict")
  if (!(input.blob instanceof Blob)) throw new SessionAssetError("session_asset_invalid_original")
  if (input.blob.size > SESSION_ASSET_MAX_BYTES)
    throw new SessionAssetError("session_asset_too_large")
  const db = getDb()
  const contentHash = await hashSessionAssetSource(input.blob)
  const availableBytes = input.temporary ? undefined : await availableStorageBytes()
  if (getDb() !== db) throw new SessionAssetError("session_asset_scope_changed")
  const now = input.now ?? Date.now()
  const key = ownerKey(input.sessionId, input.assetId)
  const asset: SessionAsset = {
    sessionId: input.sessionId,
    assetId: input.assetId,
    contentHash,
    filename: input.filename,
    mediaType: input.mediaType,
    byteSize: input.blob.size,
    ...(input.extractedContent ? { extractedContent: input.extractedContent } : {}),
    createdAt: now,
    updatedAt: now,
    revision: 1,
    temporary: input.temporary === true,
    sourceRetained: true,
    deletedAt: undefined,
  }
  validateExtraction(asset, input.extractedContent)
  const ephemeral = temporaryStore(db)
  if (input.temporary) {
    const existing = ephemeral.get(key)
    if (existing && existing.contentHash !== contentHash) {
      throw new SessionAssetError("session_asset_identity_conflict")
    }
    const next = {
      ...(existing ? withoutBlob(existing) : {}),
      ...asset,
      createdAt: existing?.createdAt ?? now,
      revision: (existing?.revision ?? 0) + 1,
    }
    const durable = await db.messageMediaRefs.filter((row) => !!row.sessionAsset).toArray()
    if (getDb() !== db) throw new SessionAssetError("session_asset_scope_changed")
    checkSessionAssetQuota(
      [...ephemeral.entries()]
        .filter(([id]) => id !== key)
        .map(([, row]) => withoutBlob(row))
        .concat(
          durable.map((row) => row.sessionAsset!),
          next
        ),
      input.quotaBytes
    )
    const shared = [...ephemeral.values()].find((row) => row.contentHash === contentHash)
    ephemeral.set(key, { ...structuredClone(next), blob: shared?.blob ?? input.blob })
    searchIndexes.get(db)?.delete(input.sessionId)
    return structuredClone(next)
  }
  const result = await db.transaction(
    "rw",
    db.sessions,
    db.messageMedia,
    db.messageMediaRefs,
    db.memoryEvidence,
    db.memories,
    async () => {
      const session = await db.sessions.get(input.sessionId)
      if (!session) throw new SessionAssetError("session_asset_session_missing")
      assertSessionWritable(session, "send-message")
      const existing = await ownedRef(db, input.sessionId, input.assetId)
      if (
        existing &&
        !existing.sessionAsset!.deletedAt &&
        existing.sessionAsset!.contentHash !== contentHash
      ) {
        throw new SessionAssetError("session_asset_identity_conflict")
      }
      if (
        existing?.sessionAsset &&
        !existing.sessionAsset.deletedAt &&
        existing.sessionAsset.sourceRetained !== false &&
        existing.sessionAsset.filename === asset.filename &&
        existing.sessionAsset.mediaType === asset.mediaType &&
        JSON.stringify(existing.sessionAsset.extractedContent) ===
          JSON.stringify(asset.extractedContent) &&
        (await db.messageMedia.where("hash").equals(originalKey(contentHash)).count())
      ) {
        return existing.sessionAsset
      }
      const next = {
        ...existing?.sessionAsset,
        ...asset,
        createdAt: existing?.sessionAsset?.createdAt ?? now,
        revision: (existing?.sessionAsset?.revision ?? 0) + 1,
      }
      if (
        existing?.sessionAsset &&
        JSON.stringify(existing.sessionAsset.extractedContent) !==
          JSON.stringify(input.extractedContent)
      ) {
        await revokeClaimsForChangedAttachment(input.sessionId, input.assetId, db, now)
      }
      // Only metadata is scanned. Never deserialize every Blob to calculate quota.
      const refs = await db.messageMediaRefs
        .filter((row) => row.sessionAsset !== undefined)
        .toArray()
      checkSessionAssetQuota(
        refs
          .filter((row) => row.messageId !== key)
          .map((row) => row.sessionAsset!)
          .concat(
            [...ephemeral.entries()]
              .filter(([id]) => id !== key)
              .map(([, row]) => withoutBlob(row)),
            next
          ),
        input.quotaBytes
      )
      const hash = originalKey(contentHash)
      const held = await db.messageMedia.get(hash)
      const requiredBytes =
        (held ? 0 : input.blob.size) + new TextEncoder().encode(JSON.stringify(next)).byteLength
      if (availableBytes !== undefined && requiredBytes > availableBytes)
        throw new SessionAssetError("session_asset_quota_exceeded")
      if (!held) {
        await db.messageMedia.add({
          hash,
          blob: input.blob,
          byteSize: input.blob.size,
          mediaType: input.mediaType,
          width: 0,
          height: 0,
          createdAt: now,
          lastUsedAt: now,
        })
      }
      await db.messageMediaRefs.where("messageId").equals(key).delete()
      await db.messageMediaRefs.put({
        messageId: key,
        sessionId: input.sessionId,
        hash,
        sessionAsset: next,
      })
      // A successful explicit promotion drops only this temporary binding.
      return next
    }
  )
  ephemeral.delete(key)
  searchIndexes.get(db)?.delete(input.sessionId)
  return result
}

/** Resolve only within the supplied session; another session's id grants no access. */
export async function getSessionAsset(
  sessionId: string,
  assetId: string
): Promise<StoredSessionAsset | undefined> {
  const db = getDb()
  const temporary = temporaryStore(db).get(ownerKey(sessionId, assetId))
  if (temporary)
    return temporary.sourceRetained === false || !temporary.blob
      ? undefined
      : { ...structuredClone(withoutBlob(temporary)), blob: temporary.blob }
  return db.transaction("r", db.sessions, db.messageMediaRefs, db.messageMedia, async () => {
    if (!(await db.sessions.get(sessionId))) return undefined
    const ref = await ownedRef(db, sessionId, assetId)
    if (
      !ref?.sessionAsset ||
      ref.sessionAsset.deletedAt ||
      ref.sessionAsset.sourceRetained === false
    )
      return undefined
    const media = await db.messageMedia.get(ref.hash)
    return media?.blob instanceof Blob ? { ...ref.sessionAsset, blob: media.blob } : undefined
  })
}

export interface ListedSessionAsset extends SessionAsset {
  /** Indexed presence check; false means metadata survived but source bytes are unavailable here. */
  sourceAvailable: boolean
}

/** Indexed single-asset lookup for viewers and tools; original bytes remain unloaded. */
export async function getSessionAssetMetadata(
  sessionId: string,
  assetId: string
): Promise<ListedSessionAsset | undefined> {
  const db = getDb()
  const temporary = temporaryStore(db).get(ownerKey(sessionId, assetId))
  if (temporary)
    return temporary.deletedAt
      ? undefined
      : structuredClone({
          ...withoutBlob(temporary),
          sourceAvailable: temporary.sourceRetained !== false && !!temporary.blob,
        })
  const result = await db.transaction(
    "r",
    db.sessions,
    db.messageMediaRefs,
    db.messageMedia,
    async () => {
      if (!(await db.sessions.get(sessionId))) return undefined
      const ref = await ownedRef(db, sessionId, assetId)
      if (!ref?.sessionAsset || ref.sessionAsset.deletedAt) return undefined
      return {
        ...ref.sessionAsset,
        sourceAvailable:
          ref.sessionAsset.sourceRetained !== false &&
          !!(await db.messageMedia.where("hash").equals(ref.hash).count()),
      }
    }
  )
  if (getDb() !== db) throw new SessionAssetError("session_asset_scope_changed")
  return result
}

/** Listing reads metadata and primary keys only; it never materializes source files. */
export async function listSessionAssets(sessionId: string): Promise<ListedSessionAsset[]> {
  const db = getDb()
  const rows = (await db.messageMediaRefs.where("sessionId").equals(sessionId).toArray()).flatMap(
    (row) => (row.sessionAsset && !row.sessionAsset.deletedAt ? [row.sessionAsset] : [])
  )
  const all = new Map(rows.map((row) => [row.assetId, row]))
  for (const row of temporaryStore(db).values()) {
    if (row.sessionId === sessionId && !row.deletedAt) all.set(row.assetId, withoutBlob(row))
  }
  const hashes = [...new Set(rows.map((row) => originalKey(row.contentHash)))]
  const available = new Set(
    hashes.length ? await db.messageMedia.where("hash").anyOf(hashes).primaryKeys() : []
  )
  return structuredClone(
    [...all.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({
        ...row,
        sourceAvailable:
          row.sourceRetained !== false &&
          (row.temporary || available.has(originalKey(row.contentHash))),
      }))
  )
}

/** Retryable extraction replaces derived metadata without rewriting original bytes. */
export async function updateSessionAssetExtraction(
  sessionId: string,
  assetId: string,
  extractedContent: AttachmentExtractedContent
): Promise<void> {
  const db = getDb()
  const key = ownerKey(sessionId, assetId)
  const temporary = temporaryStore(db).get(key)
  if (temporary) {
    if (temporary.deletedAt) throw new SessionAssetError("session_asset_not_found")
    validateExtraction(temporary, extractedContent)
    const updated = {
      ...temporary,
      extractedContent: structuredClone(extractedContent),
      updatedAt: Date.now(),
      revision: temporary.revision + 1,
    }
    const durable = await db.messageMediaRefs.filter((row) => !!row.sessionAsset).toArray()
    checkSessionAssetQuota(
      [...temporaryStore(db).entries()]
        .map(([id, row]) => withoutBlob(id === key ? updated : row))
        .concat(durable.map((row) => row.sessionAsset!))
    )
    temporaryStore(db).set(key, updated)
    searchIndexes.get(db)?.delete(sessionId)
    return
  }
  await db.transaction(
    "rw",
    [db.sessions, db.messageMediaRefs, db.memoryEvidence, db.memories],
    async () => {
      const session = await db.sessions.get(sessionId)
      if (!session) throw new SessionAssetError("session_asset_session_missing")
      assertSessionWritable(session, "send-message")
      const ref = await ownedRef(db, sessionId, assetId)
      if (!ref?.sessionAsset || ref.sessionAsset.deletedAt)
        throw new SessionAssetError("session_asset_not_found")
      validateExtraction(ref.sessionAsset, extractedContent)
      if (JSON.stringify(ref.sessionAsset.extractedContent) === JSON.stringify(extractedContent))
        return
      await revokeClaimsForChangedAttachment(sessionId, assetId, db)
      const next = {
        ...ref.sessionAsset,
        extractedContent,
        updatedAt: Date.now(),
        revision: ref.sessionAsset.revision + 1,
      }
      const refs = await db.messageMediaRefs
        .filter((row) => row.sessionAsset !== undefined)
        .toArray()
      checkSessionAssetQuota(
        refs
          .map((row) => (row.messageId === key ? next : row.sessionAsset!))
          .concat([...temporaryStore(db).values()].map(withoutBlob))
      )
      await db.messageMediaRefs.update([ref.messageId, ref.hash], { sessionAsset: next })
    }
  )
  searchIndexes.get(db)?.delete(sessionId)
}

/** Release one binding; shared bytes remain until their last owner releases them. */
export async function releaseSessionAsset(sessionId: string, assetId: string): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    [db.sessions, db.messageMediaRefs, db.messageMedia, db.memoryEvidence, db.memories],
    async () => {
      assertSessionWritable(await db.sessions.get(sessionId), "metadata")
      const ref = await ownedRef(db, sessionId, assetId)
      if (!ref || ref.sessionAsset?.deletedAt) return
      await revokeClaimsForChangedAttachment(sessionId, assetId, db)
      await db.messageMediaRefs.delete([ref.messageId, ref.hash])
      const { extractedContent: _content, ...metadata } = ref.sessionAsset!
      const tombstone: SessionAsset = {
        ...metadata,
        byteSize: 0,
        sourceRetained: false,
        deletedAt: Date.now(),
        revision: metadata.revision + 1,
      }
      await db.messageMediaRefs.put({
        messageId: ref.messageId,
        sessionId,
        hash: `deleted:${ref.messageId}`,
        sessionAsset: tombstone,
      })
      if (!(await db.messageMediaRefs.where("hash").equals(ref.hash).count()))
        await db.messageMedia.delete(ref.hash)
    }
  )
  const temporary = temporaryStore(db).get(ownerKey(sessionId, assetId))
  if (temporary) {
    const { blob: _blob, extractedContent: _extraction, ...metadata } = temporary
    temporaryStore(db).set(ownerKey(sessionId, assetId), {
      ...metadata,
      byteSize: 0,
      sourceRetained: false,
      deletedAt: Date.now(),
      revision: metadata.revision + 1,
    })
  }
  searchIndexes.get(db)?.delete(sessionId)
}

export const deleteSessionAsset = releaseSessionAsset

/** Synchronous teardown for temporary sessions, also called by session deletion. */
export function clearTemporarySessionAssets(sessionIds?: readonly string[]): void {
  const rows = temporaryStore()
  if (!sessionIds) {
    rows.clear()
    searchIndexes.get(getDb())?.clear()
    return
  }
  const ids = new Set(sessionIds)
  for (const id of ids) searchIndexes.get(getDb())?.delete(id)
  for (const [key, row] of rows) if (ids.has(row.sessionId)) rows.delete(key)
}

/** Durable session deletion uses the existing ledger transaction in sessions.ts. */
export async function deleteSessionAssets(sessionId: string): Promise<void> {
  const rows = await listSessionAssets(sessionId)
  for (const row of rows) await releaseSessionAsset(sessionId, row.assetId)
}

/** Register only a new derived source; replaying a transcript cannot overwrite local state. */
async function registerDerivedSessionAsset(
  sessionId: string,
  extraction: AttachmentExtractedContent,
  filename: string,
  mediaType: string,
  temporary: boolean
): Promise<void> {
  const db = getDb()
  const key = ownerKey(sessionId, extraction.attachmentId)
  if (temporaryStore(db).has(key)) return
  const asset: SessionAsset = {
    sessionId,
    assetId: extraction.attachmentId,
    contentHash: extraction.contentHash,
    filename,
    mediaType,
    byteSize: 0,
    extractedContent: extraction,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    temporary,
    sourceRetained: false,
  }
  if (temporary) {
    const rows = temporaryStore(db)
    const durable = await db.messageMediaRefs.filter((row) => !!row.sessionAsset).toArray()
    checkSessionAssetQuota(
      [...rows.values()].map(withoutBlob).concat(
        durable.map((row) => row.sessionAsset!),
        asset
      )
    )
    rows.set(key, asset)
    searchIndexes.get(db)?.delete(sessionId)
    return
  }
  await db.transaction("rw", db.sessions, db.messageMediaRefs, async () => {
    const session = await db.sessions.get(sessionId)
    if (!session) throw new SessionAssetError("session_asset_session_missing")
    assertSessionWritable(session, "send-message")
    if (await ownedRef(db, sessionId, asset.assetId)) return
    const refs = await db.messageMediaRefs.filter((row) => !!row.sessionAsset).toArray()
    checkSessionAssetQuota(
      refs
        .map((row) => row.sessionAsset!)
        .concat([...temporaryStore(db).values()].map(withoutBlob), asset)
    )
    await db.messageMediaRefs.put({
      messageId: key,
      sessionId,
      hash: `derived:${key}`,
      sessionAsset: asset,
    })
  })
  searchIndexes.get(db)?.delete(sessionId)
}

/** Remove ephemeral Blob fields only after the session owns the complete original. */
export async function persistMessageSessionAssets(
  sessionId: string,
  message: UIMessage
): Promise<UIMessage> {
  let changed = false
  const seen = new Map<string, { hash: string; original: Blob }>()
  const parts = [] as UIMessage["parts"]
  for (const part of message.parts) {
    const candidate = part as typeof part & {
      attachmentOriginal?: Blob
      attachmentOriginalMediaType?: string
      attachmentTemporary?: boolean
      extractedContent?: AttachmentExtractedContent
      filename?: string
      mediaType?: string
    }
    if (candidate.attachmentOriginal === undefined) {
      const extraction = readAttachmentExtractedContent(candidate.extractedContent)
      if (extraction)
        await registerDerivedSessionAsset(
          sessionId,
          extraction,
          candidate.filename ?? "attachment",
          candidate.attachmentOriginalMediaType ||
            candidate.mediaType ||
            "application/octet-stream",
          candidate.attachmentTemporary === true
        )
      parts.push(part)
      continue
    }
    if (!(candidate.attachmentOriginal instanceof Blob))
      throw new SessionAssetError("session_asset_invalid_original")
    const extraction = readAttachmentExtractedContent(candidate.extractedContent)
    if (!extraction) throw new SessionAssetError("session_asset_invalid_extraction")
    const previous = seen.get(extraction.attachmentId)
    if (
      previous &&
      (previous.hash !== extraction.contentHash ||
        (previous.original !== candidate.attachmentOriginal &&
          (await hashSessionAssetSource(candidate.attachmentOriginal)) !== previous.hash))
    ) {
      throw new SessionAssetError("session_asset_identity_conflict")
    }
    if (!previous) {
      await putSessionAsset({
        sessionId,
        assetId: extraction.attachmentId,
        blob: candidate.attachmentOriginal,
        filename: candidate.filename ?? "attachment",
        mediaType:
          candidate.attachmentOriginal.type ||
          candidate.attachmentOriginalMediaType ||
          candidate.mediaType ||
          "application/octet-stream",
        extractedContent: extraction,
        temporary: candidate.attachmentTemporary,
      })
      seen.set(extraction.attachmentId, {
        hash: extraction.contentHash,
        original: candidate.attachmentOriginal,
      })
    }
    const { attachmentOriginal: _original, ...stored } = candidate
    parts.push(stored as typeof part)
    changed = true
  }
  return changed ? { ...message, parts } : message
}

export interface SessionAssetSearchHit {
  assetId: string
  contentHash: string
  filename: string
  segment: AttachmentSegment
  processor: AttachmentExtractedContent["processor"]
  status: AttachmentExtractedContent["status"]
  score: number
  /** Character offsets in the original segment; its page/time/sheet locator is preserved. */
  sourceStart: number
  sourceEnd: number
  fullTextLength: number
  truncated: boolean
}

interface AssetSearchIndex {
  signature: string
  index: BM25Index
  segments: Map<
    string,
    Omit<
      SessionAssetSearchHit,
      "score" | "sourceStart" | "sourceEnd" | "fullTextLength" | "truncated"
    >
  >
}
const searchIndexes = new WeakMap<ReturnType<typeof getDb>, Map<string, AssetSearchIndex>>()

export type AttachmentSearchAsset = Pick<
  SessionAsset,
  "assetId" | "filename" | "contentHash" | "extractedContent"
>
export interface AttachmentSearchOptions {
  tokenBudget?: number
  topK?: number
  includeUnmatched?: boolean
}
export interface AttachmentSearchResult {
  strategy: "bm25"
  hits: SessionAssetSearchHit[]
  budget: { limit: number; used: number; truncated: boolean }
}

function buildAttachmentSearchIndex(
  assets: readonly AttachmentSearchAsset[],
  signature = ""
): AssetSearchIndex {
  const built: AssetSearchIndex = { signature, index: new BM25Index(), segments: new Map() }
  for (const asset of assets) {
    const extraction = asset.extractedContent
    if (!extraction) continue
    for (const segment of extraction.segments) {
      if (!segment.text.trim()) continue
      const id = JSON.stringify([asset.assetId, segment.id])
      built.index.addDocument(id, segment.text)
      built.segments.set(id, {
        assetId: asset.assetId,
        contentHash: asset.contentHash,
        filename: asset.filename,
        segment,
        processor: extraction.processor,
        status: extraction.status,
      })
    }
  }
  return built
}

/** Pure bounded selection, also used before a new conversation has a session id. */
export function searchAttachmentSegments(
  assets: readonly AttachmentSearchAsset[],
  query: string,
  options: AttachmentSearchOptions = {}
): AttachmentSearchResult {
  return searchAssetIndex(buildAttachmentSearchIndex(assets), query, options)
}

/** Local keyword retrieval over every extracted segment, with exact source locators. */
export async function searchSessionAssets(
  sessionId: string,
  query: string,
  options: AttachmentSearchOptions = {}
): Promise<AttachmentSearchResult> {
  const db = getDb()
  const assets = await listSessionAssets(sessionId)
  if (getDb() !== db) throw new SessionAssetError("session_asset_scope_changed")
  let indexes = searchIndexes.get(db)
  if (!indexes) {
    indexes = new Map()
    searchIndexes.set(db, indexes)
  }
  const signature = JSON.stringify(
    assets.map((row) => [row.assetId, row.contentHash, row.revision, row.temporary])
  )
  let cached = indexes.get(sessionId)
  if (!cached || cached.signature !== signature) {
    cached = buildAttachmentSearchIndex(assets, signature)
  }
  indexes.delete(sessionId)
  indexes.set(sessionId, cached)
  while (indexes.size > 4) indexes.delete(indexes.keys().next().value!)
  return searchAssetIndex(cached, query, options)
}

function searchAssetIndex(
  cached: AssetSearchIndex,
  query: string,
  options: AttachmentSearchOptions
): AttachmentSearchResult {
  const limit = Number.isFinite(options.tokenBudget)
    ? Math.max(0, Math.floor(options.tokenBudget!))
    : 1_800
  const topK = Number.isFinite(options.topK)
    ? Math.min(100, Math.max(0, Math.floor(options.topK!)))
    : 8
  const empty = {
    strategy: "bm25" as const,
    hits: [],
    budget: { limit, used: 0, truncated: false },
  }
  if ((!query.trim() && !options.includeUnmatched) || !limit || !topK) return empty
  const matches = cached.index.search(query, cached.segments.size)
  const matchedIds = new Set(matches.map((match) => match.id))
  const ranked = options.includeUnmatched
    ? [
        ...matches,
        ...[...cached.segments.keys()]
          .filter((id) => !matchedIds.has(id))
          .map((id) => ({ id, score: 0 })),
      ]
    : matches
  const counter = createContextManager({ maxTokens: limit })
  const hits: SessionAssetSearchHit[] = []
  const terms = [...new Set(tokenizeMultilingual(query))].sort((a, b) => b.length - a.length)
  for (const match of ranked) {
    if (hits.length >= topK) break
    const source = cached.segments.get(match.id)
    if (!source) continue
    const fullText = source.segment.text
    const lower = fullText.toLowerCase()
    const anchor = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0
    const excerpt = (length: number): SessionAssetSearchHit => {
      let start =
        length >= fullText.length
          ? 0
          : Math.max(0, Math.min(anchor - Math.floor(length / 3), fullText.length - length))
      let end = Math.min(fullText.length, start + length)
      // Never return half a surrogate pair while offsets still refer to source UTF-16 indices.
      if (start > 0 && /[\uDC00-\uDFFF]/.test(fullText[start]!)) start += 1
      if (end < fullText.length && /[\uD800-\uDBFF]/.test(fullText[end - 1]!)) end -= 1
      return {
        ...source,
        score: match.score,
        sourceStart: start,
        sourceEnd: end,
        fullTextLength: fullText.length,
        truncated: start > 0 || end < fullText.length,
        segment: { ...source.segment, text: fullText.slice(start, end) },
      }
    }
    // Search over at most the response budget, never stringify an entire huge page.
    let low = 1
    let high = Math.min(fullText.length, limit * 4)
    let selected: SessionAssetSearchHit | undefined
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const hit = excerpt(mid)
      if (hit.segment.text && counter.estimateTokens(JSON.stringify([...hits, hit])) <= limit) {
        selected = hit
        low = mid + 1
      } else high = mid - 1
    }
    if (selected) hits.push(selected)
  }
  return {
    strategy: "bm25",
    hits: structuredClone(hits),
    budget: {
      limit,
      used: hits.length ? counter.estimateTokens(JSON.stringify(hits)) : 0,
      truncated:
        hits.length < ranked.length ||
        hits.some(
          (hit) =>
            hit.sourceStart > 0 ||
            hit.sourceEnd <
              (cached.segments.get(JSON.stringify([hit.assetId, hit.segment.id]))?.segment.text
                .length ?? 0)
        ),
    },
  }
}
