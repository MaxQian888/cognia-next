/**
 * Idempotency + provenance CRUD for message-shortcut imports
 * (Dexie v126, plan 2026-07-24 Phase 5).
 *
 * `sourceHash` (unique) is the replay key: the same selection imported twice
 * returns the original session instead of creating a duplicate task.
 */

import type { LarkMessageImportRow } from "./connector-types"
import { getDb } from "./schema"

/** Stable web-crypto hash over the import selection. */
export async function computeImportSourceHash(
  adapterId: string,
  chatId: string,
  messageIds: string[]
): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("computeImportSourceHash: Web Crypto unavailable")
  const canonical = `${adapterId}${chatId}${[...messageIds].sort().join(",")}`
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export async function findImportBySourceHash(
  sourceHash: string
): Promise<LarkMessageImportRow | undefined> {
  return getDb().larkMessageImports.where("sourceHash").equals(sourceHash).first()
}

export interface RecordMessageImportInput {
  sourceHash: string
  adapterId: string
  chatId: string
  conversationKey: string
  sessionId: string
  messageIds: string[]
  skipped?: Array<{ messageId: string; reason: string }>
  now?: number
}

export async function recordMessageImport(
  input: RecordMessageImportInput
): Promise<LarkMessageImportRow> {
  const row: LarkMessageImportRow = {
    id: "lmi_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    sourceHash: input.sourceHash,
    adapterId: input.adapterId,
    chatId: input.chatId,
    conversationKey: input.conversationKey,
    sessionId: input.sessionId,
    messageIds: input.messageIds,
    skipped: input.skipped,
    createdAt: input.now ?? Date.now(),
  }
  await getDb().larkMessageImports.add(row)
  return row
}
