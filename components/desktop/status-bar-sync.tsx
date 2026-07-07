"use client"

/**
 * Status-bar companion-sync segment. Reuses the in-memory sync state
 * (`snapshotSyncStates`) — polled on a 15s tick like the mobile Sync panel —
 * and triggers a full pull (`runSyncDown`) on click. Shows the most-recent
 * "last synced" across all tables, an error tint when any table last failed,
 * and a spinner while a manual pull is in flight. Desktop-only; the parent
 * only mounts it under Tauri with `barItems.sync` on.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CloudIcon, RefreshCwIcon } from "lucide-react"
import { formatRelative } from "@cognia/time"

import { cn } from "@/lib/utils"
import { runSyncDown, snapshotSyncStates } from "@/lib/sync/companion-sync"

type Snapshot = ReturnType<typeof snapshotSyncStates>

/** Poll cadence — mirrors `SyncStatusPanel` so the "last synced" stamp stays fresh. */
const REFRESH_MS = 15_000

export function StatusBarSync() {
  const t = useTranslations("desktop.statusBar")
  const [snapshot, setSnapshot] = useState<Snapshot>(() => snapshotSyncStates())
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => setSnapshot(snapshotSyncStates()), [])

  useEffect(() => {
    // Load-on-mount then poll — reading the in-memory sync snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  const states = Object.values(snapshot)
  const lastSyncAt = states.reduce<number | null>(
    (acc, s) =>
      s.lastSyncAt == null ? acc : acc == null ? s.lastSyncAt : Math.max(acc, s.lastSyncAt),
    null
  )
  const hasError = states.some((s) => s.lastError != null)

  const label =
    lastSyncAt == null ? t("syncNever") : t("syncLast", { time: formatRelative(lastSyncAt) })

  const onSync = async () => {
    if (busy) return
    setBusy(true)
    try {
      await runSyncDown()
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const Icon = busy ? RefreshCwIcon : hasError ? CloudIcon : CheckIcon

  return (
    <button
      type="button"
      onClick={() => void onSync()}
      disabled={busy}
      aria-label={t("syncNow")}
      title={label}
      data-testid="status-sync"
      className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-70"
    >
      <Icon
        aria-hidden
        className={cn("size-3", busy && "animate-spin", hasError && !busy && "text-amber-500")}
      />
      <span className="hidden max-w-[14ch] truncate lg:inline">{label}</span>
    </button>
  )
}
