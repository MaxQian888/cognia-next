// Per-source scan state for the external usage index (ADR-0165 Phase 0).
//
// DERIVED, LOCAL-ONLY, REBUILDABLE. One row per `AgentSessionSourceAdapter.id`
// recording how far the incremental usage scanner got and why it stopped. It
// is the difference between "this tool has no spend" and "we could not read
// this tool", two states that look identical without it. The ambient surfaces
// (tray title, Capacity Dock) must never present the second as the first.
//
// PRIVACY: this table stores NOTHING derived from session content. No prompt,
// no command, no file path, no title, no credential. The coverage window is a
// pair of epoch timestamps and the corpus fingerprint is a hash of
// (locator length, byte size, mtime) triples. See `lib/session-import/usage-scan.ts`.

import { getDb } from "./schema"

/** Why the last scan of a source ended the way it did. */
export type UsageSourceStatus =
  /** Never scanned on this install. */
  | "unknown"
  /** The last scan read every locator the source exposes. */
  | "fresh"
  /** The last scan completed, but the source root is gone or unreadable. */
  | "unavailable"
  /** The last scan was cut short (budget, abort, or per-file failures). */
  | "partial"
  /** The source declared itself picker-only, so there is nothing to walk. */
  | "picker-only"

export interface UsageSourceStateRow {
  /** Adapter id, i.e. `AgentSessionSourceAdapter.id`. Primary key. */
  sourceId: string
  status: UsageSourceStatus
  /**
   * Parser version this state was produced by. A bump invalidates every
   * cursor so the next scan re-reads the corpus instead of trusting rows
   * an older parser wrote.
   */
  parserVersion: number
  /**
   * Content-addressed digest of the locator set (never of the content). A
   * changed fingerprint means files appeared, vanished, or grew, so the
   * scanner may not shortcut on `lastScanAt`.
   */
  corpusFingerprint: string
  /** Oldest / newest turn timestamp the index currently holds for this source. */
  coverageFromMs: number | null
  coverageToMs: number | null
  /** Locators successfully parsed / skipped-on-error in the last scan. */
  parsedCount: number
  failedCount: number
  /** Usage rows the index currently holds for this source. */
  rowCount: number
  /** Epoch ms of the last scan attempt, and of the last one that read everything. */
  lastScanAt: number
  lastSuccessAt: number | null
  /**
   * Resume point for a scan a bound cut short, or `null` when the source was
   * read to the end. Cleared whenever `parserVersion` or `corpusFingerprint`
   * changes, because a cursor into an older parse is not a cursor into this one.
   */
  cursor?: string | null
  /**
   * Coarse, non-identifying reason a scan degraded ("root-missing",
   * "read-failed", "aborted", "budget"). Never a path or an OS message.
   */
  degradedReason?: string
}

/** Bumped whenever the scan/parse contract changes shape. */
export const USAGE_SCAN_PARSER_VERSION = 1

export function emptyUsageSourceState(sourceId: string): UsageSourceStateRow {
  return {
    sourceId,
    status: "unknown",
    parserVersion: USAGE_SCAN_PARSER_VERSION,
    corpusFingerprint: "",
    coverageFromMs: null,
    coverageToMs: null,
    parsedCount: 0,
    failedCount: 0,
    rowCount: 0,
    lastScanAt: 0,
    lastSuccessAt: null,
  }
}

export async function getUsageSourceState(sourceId: string): Promise<UsageSourceStateRow | null> {
  if (!sourceId) return null
  return (await getDb().usageSourceStates.get(sourceId)) ?? null
}

export async function listUsageSourceStates(): Promise<UsageSourceStateRow[]> {
  return getDb().usageSourceStates.toArray()
}

export async function putUsageSourceState(row: UsageSourceStateRow): Promise<void> {
  if (!row.sourceId) return
  await getDb().usageSourceStates.put(row)
}

/**
 * Merge a partial update into a source's state, creating it when absent.
 * Returns the committed row so callers can report without a second read.
 */
export async function updateUsageSourceState(
  sourceId: string,
  patch: Partial<Omit<UsageSourceStateRow, "sourceId">>
): Promise<UsageSourceStateRow | null> {
  if (!sourceId) return null
  const db = getDb()
  let committed: UsageSourceStateRow | null = null
  await db.transaction("rw", db.usageSourceStates, async () => {
    const prior = (await db.usageSourceStates.get(sourceId)) ?? emptyUsageSourceState(sourceId)
    committed = { ...prior, ...patch, sourceId }
    await db.usageSourceStates.put(committed)
  })
  return committed
}

/** Drop one source's state (used when a plugin source unregisters). */
export async function deleteUsageSourceState(sourceId: string): Promise<void> {
  if (!sourceId) return
  await getDb().usageSourceStates.delete(sourceId)
}

/**
 * Freshness of a set of source states, as the ambient surfaces label it.
 * `fresh` only when every scanned source read everything, `partial` when at
 * least one source is degraded but some data exists, and `stale` when nothing
 * has ever been scanned.
 */
export function foldSourceFreshness(
  states: readonly UsageSourceStateRow[]
): "fresh" | "stale" | "partial" {
  const scannable = states.filter((s) => s.status !== "picker-only")
  if (scannable.length === 0) return "stale"
  if (scannable.every((s) => s.status === "unknown")) return "stale"
  return scannable.every((s) => s.status === "fresh") ? "fresh" : "partial"
}
