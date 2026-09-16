/**
 * The ledger store for the account database this window is using right now.
 *
 * The fusion database follows the main database's name, so an account switch
 * or a runtime-target switch lands on a different fusion database without any
 * bookkeeping here. Opening is lazy and every failure is an infrastructure
 * fault (ADR-0188 D38).
 */

import { getDb } from "@/lib/db/schema"

import { fusionContentCodec } from "../db/content-codec"
import { fusionDatabaseName, openFusionDb } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { drainFusionOutbox, type DrainResult } from "../db/outbox"
import { accountDatabaseAppliers } from "../db/outbox-appliers"
import { RouterFusionInfrastructureError } from "../gate/faults"

let cached: { dbName: string; store: FusionLedgerStore } | null = null

export interface StoreProviderDeps {
  mainDatabaseName?: () => string
}

export async function currentFusionStore(deps: StoreProviderDeps = {}): Promise<FusionLedgerStore> {
  let mainName: string
  try {
    mainName = deps.mainDatabaseName ? deps.mainDatabaseName() : getDb().name
  } catch (error) {
    throw new RouterFusionInfrastructureError(
      "db_unavailable",
      "The account database is not available.",
      error
    )
  }
  const name = fusionDatabaseName(mainName)
  const db = await openFusionDb(mainName)
  if (cached && cached.dbName === name && cached.store.db === db) return cached.store
  const store = new FusionLedgerStore({ db, codec: fusionContentCodec(name) })
  cached = { dbName: name, store }
  return store
}

/**
 * Apply this store's pending cross-database effects to the account database.
 *
 * For the lanes with no run driver of their own to drain at the end — a
 * cancelled queued run, a settled proxy hop — so their cockpit rows and usage
 * rows land when they happen rather than whenever another lane next drains.
 */
export function drainAccountOutbox(store: FusionLedgerStore): Promise<DrainResult> {
  return drainFusionOutbox(store.db, accountDatabaseAppliers, store.outboxContext())
}

export function __resetFusionStoreForTesting(): void {
  cached = null
}
