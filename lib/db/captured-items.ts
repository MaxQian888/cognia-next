/**
 * CRUD layer for the `capturedItems` Dexie table (v97) — the content-capture
 * store. Written by `lib/capture/capture-store.ts` on confirm; read by the
 * Attention Radar (`listCapturedItemsSince`) and a future capture history UI.
 */

import type { CapturedItem } from "@/types/capture"
import { getDb } from "./schema"

export async function saveCapturedItem(item: CapturedItem): Promise<void> {
  await getDb().capturedItems.put(item)
}

export async function getCapturedItem(id: string): Promise<CapturedItem | undefined> {
  return getDb().capturedItems.get(id)
}

/** Look up an existing item by dedup fingerprint (null when none). */
export async function findCapturedByFingerprint(
  fingerprint: string
): Promise<CapturedItem | undefined> {
  return getDb().capturedItems.where("fingerprint").equals(fingerprint).first()
}

/** Items captured at/after `cutoff` (epoch ms), newest first. */
export async function listCapturedItemsSince(cutoff: number): Promise<CapturedItem[]> {
  return getDb()
    .capturedItems.where("capturedAt")
    .aboveOrEqual(cutoff)
    .reverse()
    .sortBy("capturedAt")
}

export async function listCapturedItems(limit = 100): Promise<CapturedItem[]> {
  return getDb().capturedItems.orderBy("capturedAt").reverse().limit(limit).toArray()
}

export async function deleteCapturedItem(id: string): Promise<void> {
  await getDb().capturedItems.delete(id)
}
