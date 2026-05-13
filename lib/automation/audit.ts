/**
 * Mirror Rust-side `automation:event` payloads into the Dexie
 * `automationAuditLog` table. The Rust ring is in-memory and capped at 5000;
 * this writer enforces the same cap on the Dexie side so the table doesn't
 * grow unbounded across long-running sessions.
 *
 * Subscription lifecycle:
 *
 *   - `startAutomationAuditMirror()` registers the event listener and returns
 *     the unsubscribe handle.
 *   - The hook `useAutomationAuditMirror` is the React entry point; it
 *     auto-subscribes on mount and unsubscribes on unmount.
 *   - In web mode (`!isTauri()`) the mirror is a no-op — Tauri events never
 *     fire, but the function returns safely so call sites don't need to gate.
 */

import type { Event } from "@tauri-apps/api/event"

import { getDb, type AutomationAuditLogRow } from "@/lib/db/schema"
import { isTauri } from "@/lib/tauri"

/** Cap mirror on the Dexie side. Matches `AUDIT_CAP` in `audit.rs`. */
export const AUTOMATION_AUDIT_CAP = 5000

export type Unsubscribe = () => void

/**
 * Subscribe to `automation:event` and persist each row to Dexie. Returns an
 * unsubscribe handle.
 *
 * No-ops in web mode; the returned handle is still safe to call.
 */
export async function startAutomationAuditMirror(): Promise<Unsubscribe> {
  if (!isTauri()) {
    return () => {}
  }
  const { listen } = await import("@tauri-apps/api/event")
  const unlisten = await listen("automation:event", async (event: Event<AutomationAuditLogRow>) => {
    const row = event.payload
    try {
      await recordAuditRow(row)
    } catch (err) {
      // Audit logging must never break the host flow; surface as warn.
      console.warn("automation:event Dexie persist failed", err)
    }
  })
  return unlisten
}

/**
 * Append a row + enforce the 5000-newest cap. Exposed for tests and the
 * Settings → Automation → Audit "import from JSON" affordance.
 */
export async function recordAuditRow(row: AutomationAuditLogRow): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.automationAuditLog, async () => {
    await db.automationAuditLog.put(row)
    const count = await db.automationAuditLog.count()
    if (count > AUTOMATION_AUDIT_CAP) {
      const overflow = count - AUTOMATION_AUDIT_CAP
      const oldest = await db.automationAuditLog.orderBy("ts").limit(overflow).primaryKeys()
      if (oldest.length > 0) {
        await db.automationAuditLog.bulkDelete(oldest as string[])
      }
    }
  })
}

/**
 * Snapshot the persisted audit log, newest-first, with optional surface and
 * decision filters. Used by the Settings → Audit tab and CSV export.
 */
export async function listAuditRows(filter?: {
  surface?: AutomationAuditLogRow["surface"]
  decision?: AutomationAuditLogRow["decision"]
  limit?: number
}): Promise<AutomationAuditLogRow[]> {
  const db = getDb()
  let coll = db.automationAuditLog.orderBy("ts").reverse()
  if (filter?.surface) {
    coll = coll.filter((r) => r.surface === filter.surface)
  }
  if (filter?.decision) {
    coll = coll.filter((r) => r.decision === filter.decision)
  }
  if (filter?.limit && filter.limit > 0) {
    coll = coll.limit(filter.limit)
  }
  return coll.toArray()
}

/** Clear the entire audit log. Used by the Settings → Audit "Clear" button. */
export async function clearAuditLog(): Promise<void> {
  const db = getDb()
  await db.automationAuditLog.clear()
}
