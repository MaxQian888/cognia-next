// Notification runtime (ADR-0042) — wires the pure `notify()` core to the real
// host: Dexie persistence, the reactive store (badge/panel), sonner toasts,
// Tauri OS notifications, and preference loading. The single public `notify()`
// every subsystem calls. Push fan-out is attached by the mobile layer (Phase 5/8).

import { toast } from "sonner"
import type { NotificationInput, NotificationRecord } from "@/types/notifications"
import {
  findByDedupeKey,
  putNotification,
  patchNotification,
  pruneNotifications,
} from "@/lib/db/notifications"
import { notify as notifyCore, type NotifyDeps, type NotifyDbPort } from "./notify"
import { createImDeliver } from "./im-deliver"
import { resolvePreferences } from "./preferences"
import { dispatchNotificationCommand } from "./action-registry"
import { useNotificationStore } from "@/stores/notifications/notification-store"
import { useSettingsStore } from "@/stores/settings"
import { ensureNotificationPermission, notify as osNotify } from "@/lib/tauri/notification"

const dbPort: NotifyDbPort = {
  findByDedupeKey,
  putNotification,
  patchNotification,
  pruneNotifications,
}

// OS permission is cached — `ensureNotificationPermission` is idempotent but we
// avoid a round-trip per notification. The permission hook calls
// `refreshOsPermission()` after a (re)request.
let permCache: Promise<boolean> | null = null
function osPermitted(): Promise<boolean> {
  if (!permCache) permCache = ensureNotificationPermission().then((p) => p === "granted")
  return permCache
}
export function refreshOsPermission(): void {
  permCache = null
}

/** Map a record to a sonner toast, wiring its first action button. */
function showToast(rec: NotificationRecord): void {
  const fn =
    rec.level === "success"
      ? toast.success
      : rec.level === "warning"
        ? toast.warning
        : rec.level === "error" || rec.level === "critical"
          ? toast.error
          : toast.info
  const first = rec.actions?.[0]
  fn(rec.title, {
    description: rec.body,
    action: first
      ? {
          label: first.label,
          onClick: () =>
            void dispatchNotificationCommand({
              notificationId: rec.id,
              command: first.command,
              args: first.args,
            }),
        }
      : undefined,
  })
}

function buildDeps(): NotifyDeps {
  return {
    now: () => Date.now(),
    loadPrefs: () =>
      resolvePreferences(useSettingsStore.getState().settings?.notificationPreferences),
    db: dbPort,
    toast: showToast,
    osNotify,
    isOsPermitted: osPermitted,
    imDeliver: imDeliverFn,
    onRecord: (rec) => useNotificationStore.getState().ingest(rec),
  }
}

// IM proactive-push delivery (control-plane notifications). Built once with the
// default Dexie/PII deps; routes records whose channels include `"im"` to the
// bound conversation (opt-in + PII gated).
const imDeliverFn = createImDeliver()

/** The single notification entry point for the whole app. */
export async function notify(input: NotificationInput): Promise<string> {
  return notifyCore(input, buildDeps())
}
