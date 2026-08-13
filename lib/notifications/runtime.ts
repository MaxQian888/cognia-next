// Notification runtime (ADR-0042) — wires the pure `notify()` core to the real
// host: Dexie persistence, the reactive store (badge/panel), sonner toasts,
// host OS notifications, preference loading, and desktop-to-companion push
// fan-out. This is the single public `notify()` every subsystem calls; mobile
// push reception is installed once by the companion boot provider.

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
import { resolveUserTimeZone } from "@/lib/profile/timezone"
import { checkNotificationPermission, notify as tauriNotify } from "@/lib/tauri/notification"
import {
  checkPermission,
  schedule,
  subscribeNotificationPermissionGranted,
} from "@/lib/capacitor/local-notifications"
import { detectPlatform } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri/transport-instance"

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
let permissionCacheInvalidationInstalled = false
function installPermissionCacheInvalidation(): void {
  if (permissionCacheInvalidationInstalled || detectPlatform() !== "mobile") return
  subscribeNotificationPermissionGranted(refreshOsPermission)
  permissionCacheInvalidationInstalled = true
}

async function checkHostNotificationPermission(): Promise<boolean> {
  const platform = detectPlatform()
  if (platform === "mobile") {
    const outcome = await checkPermission()
    return outcome.kind === "ok" && outcome.value === "granted"
  }
  if (platform === "tauri") {
    return (await checkNotificationPermission()) === "granted"
  }
  return false
}

function osPermitted(): Promise<boolean> {
  installPermissionCacheInvalidation()
  if (!permCache) permCache = checkHostNotificationPermission()
  return permCache
}
export function refreshOsPermission(): void {
  permCache = null
}

let nextLocalNotificationId = Math.floor(Date.now() % 2_000_000_000)
function allocateLocalNotificationId(): number {
  nextLocalNotificationId =
    nextLocalNotificationId >= 2_147_483_646 ? 1 : nextLocalNotificationId + 1
  return nextLocalNotificationId
}

async function hostNotify(opts: { title: string; body?: string; href?: string }): Promise<void> {
  if (detectPlatform() !== "mobile") {
    await tauriNotify({ title: opts.title, body: opts.body })
    return
  }

  const outcome = await schedule([
    {
      id: allocateLocalNotificationId(),
      title: opts.title,
      body: opts.body ?? "",
      extra: opts.href ? { route: opts.href } : undefined,
    },
  ])
  if (outcome.kind !== "ok") {
    throw new Error(
      outcome.kind === "error" ? outcome.message : "local notifications are unavailable"
    )
  }
}

async function pushToCompanions(record: NotificationRecord): Promise<void> {
  const result = (await transport.call("companion_push_notification", {
    notificationId: record.id,
    source: record.source,
    level: record.level,
    href: record.href,
  })) as { sent?: unknown }
  if (typeof result?.sent !== "number" || result.sent < 1) {
    throw new Error("no offline companion accepted the push notification")
  }
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
  const platform = detectPlatform()
  return {
    now: () => Date.now(),
    loadPrefs: () =>
      resolvePreferences(useSettingsStore.getState().settings?.notificationPreferences),
    // DND quiet-hours are wall-clock in the user's own zone. Without this,
    // resolveChannels defaults to the *device* zone — wrong on a companion
    // phone in another timezone. Resolve from the (cross-device synced) profile.
    tz: resolveUserTimeZone(useSettingsStore.getState().settings?.profile),
    db: dbPort,
    toast: showToast,
    osNotify: hostNotify,
    isOsPermitted: osPermitted,
    push: platform === "tauri" ? pushToCompanions : undefined,
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
