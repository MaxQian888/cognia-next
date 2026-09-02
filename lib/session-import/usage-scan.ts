// Generic incremental usage scan over any `AgentSessionSourceAdapter`.
//
// The point of this module is that all eleven first-party sources get external
// spend indexing WITHOUT eleven adapter edits. An adapter that can do better
// implements `scanUsage` and this driver steps aside (see the seam in
// `types.ts`). Everything else is read through the two methods every adapter
// already has, `listSessions` + `parseSession`, under strict bounds.
//
// Three properties the rest of the subsystem depends on:
//
//   * PER-LOCATOR ISOLATION. A transcript that fails to read or parse is
//     counted and skipped. One corrupt file never sinks a scan, and never
//     silently truncates a total either, because `failed` reaches the source
//     state and the source is then labelled degraded rather than fresh.
//   * RESUMABILITY. A batch stops on any bound and returns the cursor to
//     resume from. Only a `null` cursor means "read to the end", which is the
//     single condition under which the caller may delete rows for sessions
//     that have vanished upstream.
//   * NAMESPACED IDENTITY. Two tools can and do use the same message ids.
//     Row keys are namespaced by source, so indexing Codex cannot overwrite
//     rows Claude Code produced.

import { deriveImportedUsageRows } from "./usage"
import type {
  AgentSessionSourceAdapter,
  SessionScanInput,
  SessionSummary,
  UsageScanBatch,
  UsageScanQuery,
} from "./types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

/** Bounds a scan falls back to when the caller names none. */
export const DEFAULT_USAGE_SCAN_QUERY: Required<Pick<UsageScanQuery, "maxRows" | "maxSessions">> = {
  maxRows: 250,
  maxSessions: 60,
}

/** Deterministic ledger key for one external turn. */
export function externalUsageMessageId(
  sourceId: string,
  sourceSessionId: string,
  messageId: string
): string {
  return `ext:${sourceId}:${sourceSessionId}:${messageId}`
}

/** Deterministic grouping key for one external session. */
export function externalUsageSessionId(sourceId: string, sourceSessionId: string): string {
  return `ext:${sourceId}:${sourceSessionId}`
}

/**
 * Digest of a locator set. Built from identity plus the two cheap properties
 * that change when content does (size proxy via message count, and last
 * activity). Never hashes content, so this value is safe to persist and to
 * ship to an ambient surface.
 */
export function fingerprintSummaries(summaries: readonly SessionSummary[]): string {
  let h = 2166136261
  const fold = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  const ordered = [...summaries].sort((a, b) =>
    a.ref.originalSessionId < b.ref.originalSessionId ? -1 : 1
  )
  for (const s of ordered) {
    fold(s.ref.originalSessionId)
    fold(String(s.messageCount))
    fold(String(s.updatedAt))
    fold(s.watchRevision ?? "")
  }
  return (h >>> 0).toString(36)
}

/**
 * Stamp a derived row with its provenance and namespace its keys.
 *
 * `imported: true` is set unconditionally. External spend was paid in another
 * agent, on another account, and the ledger's budget predicate keys off
 * exactly this flag, so a row that reached the table without it would inflate
 * the user's Cognia budget with another tool's bill.
 */
export function stampExternalRow(
  row: SessionUsageRow,
  meta: { sourceId: string; sourceSessionId: string; sourceRevision?: string }
): SessionUsageRow {
  return {
    ...row,
    messageId: externalUsageMessageId(meta.sourceId, meta.sourceSessionId, row.messageId),
    sessionId: externalUsageSessionId(meta.sourceId, meta.sourceSessionId),
    surface: "imported",
    imported: true,
    sourceId: meta.sourceId,
    sourceSessionId: meta.sourceSessionId,
    ...(meta.sourceRevision ? { sourceRevision: meta.sourceRevision } : {}),
    // The transcript is what the provider wrote, so the tokens are derived
    // from a provider record rather than measured by us or guessed.
    usageBasis: "derived",
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Read one bounded slice of a source's usage history.
 *
 * `cursor` is the `originalSessionId` the previous batch stopped before. The
 * summary list is ordered deterministically (newest first, id as tiebreak) so
 * resuming from a cursor visits each locator exactly once even when the
 * underlying directory listing is unordered.
 */
export async function scanSourceUsage(
  adapter: AgentSessionSourceAdapter,
  input: SessionScanInput,
  query: UsageScanQuery = {},
  cursor: string | null = null
): Promise<UsageScanBatch> {
  const empty: UsageScanBatch = { rows: [], cursor: null, parsed: 0, failed: 0, truncated: false }

  // A picker-only source has no machine-wide location to walk. Declaring that
  // is what stops the UI from reading "no spend" off a source it never had a
  // chance to read (see `AgentSessionSourceAdapter.pickerOnly`).
  if (adapter.pickerOnly && !input.pickedFiles?.length) return empty
  if (aborted(query.signal)) return { ...empty, truncated: true, degradedReason: "aborted" }

  if (adapter.scanUsage) return adapter.scanUsage(input, query, cursor)

  const maxRows = query.maxRows ?? DEFAULT_USAGE_SCAN_QUERY.maxRows
  const maxSessions = query.maxSessions ?? DEFAULT_USAGE_SCAN_QUERY.maxSessions

  let summaries: SessionSummary[]
  try {
    summaries = await adapter.listSessions(input)
  } catch {
    // The root is gone, unreadable, or the vendor changed its layout. Keeping
    // whatever rows we already hold and reporting the degradation is strictly
    // better than reporting zero spend.
    return { ...empty, degradedReason: "root-missing", truncated: true }
  }

  const fingerprint = fingerprintSummaries(summaries)
  const ordered = [...summaries].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return a.ref.originalSessionId < b.ref.originalSessionId ? -1 : 1
  })

  let start = 0
  if (cursor) {
    const at = ordered.findIndex((s) => s.ref.originalSessionId === cursor)
    // A cursor whose session vanished restarts the source rather than silently
    // skipping everything after it.
    start = at >= 0 ? at : 0
  }

  const rows: SessionUsageRow[] = []
  let parsed = 0
  let failed = 0
  let visited = 0
  let index = start

  for (; index < ordered.length; index += 1) {
    if (aborted(query.signal)) {
      return {
        rows,
        cursor: ordered[index]?.ref.originalSessionId ?? null,
        parsed,
        failed,
        truncated: true,
        degradedReason: "aborted",
        fingerprint,
      }
    }
    if (visited >= maxSessions || rows.length >= maxRows) {
      return {
        rows,
        cursor: ordered[index].ref.originalSessionId,
        parsed,
        failed,
        truncated: true,
        degradedReason: "budget",
        fingerprint,
      }
    }

    const summary = ordered[index]
    if (query.sinceMs != null && summary.updatedAt < query.sinceMs) {
      // Ordered newest-first, so the first stale locator ends the useful work.
      // Returning a null cursor is correct: everything newer was read.
      break
    }
    visited += 1

    let derived: SessionUsageRow[]
    try {
      const conversation = await adapter.parseSession(summary.ref, input)
      derived = deriveImportedUsageRows(conversation.messages, {
        fallbackModel: conversation.session.model,
      })
    } catch {
      failed += 1
      continue
    }
    parsed += 1
    for (const row of derived) {
      rows.push(
        stampExternalRow(row, {
          sourceId: adapter.id,
          sourceSessionId: summary.ref.originalSessionId,
          sourceRevision: summary.watchRevision,
        })
      )
    }
  }

  return {
    rows,
    cursor: null,
    parsed,
    failed,
    truncated: false,
    ...(failed > 0 ? { degradedReason: "read-failed" as const } : {}),
    fingerprint,
  }
}
