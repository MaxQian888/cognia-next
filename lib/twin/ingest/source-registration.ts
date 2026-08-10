import type { TwinSource } from "@/types/twin"
import { createTwinSource, type TwinSourceDraft } from "@/lib/db/twin-sources"
import { getDb } from "@/lib/db/schema"

export async function sourceFingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export interface RegisterTwinSourceResult {
  source: TwinSource
  created: boolean
  revived: boolean
}

/**
 * Canonical Twin source registration seam. Fingerprint lookup and mutation
 * share one transaction so concurrent import paths cannot create duplicate
 * active rows for the same Twin.
 */
export async function registerTwinSource(
  draft: Omit<TwinSourceDraft, "fingerprint"> & { fingerprint?: string }
): Promise<RegisterTwinSourceResult> {
  const fingerprint = draft.fingerprint || (await sourceFingerprint(draft.source))
  const db = getDb()
  return db.transaction("rw", db.twinSources, async () => {
    const existing = await db.twinSources
      .where("[twinId+fingerprint]")
      .equals([draft.twinId, fingerprint])
      .first()
    if (existing && existing.status !== "failed" && existing.status !== "deleted") {
      return { source: existing, created: false, revived: false }
    }
    if (existing) {
      await db.twinSources.update(existing.id, {
        kind: draft.kind,
        format: draft.format,
        source: draft.source,
        title: draft.title,
        bytes: draft.bytes,
        fingerprint,
        status: "pending",
        errorMessage: undefined,
        parsedAt: undefined,
        chunkCount: 0,
        redacted: draft.redacted,
        redactionMapEnc: draft.redactionMapEnc,
        tags: draft.tags,
        speakers: draft.speakers,
      })
      return {
        source: (await db.twinSources.get(existing.id))!,
        created: false,
        revived: true,
      }
    }
    const source = await createTwinSource({ ...draft, fingerprint, status: "pending" })
    return { source, created: true, revived: false }
  })
}
