"use client"

import { useEffect, useRef } from "react"

import { loggers } from "@cognia/logging"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

/**
 * Hydrates the user-independent local account registry before any per-account
 * Dexie-backed initializer can run.
 *
 * The guard remembers WHICH store it loaded, not merely that it loaded once.
 * A development hot update that re-evaluates `stores/account/account-store.ts`
 * (or any module it imports) replaces the store with a fresh, unloaded one
 * while this component's ref survives Fast Refresh, and a plain "already done"
 * flag then left `AccountGate` on "Loading accounts" until a manual reload.
 * Keyed on the instance, StrictMode's duplicate effect pass is still a no-op
 * and a replaced store gets its boot read. `load()` is itself idempotent while
 * one is in flight.
 */
export function AccountStoreInitializer() {
  const loadedStore = useRef<typeof useAccountStore | null>(null)

  useEffect(() => {
    if (loadedStore.current === useAccountStore) return
    loadedStore.current = useAccountStore
    void useAccountStore
      .getState()
      .load()
      .catch((err) => log.warn("account-store: boot load threw", { err }))
  })

  return null
}

export default AccountStoreInitializer
