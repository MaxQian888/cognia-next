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

const recentlyPublished = new Set<string>()

/**
 * Headless push channel: cognia-server has no Tauri push fan-out
 * (`companion_push_notification` is desktop-only), but it exposes
 * `remote_notification_publish`, which broadcasts a `notification://remote`
 * frame on the events plane. Every connected companion (phone, browser, a
 * desktop driving this host) ingests it into its own Notification Center —
 * see `lib/notifications/remote-subscription.ts`. The `critical` level is
 * mapped down to `error` because the wire contract only knows four levels;
 * the client re-derives urgency from its own preferences.
 */
export async function publishRemoteNotification(record: NotificationRecord): Promise<void> {
  // A record can resolve to both `toast` and `push` on headless (both map
  // here); publish once per record so companions do not see it twice.
  if (recentlyPublished.has(record.id)) return
  recentlyPublished.add(record.id)
  if (recentlyPublished.size > 256) {
    const first = recentlyPublished.values().next().value
    if (first !== undefined) recentlyPublished.delete(first)
  }
  await transport.call("remote_notification_publish", {
    id: record.id,
    title: record.title.slice(0, 160),
    body: (record.body && record.body.trim().length > 0 ? record.body : record.title).slice(
      0,
      2_000
    ),
    level: record.level === "critical" ? "error" : record.level,
    href:
      record.href && record.href.startsWith("/") && !record.href.startsWith("//")
        ? record.href
        : undefined,
    source: record.source,
  })
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
  // The headless brain has no webview: no toast to draw, no OS notification
  // permission (checkHostNotificationPermission → false), and its "push" is
  // the events-plane broadcast that connected companions ingest.
  const headless = platform === "headless"
  return {
    now: () => Date.now(),
    loadPrefs: () =>
      resolvePreferences(useSettingsStore.getState().settings?.notificationPreferences),
    // DND quiet-hours are wall-clock in the user's own zone. Without this,
    // resolveChannels defaults to the *device* zone — wrong on a companion
    // phone in another timezone. Resolve from the (cross-device synced) profile.
    tz: resolveUserTimeZone(useSettingsStore.getState().settings?.profile),
    db: dbPort,
    // Headless: a task that asked for a toast wants a human to notice; the
    // only human is on a companion device, so the toast becomes the remote
    // broadcast (published once per record even if `push` is also resolved).
    toast: headless ? publishRemoteNotification : showToast,
    osNotify: hostNotify,
    isOsPermitted: osPermitted,
    push:
      platform === "tauri" ? pushToCompanions : headless ? publishRemoteNotification : undefined,
    imDeliver: imDeliverFn,
    // Lazy so the notification runtime keeps no static Dexie import; a failure
    // here only costs the workspace label on the row.
    resolveSessionWorkspace: async (sessionId: string) => {
      const { getDb } = await import("@/lib/db/schema")
      return (await getDb().sessions.get(sessionId))?.projectId
    },
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
