/**
 * Capture manager — turns a confirmed {@link CaptureCandidate} into a persisted
 * {@link CapturedItem}: dedup by fingerprint, enrich (URL reader / OCR), save.
 * Deps injected for tests; production callers pass {@link buildEnrichDeps}.
 */

import { findCapturedByFingerprint, saveCapturedItem } from "@/lib/db/captured-items"
import { enrichCandidate, buildEnrichDeps, type EnrichDeps } from "./enrich"
import type { CaptureCandidate, CapturedItem, CaptureKind } from "@/types/capture"

export interface CapturePersistedEvent {
  captureId: string
  kind: CaptureKind
  capturedAt: number
}

export type CapturePersistedListener = (event: CapturePersistedEvent) => void

const persistedListeners = new Set<CapturePersistedListener>()

/** Subscribe to content-free capture milestones for first-party integrations. */
export function subscribeCapturePersisted(listener: CapturePersistedListener): () => void {
  persistedListeners.add(listener)
  return () => persistedListeners.delete(listener)
}

function emitCapturePersisted(event: CapturePersistedEvent): void {
  for (const listener of persistedListeners) {
    try {
      listener(event)
    } catch {
      // Capture persistence must not fail because an observer failed.
    }
  }
}

function newCaptureId(now: number): string {
  return `cap_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface PersistCaptureOptions {
  deps?: EnrichDeps
  now?: number
}

/**
 * Persist a confirmed candidate. Returns the saved item, or `null` when it was
 * a duplicate (an earlier capture with the same fingerprint already exists).
 */
export async function persistCapture(
  candidate: CaptureCandidate,
  opts: PersistCaptureOptions = {}
): Promise<CapturedItem | null> {
  const existing = await findCapturedByFingerprint(candidate.fingerprint)
  if (existing) return null

  const deps = opts.deps ?? buildEnrichDeps()
  const now = opts.now ?? Date.now()
  const enrichment = await enrichCandidate(candidate, deps)

  const item: CapturedItem = {
    id: newCaptureId(now),
    kind: candidate.kind,
    ...(candidate.text ? { text: candidate.text } : {}),
    ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
    ...(candidate.sourceApp ? { sourceApp: candidate.sourceApp } : {}),
    capturedAt: now,
    ...(enrichment ? { enrichment } : {}),
    fingerprint: candidate.fingerprint,
  }
  await saveCapturedItem(item)
  emitCapturePersisted({ captureId: item.id, kind: item.kind, capturedAt: item.capturedAt })
  return item
}

/**
 * Best-effort foreground/source-app name via the Tauri `get_foreground_app`
 * command. Returns undefined off Tauri or on any failure.
 */
export async function detectSourceApp(): Promise<string | undefined> {
  try {
    const { isTauri } = await import("@/lib/native/utils")
    if (!isTauri()) return undefined
    const { invoke } = await import("@tauri-apps/api/core")
    const res = await invoke<{ name?: string } | null>("get_foreground_app")
    return res?.name || undefined
  } catch {
    return undefined
  }
}
