"use client"

/**
 * Desktop entry point for Cognia Sites: runs the host-neutral `bootSites`
 * (`lib/sites/boot.ts`) on account unlock, and installs the one piece that
 * genuinely needs React — the `site.open` notification command, whose body is
 * an App Router `router.push`.
 *
 * Two things depended on this existing. ADR-0084 promises that operations "can
 * resume after crashes or timeouts", but recovery only ever ran from the
 * console's own mount effect, for the one selected Site, and only for its
 * owner — so an app that crashed mid-upload left that operation wedged until
 * somebody opened `/sites` and clicked that exact Site. And a build takes
 * minutes: finishing one while the user was on another route produced nothing
 * at all, because the only report was a toast from a component that was no
 * longer mounted.
 *
 * Mounted inside the desktop-only group. `bootSites` reaches
 * `CloudflareSitesService`, which reaches the OS keyring; off the desktop that
 * silently falls back to an in-memory store and every recovery call throws at
 * "provider operations require the selected local execution host". A log spray
 * for no value. The consequence is deliberate and fine: on web no Site
 * notification is produced, so there is nothing there to click.
 */

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"

import { bootSites } from "@/lib/sites/boot"
import { installSiteNotificationCommands, type SiteNotifyTranslate } from "@/lib/sites/notify"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

export function SitesInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const startedFor = useRef<string | null>(null)
  const router = useRouter()
  const t = useTranslations("sites")
  // Notification text is rendered at emit time; hand the watcher the latest
  // translator without re-booting on a locale change. Written in an effect,
  // never during render, so React's ref rules hold.
  const translateRef = useRef<SiteNotifyTranslate>(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])

  useEffect(() => {
    if (!unlockedAccountId) return
    if (startedFor.current === unlockedAccountId) return
    startedFor.current = unlockedAccountId

    let dispose: (() => void) | undefined
    let cancelled = false
    void bootSites({
      actorAccountId: unlockedAccountId,
      translate: (key, values) => translateRef.current(key, values),
    })
      .then((teardown) => {
        if (cancelled) teardown()
        else dispose = teardown
      })
      .catch((error) => {
        // Never block boot: a Site whose recovery failed is recoverable by
        // opening the console, a thrown effect is not.
        log.warn("sites: boot failed", { error: String(error) })
      })

    return () => {
      cancelled = true
      dispose?.()
    }
  }, [unlockedAccountId])

  useEffect(
    () => installSiteNotificationCommands({ navigate: (path) => router.push(path) }),
    [router]
  )

  return null
}
