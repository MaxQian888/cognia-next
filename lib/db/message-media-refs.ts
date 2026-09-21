import { collectOrphanedMedia, parseMediaRef } from "./message-media"
import { getDb } from "./schema"
import type { SessionAsset } from "./session-assets"

/** Reserved ledger owners are never chat message ids. */
export const SESSION_ASSET_OWNER_PREFIX = "session-asset:"

export interface MessageMediaRefRow {
  messageId: string
  sessionId: string
  hash: string
  /** Session-owned sources survive message replacement and transcript clearing. */
  sessionAsset?: SessionAsset
}

export function isMessageOwnedMediaRef(row: MessageMediaRefRow): boolean {
  return row.sessionAsset === undefined
}

function visitMediaRefs(value: unknown, hashes: Set<string>, key?: string): void {
  if (typeof value === "string") {
    if (key === "text") return
    const hash = parseMediaRef(value)
    if (hash) hashes.add(hash)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) visitMediaRefs(entry, hashes)
    return
  }
  if (!value || typeof value !== "object") return
  for (const [childKey, child] of Object.entries(value)) visitMediaRefs(child, hashes, childKey)
}

export function collectMessageMediaHashes(parts: unknown): string[] {
  const hashes = new Set<string>()
  visitMediaRefs(parts, hashes)
  return [...hashes]
}

export function messageMediaRefRows(
  messageId: string,
  sessionId: string,
  parts: unknown
): MessageMediaRefRow[] {
  if (messageId.startsWith(SESSION_ASSET_OWNER_PREFIX)) {
    throw new Error("reserved_session_asset_owner")
  }
  return collectMessageMediaHashes(parts).map((hash) => ({ messageId, sessionId, hash }))
}

export async function listMessageMediaRefsForSession(
  sessionId: string
): Promise<MessageMediaRefRow[]> {
  return getDb().messageMediaRefs.where("sessionId").equals(sessionId).toArray()
}

export async function isMessageMediaReferencedBySession(
  sessionId: string,
  refOrHash: string
): Promise<boolean> {
  const hash = parseMediaRef(refOrHash) ?? refOrHash
  return (
    (await getDb().messageMediaRefs.where("[sessionId+hash]").equals([sessionId, hash]).count()) > 0
  )
}

export async function collectUnreferencedMessageMedia(
  candidates?: Iterable<string>,
  options?: { graceMs?: number; now?: number }
): Promise<number> {
  const db = getDb()
  if (candidates) {
    const hashes = [
      ...new Set(Array.from(candidates, (candidate) => parseMediaRef(candidate) ?? candidate)),
    ]
    if (hashes.length === 0) return 0
    const { graceMs = 60_000, now = Date.now() } = options ?? {}

    return db.transaction("rw", db.messageMediaRefs, db.messageMedia, async () => {
      // Keep the reference check and deletion atomic while reading only candidate blobs.
      const referencedHashes = new Set(
        await db.messageMediaRefs.where("hash").anyOf(hashes).uniqueKeys()
      )
      const rows = await db.messageMedia.bulkGet(
        hashes.filter((hash) => !referencedHashes.has(hash))
      )
      const doomed: string[] = []
      for (const row of rows) {
        if (!row || now - row.createdAt < graceMs) continue
        doomed.push(row.hash)
      }
      if (doomed.length > 0) await db.messageMedia.bulkDelete(doomed)
      return doomed.length
    })
  }
  const referencedHashes = await db.messageMediaRefs.orderBy("hash").uniqueKeys()
  return collectOrphanedMedia(
    [...referencedHashes].map((hash) => `cognia-media:${String(hash)}`),
    options
  )
}
