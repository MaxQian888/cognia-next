"use client"

// Fires once on app boot. Runs an initial prune of unbounded Dexie tables
// (deleting `agentTraces` spans older than
// `storageRetention.traceRetentionDays`) and schedules a daily sweep so the
// table can't grow without bound. Mirrors `AuditRetentionInitializer` — the
// per-table LRU caps elsewhere are the lower bound; this enforces the
// operator-configured upper-bound time window.

import { useEffect, useRef } from "react"

import { startStorageRetentionSweeper, type Unsubscribe } from "@/lib/storage/retention"

export function StorageRetentionInitializer() {
  const hasInitialized = useRef(false)
  const unsubscribeRef = useRef<Unsubscribe | null>(null)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void startStorageRetentionSweeper().then((u) => {
      unsubscribeRef.current = u
    })
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [])

  return null
}

export default StorageRetentionInitializer
