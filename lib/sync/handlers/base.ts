/**
 * Generic sync-pull handler.
 *
 * Wraps the `_rpc/sync_pull` round-trip + Dexie apply step so each table
 * only has to provide its name + a typed table getter. The transport is
 * injected so tests can mock it cleanly.
 */

import type { Transport } from "@/lib/tauri/transport-types"
import type { Table } from "dexie"

import { applyInSlices, yieldToMain } from "../scheduling"
import type { SyncCursor, SyncDelta, SyncFailure, SyncOutcome, SyncableTable } from "../types"
import { PAGED_SYNC_TABLES } from "../types"

export interface SyncHandlerOptions<TRow extends { id: string }> {
  table: SyncableTable
  /** Returns the Dexie table to write into. Lazy so tests can inject. */
  getTable: () => Table<TRow, string>
  /** Optional row filter applied before the apply step (e.g. drop built-in rows). */
  rowFilter?: (row: TRow) => boolean
  /**
   * Optional override for how upsert rows are written. Defaults to
   * `getTable().bulkPut(rows)`. Used by the settings singleton to merge only
   * cross-platform fields onto the local row instead of clobbering it
   * (`handlers/app-settings.ts`). Deletes always go through
   * `getTable().bulkDelete`.
   *
   * Called once per slice (see {@link SYNC_APPLY_SLICE_SIZE}), never once per
   * page, so an override must be safe to run repeatedly over disjoint row sets
   * — every current one is (they write the rows they are handed, plus
   * idempotent housekeeping).
   */
  applyRows?: (rows: TRow[]) => Promise<void>
  /** Override the write slice size (tests). */
  applySliceSize?: number
}

/**
 * Rows written to Dexie per uninterruptible job.
 *
 * A page can be 500 rows of message JSON, and `bulkPut` serialises and
 * structured-clones the whole array in one go — a job the browser cannot
 * interrupt, and the shape of the freeze a first pairing used to produce.
 * Sliced, the same write becomes several jobs with a paint opportunity
 * between each; 200 keeps the per-slice transaction overhead negligible
 * against the work it lets the browser interleave.
 */
export const SYNC_APPLY_SLICE_SIZE = 200

const SYNC_RPC = "sync_pull"
export const RETRIEVAL_CONTENT_PROTOCOL_VERSION = 1

/**
 * Safety cap on the pagination drain loop. Single-shot tables exit after one
 * pull (no `has_more`); paged tables loop once per page. A large backlog
 * stops with an incomplete outcome and a resumable checkpoint at this cap.
 * Non-advancing pages fail immediately below.
 */
const MAX_PAGES = 100

/**
 * Run a sync-pull + Dexie apply, draining all pages.
 *
 * Most tables return a single delta with no `has_more`, so this does exactly
 * one round-trip. Incremental message pulls and other paged tables set
 * `has_more` when a page filled to capacity; this loop keeps pulling with the
 * advanced cursor until the server stops setting it.
 *
 * Returns `{ ok: true, result }` on success, `{ ok: false, failure }`
 * otherwise. Never throws — the caller fans out across tables and renders
 * a per-table status row in the UI.
 */
export async function runSyncHandler<TRow extends { id: string }>(
  opts: SyncHandlerOptions<TRow>,
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  let since = cursor.since
  let nextCursor = cursor.cursor
  let useCursor = PAGED_SYNC_TABLES.includes(opts.table)
  let applied = 0
  const result = () => ({
    table: opts.table,
    applied,
    nextSince: since,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  })
  const failure = (value: SyncFailure): SyncOutcome => ({
    ok: false,
    failure: {
      ...value,
      ...(since !== cursor.since || nextCursor !== cursor.cursor ? { progress: result() } : {}),
    },
  })

  for (let page = 0; page < MAX_PAGES; page++) {
    let delta: SyncDelta<TRow>
    try {
      const args = {
        table: opts.table,
        since,
        content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
        ...(useCursor ? { cursor: nextCursor ?? "" } : {}),
      }
      try {
        delta = await transport.call<SyncDelta<TRow>>(SYNC_RPC, args)
      } catch (error) {
        // Older strict contracts reject the additive cursor argument before
        // dispatch. Retry this read once without it, never discard a durable
        // composite cursor after a host downgrade.
        if (
          !useCursor ||
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "contract_input_violation"
          )
        )
          throw error
        if (nextCursor !== undefined)
          throw new Error("upgrade_required: host does not support the saved sync cursor")
        useCursor = false
        const { cursor: _cursor, ...legacyArgs } = args
        delta = await transport.call<SyncDelta<TRow>>(SYNC_RPC, legacyArgs)
      }
    } catch (err: unknown) {
      return failure(classifyTransportError(opts.table, err))
    }

    if (
      !delta ||
      !Array.isArray(delta.rows) ||
      !Array.isArray(delta.deleted_ids) ||
      !delta.deleted_ids.every((id) => typeof id === "string") ||
      !Number.isSafeInteger(delta.next_since) ||
      delta.next_since < 0 ||
      (delta.next_cursor !== undefined &&
        (typeof delta.next_cursor !== "string" || delta.next_cursor.length > 4096))
    ) {
      return failure({ table: opts.table, reason: "schema", message: "Invalid sync delta" })
    }
    if (nextCursor !== undefined && !delta.next_cursor) {
      return failure({
        table: opts.table,
        reason: "upgrade_required",
        message: "Host did not preserve the saved sync cursor",
      })
    }
    if (
      delta.has_more &&
      delta.next_since <= since &&
      (delta.next_cursor === undefined || delta.next_cursor === nextCursor)
    ) {
      return failure({
        table: opts.table,
        reason: "schema",
        message: "Sync page cursor did not advance",
      })
    }

    const filtered = opts.rowFilter ? delta.rows.filter(opts.rowFilter) : delta.rows

    try {
      const t = opts.getTable()
      const sliceSize = opts.applySliceSize ?? SYNC_APPLY_SLICE_SIZE
      const applySlice = opts.applyRows ?? ((rows: TRow[]) => t.bulkPut(rows).then(() => undefined))
      await applyInSlices(filtered, sliceSize, (slice) => applySlice(slice as TRow[]))
      await applyInSlices(delta.deleted_ids, sliceSize, async (slice) => {
        await t.bulkDelete(slice as string[])
      })
    } catch (err: unknown) {
      return failure({
        table: opts.table,
        reason: "schema",
        message: err instanceof Error ? err.message : String(err),
      })
    }

    applied += filtered.length + delta.deleted_ids.length
    since = delta.next_since
    nextCursor = delta.next_cursor

    // Single-shot table, or the server has no more pages past the cursor.
    if (!delta.has_more) {
      return { ok: true, result: result() }
    }

    // A paged table drains as fast as the Host answers. Between pages is the
    // one point where the loop is guaranteed to hold nothing, so it is where
    // the thread goes back — otherwise a deep history is one unbroken run of
    // parse → write → request with no gap for a frame.
    await yieldToMain()
  }

  // Keep the applied checkpoint, but never report an unfinished drain as success.
  return failure({
    table: opts.table,
    reason: "transport",
    message: `Sync is incomplete after ${MAX_PAGES} pages; resume from the saved cursor`,
  })
}

/**
 * The two fields a `CompanionError` carries that matter here, read structurally
 * rather than by importing the class. `lib/tauri/transport-companion` imports
 * the sync registry, so naming the type here would close a cycle, and the RTC
 * transport raises its own error object with the same two fields anyway.
 */
function quotaRefusal(err: unknown): { retryAfterMs?: number } | null {
  if (!err || typeof err !== "object") return null
  const candidate = err as { code?: unknown; retryAfterMs?: unknown; message?: unknown }
  const message = typeof candidate.message === "string" ? candidate.message : ""
  const isQuota =
    candidate.code === "rate_limited" || candidate.code === "http_429" || /\b429\b/.test(message)
  if (!isQuota) return null
  return typeof candidate.retryAfterMs === "number" && Number.isFinite(candidate.retryAfterMs)
    ? { retryAfterMs: candidate.retryAfterMs }
    : {}
}

function classifyTransportError(table: SyncableTable, err: unknown): SyncFailure {
  const message = err instanceof Error ? err.message : String(err)
  if (/upgrade_required/i.test(message)) {
    return { table, reason: "upgrade_required", message }
  }
  // Before the generic transport bucket: a quota refusal is the host declining
  // to answer yet, not this table failing.
  const quota = quotaRefusal(err)
  if (quota) {
    return {
      table,
      reason: "rate_limited",
      message,
      ...(quota.retryAfterMs === undefined ? {} : { retryAfterMs: quota.retryAfterMs }),
    }
  }
  // The Rust server rejects unknown RPCs with a 404 / "command not found"
  // response — surface as `not_implemented` so the orchestrator can mark
  // the table as "server doesn't ship sync_pull yet" rather than red.
  if (/not.found|unknown command|not implemented|404/i.test(message)) {
    return { table, reason: "not_implemented", message }
  }
  return { table, reason: "transport", message }
}
