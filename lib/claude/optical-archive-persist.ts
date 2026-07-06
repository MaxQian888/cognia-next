// Bridge from the `compact_boundary` event to the Dexie optical-archive store
// (ADR-0063). Kept out of the pure `adapter.ts` reducer: this is a best-effort,
// browser-only side effect (mirroring how `pre_messages` routes to the in-memory
// undo registry). The Dexie module is dynamically imported so `adapter.ts` stays
// free of a DB dependency and safe to import under SSR / tests.

import type { OpticalArchiveFrame } from "@/lib/db/optical-archives"

/** The `compact_metadata.optical` shape the sidecar emits (see ai-sdk.mjs). */
export interface OpticalBoundaryMeta {
  sessionId?: string
  frameCount?: number
  frames?: OpticalArchiveFrame[]
  size?: number
  shape?: Record<string, unknown>
  coverage?: number
  readability?: number
  charCount?: number
  estImageTokens?: number
  estTextTokens?: number
  byteLength?: number
}

/** Render a pre-compaction message snapshot to plain text for on-demand reveal. */
export function renderSnapshotToText(preMessages: unknown[] | undefined): string | undefined {
  if (!Array.isArray(preMessages) || preMessages.length === 0) return undefined
  const blocks: string[] = []
  for (const m of preMessages) {
    const msg = m as { role?: string; content?: unknown }
    const role = typeof msg?.role === "string" ? msg.role : "?"
    const text = extractText(msg?.content)
    if (text.trim()) blocks.push(`${role}: ${text}`)
  }
  return blocks.length ? blocks.join("\n\n") : undefined
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const out: string[] = []
  for (const part of content) {
    if (typeof part === "string") out.push(part)
    else if (part && typeof (part as { text?: unknown }).text === "string") {
      out.push((part as { text: string }).text)
    }
  }
  return out.join("")
}

/**
 * Persist one optical-compaction boundary. Best-effort and non-blocking: on any
 * failure (no browser DB, quota, etc.) it silently no-ops so a rendering issue
 * never breaks the transcript. Returns the archive id it will write under (the
 * boundary id) so the caller can reference it, or undefined when there is no
 * optical payload to persist.
 */
export function persistOpticalArchive(
  id: string,
  meta: {
    strategy?: string
    pre_tokens?: number
    post_tokens?: number
    pre_messages?: unknown[]
    optical?: OpticalBoundaryMeta
  }
): string | undefined {
  const optical = meta?.optical
  if (!optical || !optical.sessionId || !Array.isArray(optical.frames)) return undefined
  if (typeof window === "undefined") return id

  const row = {
    id,
    sessionId: optical.sessionId,
    createdAt: Date.now(),
    strategy: meta.strategy ?? "optical",
    preTokens: meta.pre_tokens ?? 0,
    postTokens: meta.post_tokens ?? 0,
    frameCount: optical.frameCount ?? optical.frames.length,
    frames: optical.frames,
    shape: optical.shape,
    coverage: optical.coverage,
    readability: optical.readability,
    charCount: optical.charCount,
    estImageTokens: optical.estImageTokens,
    estTextTokens: optical.estTextTokens,
    byteLength: optical.byteLength,
    originalText: renderSnapshotToText(meta.pre_messages),
  }
  __TESTING__.lastWrite = (async () => {
    try {
      const { saveOpticalArchive } = await import("@/lib/db/optical-archives")
      await saveOpticalArchive(row)
    } catch {
      /* best-effort: a persistence failure must not affect the live transcript */
    }
  })()
  return id
}

/** The most recent fire-and-forget write promise, so tests can await it. */
export const __TESTING__: { lastWrite: Promise<void> | null } = { lastWrite: null }
