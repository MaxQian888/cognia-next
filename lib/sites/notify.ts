/**
 * Site lifecycle → Notification Center (ADR-0084).
 *
 * A build takes minutes and a deploy takes tens of seconds. Until now the only
 * report either produced was a `sonner` toast from `useSiteActions`, which
 * exists for as long as the console is mounted — so a publish that finished
 * while the user was reading their inbox produced nothing at all, and a build
 * that failed produced nothing they could find afterwards.
 *
 * Same four layers as `lib/issues/notify.ts`: a pure projection, an emitter
 * that funnels through the single `notify()` entry, a `Dexie.liveQuery` watcher
 * from a boot watermark, and a command executor registered separately because
 * navigation needs the router.
 */

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { registerNotificationCommand } from "@/lib/notifications/action-registry"
import type { notify as notifyRuntime } from "@/lib/notifications/runtime"
import type { NotificationInput, NotificationLevel } from "@/types/notifications"
import type { SiteConsoleTab } from "@/stores/sites/site-console-store"
import type { SiteOperationRow, SiteProjectRow } from "@/types/sites"

export const SITE_OPEN_COMMAND = "site.open"

/** `useTranslations("sites")` from React, or the English fallback below. */
export type SiteNotifyTranslate = (key: string, values?: Record<string, string | number>) => string

/**
 * English fallback for hosts with no translator (tests, headless runtimes).
 * Keys live under `sites.notify.*` in `i18n/messages/{en,zh-CN}/sites.json`.
 */
export const DEFAULT_SITE_NOTIFY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "notify.open": "Open Site",
  "notify.deploySucceeded.title": "{name} is live",
  "notify.deploySucceeded.body": "{url}",
  "notify.deployFailed.title": "{name} failed to deploy",
  "notify.buildFailed.title": "{name} failed to build",
  "notify.uploadFailed.title": "{name} failed to upload",
  "notify.operationFailed.title": "{name}: {operation} failed",
  "notify.waitingReconcile.title": "{name}: {operation} needs reconciliation",
  "notify.waitingReconcile.body":
    "Cognia could not confirm whether Cloudflare applied this. Reconcile to find out.",
  "notify.takedown.title": "{name} was taken down",
  "notify.restore.title": "{name} is serving again",
  "notify.purge.title": "{name}: managed resources purged",
})

export function defaultSiteNotifyTranslate(
  key: string,
  values: Record<string, string | number> = {}
): string {
  const template = DEFAULT_SITE_NOTIFY_TEXT[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  )
}

/** Deep link into the console, matching the `?site=&tab=` the route accepts. */
export function siteHref(siteId: string, tab?: SiteConsoleTab): string {
  const params = new URLSearchParams({ site: siteId, ...(tab ? { tab } : {}) })
  return `/sites?${params.toString()}`
}

export interface SiteNotificationContext {
  /** The URL a successful deploy produced, when it produced one. */
  productionUrl?: string
}

/**
 * One operation transition → at most one notification.
 *
 * Which transitions notify, and why the rest do not:
 *
 *  - **Deploy succeeded** carries the production URL — the one thing the user
 *    was waiting for, and otherwise something they have to go and find.
 *  - **Every failure** notifies, not just build/upload/deploy. A failed `domain`
 *    or `access` operation leaves the Site subtly wrong; a per-type allowlist
 *    here is how silent failures get born.
 *  - **`waiting-reconcile`** is an uncertain provider outcome that only a human
 *    can resolve.
 *  - **Takedown, restore, purge** change whether the Site is on the internet.
 *  - **Intermediate successes** (provision, upload, environment, access,
 *    domain, reconcile) do not. They are steps of a publish the console already
 *    renders as a progressive strip; notifying each would turn one deploy into
 *    five badges.
 *  - **Cancelled** does not. The user cancelled it; they were there.
 */
export function siteOperationNotification(
  site: Pick<SiteProjectRow, "id" | "name">,
  operation: Pick<SiteOperationRow, "id" | "type" | "status" | "errorMessage">,
  context: SiteNotificationContext = {},
  translate: SiteNotifyTranslate = defaultSiteNotifyTranslate
): Omit<NotificationInput, "source"> | null {
  const name = site.name
  const base = (
    level: NotificationLevel,
    title: string,
    body: string | undefined,
    tab: SiteConsoleTab
  ): Omit<NotificationInput, "source"> => ({
    level,
    title,
    ...(body ? { body } : {}),
    // Per operation, not per Site+kind: coalescing by kind would fold two
    // consecutive deploys into one row and hide the second, which for a deploy
    // history is exactly backwards.
    dedupeKey: `site:${site.id}:${operation.id}:${operation.status}`,
    groupKey: `site:${site.id}`,
    href: siteHref(site.id, tab),
    actions: [
      {
        id: "open",
        label: translate("notify.open"),
        command: SITE_OPEN_COMMAND,
        args: { siteId: site.id, tab },
        variant: "primary",
      },
    ],
  })

  const operationLabel = operation.type

  if (operation.status === "waiting-reconcile") {
    return base(
      "warning",
      translate("notify.waitingReconcile.title", { name, operation: operationLabel }),
      operation.errorMessage ?? translate("notify.waitingReconcile.body"),
      "operations"
    )
  }

  if (operation.status === "failed") {
    const titleKey =
      operation.type === "deploy"
        ? "notify.deployFailed.title"
        : operation.type === "build"
          ? "notify.buildFailed.title"
          : operation.type === "upload"
            ? "notify.uploadFailed.title"
            : "notify.operationFailed.title"
    return base(
      "error",
      translate(titleKey, { name, operation: operationLabel }),
      operation.errorMessage,
      "operations"
    )
  }

  if (operation.status !== "succeeded") return null

  switch (operation.type) {
    case "deploy":
      return base(
        "success",
        translate("notify.deploySucceeded.title", { name }),
        context.productionUrl
          ? translate("notify.deploySucceeded.body", { url: context.productionUrl })
          : undefined,
        "publish"
      )
    case "takedown":
      return base("warning", translate("notify.takedown.title", { name }), undefined, "publish")
    case "restore":
      return base("success", translate("notify.restore.title", { name }), undefined, "publish")
    case "purge":
      return base("warning", translate("notify.purge.title", { name }), undefined, "resources")
    default:
      return null
  }
}

export interface InstallSiteNotificationsOptions {
  translate?: SiteNotifyTranslate
  /** Epoch ms; defaults to now. Everything before it is history, not news. */
  since?: number
  notify?: typeof notifyRuntime
  onError?: (error: unknown) => void
}

let installedWatcher: (() => void) | null = null

/**
 * Watch `siteOperations` for terminal transitions and project them.
 *
 * Watching the operations rather than the events: an operation's status is the
 * fact, and its `errorMessage` is written in the same transaction — so a single
 * row carries everything a notification needs without a second read.
 */
export function installSiteNotifications(
  options: InstallSiteNotificationsOptions = {}
): () => void {
  if (installedWatcher) return installedWatcher
  // Fixed at boot. Not advanced afterwards: `updatedAt` is only monotonic per
  // writer, so a moving watermark could skip a row.
  const watermark = options.since ?? Date.now()
  const seen = new Set<string>()
  const onError = options.onError ?? (() => {})
  let disposed = false

  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default.
  const subscription = Dexie.liveQuery(() =>
    getDb()
      .siteOperations.filter((row) => row.updatedAt > watermark)
      .toArray()
  ).subscribe({
    next: (operations: SiteOperationRow[]) => {
      if (disposed) return
      const fresh = operations
        .filter((operation) => !seen.has(`${operation.id}:${operation.status}`))
        .sort((left, right) => left.updatedAt - right.updatedAt)
      if (fresh.length === 0) return
      for (const operation of fresh) seen.add(`${operation.id}:${operation.status}`)
      void (async () => {
        for (const operation of fresh) {
          try {
            await notifySiteOperation(operation, options)
          } catch (error) {
            onError(error)
          }
        }
      })()
    },
    error: onError,
  })

  const dispose = () => {
    if (disposed) return
    disposed = true
    subscription.unsubscribe()
    installedWatcher = null
  }
  installedWatcher = dispose
  return dispose
}

/** Resolve the Site (and, for a deploy, its URL) and emit. */
async function notifySiteOperation(
  operation: SiteOperationRow,
  options: InstallSiteNotificationsOptions
): Promise<void> {
  const db = getDb()
  const site = await db.siteProjects.get(operation.siteId)
  if (!site) return

  let productionUrl: string | undefined
  if (operation.type === "deploy" && operation.status === "succeeded") {
    const { siteProductionUrl } = await import("@/lib/sites/console-model")
    productionUrl = siteProductionUrl(
      await db.siteDeployments.where("siteId").equals(site.id).toArray()
    )
  }

  const input = siteOperationNotification(
    site,
    operation,
    { ...(productionUrl ? { productionUrl } : {}) },
    options.translate ?? defaultSiteNotifyTranslate
  )
  if (!input) return

  // Lazily imported so a profile that never publishes anything keeps the
  // notification runtime out of its boot graph.
  const notify = options.notify ?? (await import("@/lib/notifications/runtime")).notify
  await notify({ ...input, source: "site" })
}

export interface SiteNotificationCommandDeps {
  navigate: (path: string) => void
}

/** Register the `site.open` action executor. Returns the unregister function. */
export function installSiteNotificationCommands(deps: SiteNotificationCommandDeps): () => void {
  return registerNotificationCommand(SITE_OPEN_COMMAND, (ctx) => {
    const siteId = ctx.args?.siteId
    if (typeof siteId !== "string") return
    const tab = ctx.args?.tab
    deps.navigate(siteHref(siteId, typeof tab === "string" ? (tab as SiteConsoleTab) : undefined))
  })
}

export function __resetSiteNotificationsForTesting(): void {
  installedWatcher = null
}
