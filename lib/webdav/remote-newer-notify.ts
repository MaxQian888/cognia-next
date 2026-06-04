// Bridge between the periodic remote-newer check and the unified
// notification center (ADR-0042). Strings are passed in by the calling
// component (which has `useTranslations`); this module stays i18n-free.
//
// `checkRemoteNewerThanLocal` already dedupes per remote snapshot via
// `webdavSync.lastRemoteSeenAt`, so a `newer: true` result fires at most
// once per snapshot; the notification `dedupeKey` is belt-and-braces against
// concurrent callers (boot check + scheduler tick).

import { isTauri } from "@/lib/tauri"

import { checkRemoteNewerThanLocal } from "./startup-check"

export interface RemoteNewerStrings {
  title: string
  body?: string
}

/** Where the restore UI lives, per shell. */
export function remoteNewerHref(): string {
  return isTauri() ? "/settings?section=data" : "/me/backup"
}

/**
 * Run the remote-newer check and surface a notification-center entry when the
 * server holds a snapshot newer than anything local. Returns true when a
 * notification was posted. Never throws — background checks must not disrupt
 * the scheduler tick or boot.
 */
export async function notifyIfRemoteNewer(strings: RemoteNewerStrings): Promise<boolean> {
  try {
    const result = await checkRemoteNewerThanLocal()
    if (!result?.newer) return false
    const { notify } = await import("@/lib/notifications/runtime")
    await notify({
      source: "system",
      level: "info",
      title: strings.title,
      body: strings.body,
      href: remoteNewerHref(),
      dedupeKey: `webdav-remote-newer:${result.remoteAt ?? "unknown"}`,
      coalesceBackoff: true,
      directed: true,
      icon: "CloudDownload",
    })
    return true
  } catch {
    return false
  }
}
