"use client"

// ADR-0020 W1 — fires once on app boot. Runs an initial audit-log prune
// (deleting rows older than `automationSettings.audit.retentionDays`)
// and schedules a daily sweep so the table doesn't grow beyond the
// operator-configured window. The 5000-row LRU cap inside `recordAuditRow`
// is a lower-bound failsafe; this initializer enforces the upper-bound
// time window that the Settings UI exposes.

import { useEffect, useRef } from "react"

import { startAuditRetentionSweeper, type Unsubscribe } from "@/lib/automation/audit-retention"

export function AuditRetentionInitializer() {
  const hasInitialized = useRef(false)
  const unsubscribeRef = useRef<Unsubscribe | null>(null)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void startAuditRetentionSweeper().then((u) => {
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

export default AuditRetentionInitializer
