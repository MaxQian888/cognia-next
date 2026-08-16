import { collectOrphanedMedia, parseMediaRef } from "./message-media"
import { getDb } from "./schema"

export interface MessageMediaRefRow {
  messageId: string
  sessionId: string
  hash: string
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
  const referencedHashes = new Set(await db.messageMediaRefs.orderBy("hash").uniqueKeys())
  if (candidates) {
    const allowed = new Set<string>()
    for (const candidate of candidates) allowed.add(parseMediaRef(candidate) ?? candidate)
    await db.messageMedia.each((row) => {
      if (!allowed.has(row.hash)) referencedHashes.add(row.hash)
    })
  }
  return collectOrphanedMedia(
    [...referencedHashes].map((hash) => `cognia-media:${String(hash)}`),
    options
  )
}
