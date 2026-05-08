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
  /** Optional row filter applied before bulkPut (e.g. drop built-in rows). */
  rowFilter?: (row: TRow) => boolean
}

const SYNC_RPC = "sync_pull"

/**
 * Run a single sync-pull round-trip + Dexie apply.
 * Returns `{ ok: true, result }` on success, `{ ok: false, failure }`
 * otherwise. Never throws — the caller fans out across tables and renders
 * a per-table status row in the UI.
 */
export async function runSyncHandler<TRow extends { id: string }>(
  opts: SyncHandlerOptions<TRow>,
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  let delta: SyncDelta<TRow>
  try {
    delta = await transport.call<SyncDelta<TRow>>(SYNC_RPC, {
      table: opts.table,
      since: cursor.since,
    })
  } catch (err: unknown) {
    return { ok: false, failure: classifyTransportError(opts.table, err) }
  }

  const filtered = opts.rowFilter ? delta.rows.filter(opts.rowFilter) : delta.rows

  try {
    const t = opts.getTable()
    if (filtered.length > 0) {
      await t.bulkPut(filtered)
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

  return {
    ok: true,
    result: {
      table: opts.table,
      applied: filtered.length + delta.deleted_ids.length,
      nextSince: delta.next_since,
    },
  }
}

function classifyTransportError(table: SyncableTable, err: unknown): SyncFailure {
  const message = err instanceof Error ? err.message : String(err)
  // The Rust server rejects unknown RPCs with a 404 / "command not found"
  // response — surface as `not_implemented` so the orchestrator can mark
  // the table as "server doesn't ship sync_pull yet" rather than red.
  if (/not.found|unknown command|not implemented|404/i.test(message)) {
    return { table, reason: "not_implemented", message }
  }
  return { table, reason: "transport", message }
}
