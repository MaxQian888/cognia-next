"use client"

import { useEffect } from "react"

import { attachManagedIdeBroker } from "@/lib/plugin/ide/broker-runtime"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * Attaches the renderer-owned Cognia plugin runtime to provider callbacks from
 * generated managed code-server proxies.
 */
export function ManagedIdeBrokerInitializer() {
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void attachManagedIdeBroker().then((dispose) => {
      if (cancelled) dispose()
      else unlisten = dispose
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [])

  return null
}

export default ManagedIdeBrokerInitializer
