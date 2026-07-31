"use client"

import { useEffect, useRef } from "react"

import { loggers } from "@cognia/logging"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

/**
 * Hydrates the user-independent local account registry before any per-account
 * Dexie-backed initializer can run.
 */
export function AccountStoreInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void useAccountStore
      .getState()
      .load()
      .catch((err) => log.warn("account-store: boot load threw", { err }))
  }, [])

  return null
}

export default AccountStoreInitializer
