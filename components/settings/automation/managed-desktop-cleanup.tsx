"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { useAccountStore } from "@/stores/account/account-store"
import {
  listPendingManagedDesktopResultDeletions,
  retryManagedDesktopResultDeletions,
} from "@/lib/automation/managed-desktop-result-deletion"

/** Content-free cleanup receipts remain reachable after their source history disappears. */
export function ManagedDesktopCleanup() {
  const owner = useAccountStore((state) => (state.locked ? null : state.unlockedAccountId))
  return owner ? <CleanupStatus key={owner} /> : null
}
function CleanupStatus() {
  const t = useTranslations("settings.managedDesktops.results.cleanup")
  const rows = useLiveQuery(listPendingManagedDesktopResultDeletions, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const alive = useRef(true)
  const pending = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function retry() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await retryManagedDesktopResultDeletions()
      if (alive.current) setError(false)
    } catch {
      if (alive.current) setError(true)
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  if (!rows?.length) return null
  return (
    <section aria-label={t("title")} className="space-y-2 border-t pt-3">
      <h4 className="text-sm font-medium">{t("title")}</h4>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="text-xs break-all">
            {t("item", {
              host: row.host.hostId,
              attempts: row.attempts,
              state: t(row.phase === "preparing" ? "preparing" : "pending"),
            })}
          </li>
        ))}
      </ul>
      {error ? <p role="alert">{t("failed")}</p> : null}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>
        {t("retry")}
      </Button>
    </section>
  )
}
