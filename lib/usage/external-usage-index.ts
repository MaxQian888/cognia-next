// Orchestrator for the external usage index (ADR-0165 Phase 0).
//
// Turns the registry's session sources into indexed `sessionUsage` rows so the
// ambient surfaces can answer "what did I spend across ALL my coding agents
// today". Everything it writes is `imported: true`, so none of it can move a
// Cognia budget.
//
// Scheduling policy, which is deliberately NOT a timer: a scan runs on an
// explicit refresh, on a foreground open of a surface that shows the all-tools
// scope, or when a watched source invalidates. An install whose ambient
// surfaces are all off never scans at all. CodeBurn's unconditional 30-second
// poll is exactly the cost this design refuses to pay.

import {
  getUsageSourceState,
  listUsageSourceStates,
  updateUsageSourceState,
  USAGE_SCAN_PARSER_VERSION,
  type UsageSourceStateRow,
  type UsageSourceStatus,
} from "@/lib/db/usage-source-states"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { getSessionSources } from "@/lib/session-import/registry"
import { scanSourceUsage } from "@/lib/session-import/usage-scan"
import type {
  AgentSessionSourceAdapter,
  SessionScanInput,
  UsageScanQuery,
} from "@/lib/session-import/types"

/** At most two sources are read at once, so a scan never saturates the disk. */
export const USAGE_SCAN_CONCURRENCY = 2

/** How long a `fresh` source is trusted before a refresh re-reads it. */
export const USAGE_SCAN_TTL_MS = 5 * 60_000

/**
 * Bounded batches one refresh will drain from a single source. Beyond this the
 * run stops with a cursor and the source is labelled `partial`, so a huge
 * corpus converges over several refreshes instead of monopolizing one.
 */
export const MAX_BATCHES_PER_REFRESH = 20

export interface ExternalScanOptions {
  /** Restrict the run to these source ids. Defaults to every registered one. */
  sourceIds?: readonly string[]
  /** Ignore the freshness TTL and re-read every source. */
  force?: boolean
  query?: UsageScanQuery
  signal?: AbortSignal
  now?: number
}

export interface ExternalScanSourceResult {
  sourceId: string
  status: UsageSourceStatus
  /** Rows written in this run (a resumed scan reports only its own slice). */
  written: number
  parsed: number
  failed: number
  /** True when the source was read to the end and its rows are authoritative. */
  complete: boolean
  skipped: "fresh" | "picker-only" | null
}

export interface ExternalScanResult {
  sources: ExternalScanSourceResult[]
  startedAt: number
  finishedAt: number
}

/**
 * Whether a source is due for a re-read.
 *
 * A `fresh` source inside its TTL is skipped, which is what makes opening the
 * tray panel repeatedly cost nothing. Anything degraded is always due: a
 * source we failed to read is precisely the one worth retrying.
 */
export function scanDue(state: UsageSourceStateRow | null, now: number, force = false): boolean {
  if (force) return true
  if (!state) return true
  if (state.parserVersion !== USAGE_SCAN_PARSER_VERSION) return true
  if (state.status !== "fresh") return true
  return now - state.lastScanAt >= USAGE_SCAN_TTL_MS
}

/**
 * Persist one batch's rows and, when the scan read the source to the end,
 * retire rows for sessions that no longer exist upstream.
 *
 * The deletion is gated on completeness for a reason. A truncated batch has
 * seen only a slice of the corpus, so "not in this batch" does not mean "gone",
 * and deleting on it would erase most of a source's history on every partial
 * scan.
 */
export async function persistScanRows(
  sourceId: string,
  rows: readonly SessionUsageRow[],
  opts: { complete: boolean }
): Promise<{ written: number; removed: number }> {
  const db = getDb()
  let written = 0
  let removed = 0
  await db.transaction("rw", db.sessionUsage, async () => {
    if (opts.complete) {
      const existing = await db.sessionUsage.where("sourceId").equals(sourceId).primaryKeys()
      const keep = new Set(rows.map((r) => r.messageId))
      const stale = (existing as string[]).filter((id) => !keep.has(id))
      if (stale.length > 0) {
        await db.sessionUsage.bulkDelete(stale)
        removed = stale.length
      }
    }
    if (rows.length > 0) {
      // bulkPut, not the canonical `commitUsageRow`: these rows are imported by
      // construction, so they contribute nothing to the budget projection and
      // the per-row transaction the ledger opens would be pure overhead here.
      await db.sessionUsage.bulkPut(rows as SessionUsageRow[])
      written = rows.length
    }
  })
  return { written, removed }
}

/** Coverage window of the rows an index holds for one source. */
export function coverageOf(rows: readonly SessionUsageRow[]): {
  from: number | null
  to: number | null
} {
  let from: number | null = null
  let to: number | null = null
  for (const r of rows) {
    if (!Number.isFinite(r.at)) continue
    if (from == null || r.at < from) from = r.at
    if (to == null || r.at > to) to = r.at
  }
  return { from, to }
}

function statusFor(batch: {
  truncated: boolean
  failed: number
  degradedReason?: string | undefined
}): UsageSourceStatus {
  if (batch.degradedReason === "root-missing") return "unavailable"
  if (batch.truncated || batch.failed > 0) return "partial"
  return "fresh"
}

/** Scan one source and fold the result into its durable state. */
export async function scanOneSource(
  adapter: AgentSessionSourceAdapter,
  input: SessionScanInput,
  opts: ExternalScanOptions = {}
): Promise<ExternalScanSourceResult> {
  const now = opts.now ?? Date.now()
  const base: ExternalScanSourceResult = {
    sourceId: adapter.id,
    status: "unknown",
    written: 0,
    parsed: 0,
    failed: 0,
    complete: false,
    skipped: null,
  }

  if (adapter.pickerOnly && !input.pickedFiles?.length) {
    await updateUsageSourceState(adapter.id, {
      status: "picker-only",
      parserVersion: USAGE_SCAN_PARSER_VERSION,
      lastScanAt: now,
    })
    return { ...base, status: "picker-only", skipped: "picker-only" }
  }

  const prior = await getUsageSourceState(adapter.id)
  if (!scanDue(prior, now, opts.force)) {
    return { ...base, status: prior?.status ?? "unknown", skipped: "fresh" }
  }

  // A parser bump restarts the source: resuming an old cursor against a
  // re-parsed corpus would mix two parsers' output into one total.
  let cursor =
    prior && prior.parserVersion === USAGE_SCAN_PARSER_VERSION ? (prior.cursor ?? null) : null
  const startedFromTop = cursor === null

  // Drain the source across bounded batches rather than in one unbounded read.
  // Each batch yields to the event loop between locators, and the batch ceiling
  // caps a single refresh so a pathological corpus cannot pin the main thread
  // indefinitely. What it costs is that such a corpus takes several refreshes
  // to converge, which the `partial` status says out loud.
  const rows: SessionUsageRow[] = []
  let parsed = 0
  let failed = 0
  let truncated = false
  let degradedReason: string | undefined
  let fingerprint = ""

  for (let batchIndex = 0; batchIndex < MAX_BATCHES_PER_REFRESH; batchIndex += 1) {
    const batch = await scanSourceUsage(
      adapter,
      input,
      { ...opts.query, signal: opts.signal ?? opts.query?.signal },
      cursor
    )
    rows.push(...batch.rows)
    parsed += batch.parsed
    failed += batch.failed
    if (batch.fingerprint) fingerprint = batch.fingerprint
    if (batch.degradedReason) degradedReason = batch.degradedReason
    cursor = batch.cursor
    if (batch.cursor === null) {
      truncated = batch.truncated
      break
    }
    if (batch.degradedReason === "aborted") {
      truncated = true
      break
    }
    if (batchIndex === MAX_BATCHES_PER_REFRESH - 1) {
      truncated = true
      degradedReason = degradedReason ?? "budget"
    }
  }

  // Deletion needs the WHOLE corpus in hand. A run that resumed mid-corpus, or
  // stopped early, has seen a slice, and "absent from this slice" is not
  // "gone upstream" — pruning on it would erase most of the source's history.
  const complete = startedFromTop && cursor === null && !truncated
  const { written } = await persistScanRows(adapter.id, rows, { complete })
  const status = statusFor({ truncated, failed, degradedReason })
  const held = await rowsForSource(adapter.id)
  const coverage = coverageOf(held)

  await updateUsageSourceState(adapter.id, {
    status,
    parserVersion: USAGE_SCAN_PARSER_VERSION,
    corpusFingerprint: fingerprint,
    coverageFromMs: coverage.from,
    coverageToMs: coverage.to,
    parsedCount: parsed,
    failedCount: failed,
    rowCount: held.length,
    lastScanAt: now,
    cursor,
    ...(status === "fresh" ? { lastSuccessAt: now } : {}),
    ...(degradedReason ? { degradedReason } : {}),
  })

  return { sourceId: adapter.id, status, written, parsed, failed, complete, skipped: null }
}

async function rowsForSource(sourceId: string): Promise<SessionUsageRow[]> {
  return getDb().sessionUsage.where("sourceId").equals(sourceId).toArray()
}

/**
 * Scan every due source, at most {@link USAGE_SCAN_CONCURRENCY} at a time.
 * Never throws: a source that fails is recorded as degraded and the run
 * continues, because one broken vendor layout must not hide the other ten.
 */
export async function refreshExternalUsageIndex(
  input: SessionScanInput,
  opts: ExternalScanOptions = {}
): Promise<ExternalScanResult> {
  const startedAt = opts.now ?? Date.now()
  const all = getSessionSources()
  const wanted = opts.sourceIds ? new Set(opts.sourceIds) : null
  const queue = all.filter((a) => !wanted || wanted.has(a.id))
  const results: ExternalScanSourceResult[] = []

  let next = 0
  const workers = Array.from(
    { length: Math.min(USAGE_SCAN_CONCURRENCY, queue.length) },
    async () => {
      for (;;) {
        if (opts.signal?.aborted) return
        const index = next
        next += 1
        if (index >= queue.length) return
        const adapter = queue[index]
        try {
          results.push(await scanOneSource(adapter, input, { ...opts, now: startedAt }))
        } catch {
          results.push({
            sourceId: adapter.id,
            status: "unavailable",
            written: 0,
            parsed: 0,
            failed: 0,
            complete: false,
            skipped: null,
          })
          await updateUsageSourceState(adapter.id, {
            status: "unavailable",
            lastScanAt: startedAt,
            degradedReason: "read-failed",
          }).catch(() => null)
        }
      }
    }
  )
  await Promise.all(workers)

  results.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1))
  return { sources: results, startedAt, finishedAt: Date.now() }
}

/** Every external row currently indexed, newest first. */
export async function listExternalUsageRows(
  opts: {
    sinceMs?: number
    sourceIds?: readonly string[]
  } = {}
): Promise<SessionUsageRow[]> {
  const db = getDb()
  const rows = opts.sinceMs
    ? await db.sessionUsage.where("at").aboveOrEqual(opts.sinceMs).toArray()
    : await db.sessionUsage.toArray()
  const wanted = opts.sourceIds ? new Set(opts.sourceIds) : null
  return rows
    .filter((r) => Boolean(r.sourceId) && (!wanted || wanted.has(r.sourceId as string)))
    .sort((a, b) => b.at - a.at)
}

/** Source diagnostics for the CLI, settings, and the tray's freshness row. */
export async function describeUsageSources(): Promise<
  Array<UsageSourceStateRow & { displayName: string; supportsScan: boolean }>
> {
  const states = await listUsageSourceStates()
  const byId = new Map(states.map((s) => [s.sourceId, s]))
  return getSessionSources().map((adapter) => {
    const state = byId.get(adapter.id)
    return {
      ...(state ?? {
        sourceId: adapter.id,
        status: (adapter.pickerOnly ? "picker-only" : "unknown") as UsageSourceStatus,
        parserVersion: USAGE_SCAN_PARSER_VERSION,
        corpusFingerprint: "",
        coverageFromMs: null,
        coverageToMs: null,
        parsedCount: 0,
        failedCount: 0,
        rowCount: 0,
        lastScanAt: 0,
        lastSuccessAt: null,
      }),
      displayName: adapter.displayName,
      supportsScan: !adapter.pickerOnly,
    }
  })
}
