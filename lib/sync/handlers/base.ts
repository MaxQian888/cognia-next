/**
 * Generic sync-pull handler.
 *
 * Wraps the `_rpc/sync_pull` round-trip + Dexie apply step so each table
 * only has to provide its name + a typed table getter. The transport is
 * injected so tests can mock it cleanly.
 */

import type { Transport } from "@/lib/tauri/transport-types"
import type { Table } from "dexie"

import type { SyncCursor, SyncDelta, SyncFailure, SyncOutcome, SyncableTable } from "../types"

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
   */
  applyRows?: (rows: TRow[]) => Promise<void>
}

const SYNC_RPC = "sync_pull"
export const RETRIEVAL_CONTENT_PROTOCOL_VERSION = 1

/**
 * Safety cap on the pagination drain loop. Single-shot tables exit after one
 * pull (no `has_more`); paged tables (messages) loop once per page. The cap
 * only fires on a pathological server that keeps signalling `has_more`
 * without advancing the cursor (e.g. >PAGE rows sharing one timestamp).
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
  let applied = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    let delta: SyncDelta<TRow>
    try {
      delta = await transport.call<SyncDelta<TRow>>(SYNC_RPC, {
        table: opts.table,
        since,
        content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
      })
    } catch (err: unknown) {
      return { ok: false, failure: classifyTransportError(opts.table, err) }
    }

    const filtered = opts.rowFilter ? delta.rows.filter(opts.rowFilter) : delta.rows

    try {
      const t = opts.getTable()
      if (filtered.length > 0) {
        if (opts.applyRows) await opts.applyRows(filtered)
        else await t.bulkPut(filtered)
      }
      if (delta.deleted_ids.length > 0) {
        await t.bulkDelete(delta.deleted_ids)
      }
    } catch (err: unknown) {
      return {
        ok: false,
        failure: {
          table: opts.table,
          reason: "schema",
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }

    applied += filtered.length + delta.deleted_ids.length
    since = delta.next_since

    // Single-shot table, or the server has no more pages past the cursor.
    if (!delta.has_more) {
      return { ok: true, result: { table: opts.table, applied, nextSince: since } }
    }
  }

  // Drained MAX_PAGES without the server clearing `has_more` — bail out with
  // what we applied so far rather than loop forever.
  console.warn(`[sync] ${opts.table}: stopped after ${MAX_PAGES} pages (cursor stuck?)`)
  return { ok: true, result: { table: opts.table, applied, nextSince: since } }
}

function classifyTransportError(table: SyncableTable, err: unknown): SyncFailure {
  const message = err instanceof Error ? err.message : String(err)
  if (/upgrade_required/i.test(message)) {
    return { table, reason: "upgrade_required", message }
  }
  // The Rust server rejects unknown RPCs with a 404 / "command not found"
  // response — surface as `not_implemented` so the orchestrator can mark
  // the table as "server doesn't ship sync_pull yet" rather than red.
  if (/not.found|unknown command|not implemented|404/i.test(message)) {
    return { table, reason: "not_implemented", message }
  }
  return { table, reason: "transport", message }
}
