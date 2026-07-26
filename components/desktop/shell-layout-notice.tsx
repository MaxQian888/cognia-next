"use client"

/**
 * One-shot explanation of the de-crowded shell, shown only to installs the v3
 * migration actually reset.
 *
 * The migration drops the persisted `barItems` / `statusBarCollapsed` /
 * `guildRailCollapsed` so existing users pick up the new defaults — without it
 * the whole pass would be a no-op for anyone who had ever opened the app. That
 * means people who knew where the pet button and the panel toggles were come
 * back to a title bar that no longer has them. This says where they went.
 *
 * It fires from `useUIStore().chromeLayoutMigrated`, a transient flag the
 * migration sets, so it cannot show twice and never shows on a fresh install.
 * The toast does not auto-dismiss: it appears during boot, and an auto-hiding
 * toast at that moment is one a user reliably misses.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useUIStore } from "@/stores/ui/ui-store"

export function ShellLayoutNotice() {
  const migrated = useUIStore((s) => s.chromeLayoutMigrated)
  const acknowledge = useUIStore((s) => s.acknowledgeChromeLayout)
  const t = useTranslations("desktop.shellLayoutNotice")

  useEffect(() => {
    if (!migrated) return
    // Clear first: `toast()` is a side effect outside React's tree, so an early
    // unmount (route change during boot) must not leave the flag armed for a
    // second toast when this remounts.
    acknowledge()
    toast(t("title"), {
      description: t("description"),
      duration: Infinity,
      closeButton: true,
    })
  }, [migrated, acknowledge, t])

  return null
}
