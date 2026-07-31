"use client"

/**
 * Modal for the one boot failure the user cannot diagnose or escape on their own:
 * the Dexie schema upgrade gave up because another window (desktop pet, fleet
 * island, a second browser tab) is still holding the old version open.
 *
 * `getDb()`'s `onGiveUp` used to log this and stop. From the outside the app was
 * simply frozen on the loading spinner, forever, with an idle CPU — no spinner
 * text, no error page (the open never rejects, so no boundary fires), and no hint
 * that closing a *different* window is the fix.
 *
 * A modal is the right surface here precisely because nothing else works: the app
 * behind it is not usable, and the remedy happens outside this window. One of the
 * three sanctioned modal cases.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  subscribeDbUpgradeBlocked,
  type DbUpgradeBlockedDetail,
} from "@/lib/db/upgrade-blocked-signal"

export function DbUpgradeBlockedDialog() {
  const t = useTranslations("diagnostics.surface.dbUpgradeBlocked")
  const [detail, setDetail] = useState<DbUpgradeBlockedDetail | null>(null)

  useEffect(() => subscribeDbUpgradeBlocked(setDetail), [])

  if (!detail) return null

  return (
    // Not dismissible: there is no "continue anyway" — the database never opened.
    // Reloading after closing the other window is the only forward path.
    <AlertDialog open>
      <AlertDialogContent data-testid="db-upgrade-blocked-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => window.location.reload()}
            data-testid="db-upgrade-blocked-reload"
          >
            {t("reload")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
