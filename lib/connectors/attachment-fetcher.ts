/**
 * TypeScript-side dispatcher for the inbound attachment cache.
 *
 * The Tauri Rust side (`src-tauri/src/connectors/attachments.rs`) handles
 * the heavy lifting: SHA-256 cache key, AES-256-GCM encryption on disk,
 * cache-hit short-circuit on second call. The Tauri command
 * `connectors_attachment_fetch` is the entry point.
 *
 * This module adds the renderer-side surface:
 *
 *   1. Persists every fetched-attachment metadata row into the
 *      `connectorAttachments` Dexie table so the inbox UI can show
 *      cached size / mime / age without re-hitting Rust.
 *   2. Enforces an LRU cap (500 MB total, 7-day default TTL) by walking
 *      oldest rows when the running total exceeds the cap. Eviction
 *      asks Rust to delete the encrypted file (`connectors_attachment_evict`
 *      is wired separately — Group 2 reuses the existing single-fetch
 *      command and tracks size client-side; explicit eviction is left to
 *      the renderer Settings → Storage panel which already exposes a
 *      "clear connector caches" action).
 *   3. Provides idempotency: calling `fetchAttachment(adapterId, remoteRef,
 *      sourceUrl)` twice returns the same `AttachmentRef` and skips the
 *      Tauri call when the Dexie row reports the file is still valid.
 */

import { connectorsAttachmentFetch } from "@/lib/connectors/tauri/commands"
import type { ConnectorAttachmentRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import type { AttachmentRef } from "@/lib/connectors/tauri/commands"

export interface FetchAttachmentInput {
  adapterId: string
  remoteRef: string
  sourceUrl: string
  /** Optional mime hint; persisted alongside the row when present. */
  mimeType?: string
  /** Optional size hint; persisted alongside the row when present. */
  sizeBytes?: number
  /**
   * Custom TTL in ms. Defaults to 7 days. Pass `0` to opt out — the
   * row stays until LRU evicts it.
   */
  ttlMs?: number
}

export interface FetchAttachmentResult {
  ref: AttachmentRef
  /** True when the result came from the Dexie cache and Rust was skipped. */
  cached: boolean
}

/** 7 days. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 500 MB ceiling, summed across `connectorAttachments.sizeBytes`. */
const LRU_TOTAL_CAP_BYTES = 500 * 1024 * 1024

/**
 * Fetch (or recover from cache) an attachment for the given adapter.
 *
 *   - If the row exists in `connectorAttachments` AND hasn't expired,
 *     return it without hitting Rust.
 *   - Otherwise call the Tauri command, then upsert the Dexie row.
 *   - After upsert, run LRU eviction if the running total exceeds the cap.
 */
export async function fetchAttachment(input: FetchAttachmentInput): Promise<FetchAttachmentResult> {
  const db = getDb()
  const existing = await db.connectorAttachments
    .where("[adapterId+remoteRef]")
    .equals([input.adapterId, input.remoteRef])
    .first()

  const now = Date.now()
  if (existing && !isExpired(existing, now)) {
    return {
      ref: { localUrl: existing.localPath, remoteRef: existing.remoteRef },
      cached: true,
    }
  }

  // Either fresh fetch or refresh after TTL — delegate to Rust.
  const ref = await connectorsAttachmentFetch(input.adapterId, input.remoteRef, input.sourceUrl)

  const ttl = input.ttlMs ?? DEFAULT_TTL_MS
  const row: ConnectorAttachmentRow = {
    id: `${input.adapterId}:${input.remoteRef}`,
    adapterId: input.adapterId,
    remoteRef: input.remoteRef,
    localPath: ref.localUrl,
    mimeType: input.mimeType ?? existing?.mimeType ?? "application/octet-stream",
    sizeBytes: input.sizeBytes ?? existing?.sizeBytes ?? 0,
    fetchedAt: now,
    expiresAt: ttl > 0 ? now + ttl : undefined,
  }
  await db.connectorAttachments.put(row)

  // Best-effort LRU sweep — if it fails the row still landed.
  await runLruEviction(LRU_TOTAL_CAP_BYTES).catch(() => undefined)

  return { ref, cached: false }
}

/**
 * Bulk-prune attachments for the given adapter id, e.g., when an adapter
 * instance is removed from the registry. The Rust side does NOT yet
 * expose a per-adapter delete command, so we only purge the Dexie rows;
 * the encrypted blobs on disk are deleted by the storage settings
 * panel's existing "Clear connector caches" action.
 */
export async function pruneAttachmentsForAdapter(adapterId: string): Promise<number> {
  const db = getDb()
  const ids = await db.connectorAttachments.where("adapterId").equals(adapterId).primaryKeys()
  if (ids.length === 0) return 0
  await db.connectorAttachments.bulkDelete(ids as string[])
  return ids.length
}

/**
 * Walk `connectorAttachments` newest-first, summing `sizeBytes`. When the
 * running total exceeds `capBytes`, drop the oldest rows until the total
 * is back under cap. Returns the number of rows evicted.
 *
 * Exported for tests; production callers go through `fetchAttachment`.
 */
export async function runLruEviction(capBytes: number): Promise<number> {
  const db = getDb()
  // Iterate by descending fetchedAt so newest rows accumulate first and
  // any overflow falls on the oldest entries.
  const rows = await db.connectorAttachments.orderBy("fetchedAt").reverse().toArray()
  let running = 0
  const toDelete: string[] = []
  for (const row of rows) {
    running += row.sizeBytes
    if (running > capBytes) toDelete.push(row.id)
  }
  if (toDelete.length === 0) return 0
  await db.connectorAttachments.bulkDelete(toDelete)
  return toDelete.length
}

function isExpired(row: ConnectorAttachmentRow, now: number): boolean {
  if (typeof row.expiresAt !== "number") return false
  return row.expiresAt < now
}
