"use client"

// Mirrors Rust `automation:event` rows into the Dexie `automationAuditLog`
// table for the lifetime of the app.
//
// `startAutomationAuditMirror()` had no callers at all. The Settings ->
// Automation -> Audit tab and `components/inbox/computer-use-events-strip.tsx`
// both read a table that automation never wrote to, while
// `AuditRetentionInitializer` faithfully pruned it every day. The only rows in
// there came from CLI / LSP binary policy decisions, so the audit surface
// showed everything except desktop automation, which is the one thing it
// exists for.

import { useEffect } from "react"

import { startAutomationAuditMirror, type Unsubscribe } from "@/lib/automation/audit"

export function AutomationAuditMirrorInitializer() {
  useEffect(() => {
    let unsubscribe: Unsubscribe | null = null
    let cancelled = false

    void startAutomationAuditMirror()
      .then((handle) => {
        // Unmounting before the listener resolves must not leak it.
        if (cancelled) {
          handle()
          return
        }
        unsubscribe = handle
      })
      .catch(() => {
        // A missing mirror must never block boot. The Rust in-memory ring is
        // still authoritative for the current session, and this is only a
        // convenience projection on top of it.
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return null
}

export default AutomationAuditMirrorInitializer
