"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftRightIcon, ServerIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useClientLiveQuery } from "@/hooks/data"
import { impact } from "@/lib/capacitor/haptics"
import {
  loadRecentServers,
  removeRecentServer,
  type RecentServer,
} from "@/lib/connectivity/recent-servers"
import { listPairedDevices } from "@/lib/db/paired-devices"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import { EmptyState } from "@/components/mobile/empty-state"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

export interface MobilePairedServersSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * One row per known server, merged from the two stores that exist today:
 *
 *   • `recentServers` (localStorage) — written by the mobile pair step on
 *     every successful pair. This is the phone's real multi-server memory
 *     and carries `baseUrl` + `fingerprint`, so switching can pre-fill the
 *     pair form directly.
 *   • Dexie `pairedDevices` (ADR-0026) — populated by the desktop companion
 *     event bridge. On a Capacitor phone this table is usually empty, but
 *     when rows exist (web host sharing a browser profile with the desktop)
 *     they're appended for completeness.
 */
export interface KnownServerEntry {
  key: string
  label: string
  detail: string
  /** Present for recent-server entries — enables direct baseUrl switching + forget. */
  baseUrl?: string
  fingerprint?: string
  /** Legacy switch key for Dexie-only rows with no recent-server record. */
  deviceId?: string
  lastSeenAt: number | null
}

export function mergeKnownServers(
  recents: RecentServer[],
  devices: PairedDeviceRow[]
): KnownServerEntry[] {
  const entries: KnownServerEntry[] = recents.map((r) => ({
    key: `recent:${r.baseUrl}`,
    label: r.label ?? r.baseUrl.replace(/^https?:\/\//, ""),
    detail: r.baseUrl.replace(/^https?:\/\//, ""),
    baseUrl: r.baseUrl,
    fingerprint: r.fingerprint,
    deviceId: r.deviceId,
    lastSeenAt: r.lastSeenAt,
  }))
  const seenDeviceIds = new Set(recents.map((r) => r.deviceId).filter(Boolean))
  const seenLabels = new Set(recents.map((r) => r.label).filter(Boolean))
  for (const d of devices) {
    if (d.revokedAt) continue
    // Skip Dexie rows already represented by a recent-server entry (matched
    // by deviceId, or by the legacy `deviceId.slice(0, 8)` label).
    if (seenDeviceIds.has(d.deviceId) || seenLabels.has(d.deviceId.slice(0, 8))) continue
    entries.push({
      key: `device:${d.deviceId}`,
      label: d.label,
      detail: `${d.platform} · ${d.deviceId.slice(0, 8)}`,
      deviceId: d.deviceId,
      lastSeenAt: d.lastSeenAt,
    })
  }
  return entries.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
}

export function MobilePairedServersSheet({ open, onOpenChange }: MobilePairedServersSheetProps) {
  const t = useTranslations("mobile.connectionState.switch")
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))
  const router = useRouter()
  const devices = useClientLiveQuery<PairedDeviceRow[]>(() => listPairedDevices(), [], [])
  // Seeded for the already-open first render; re-read on every re-open below.
  const [recents, setRecents] = useState<RecentServer[]>(() =>
    open ? loadRecentServers() : []
  )
  const [now, setNow] = useState<number>(() => Date.now())

  // Re-read the localStorage recents each time the sheet opens — it has no
  // change events, and a pair may have happened since the last open.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setRecents(loadRecentServers())
  }

  // Only tick the "last seen" relative-time clock while the sheet is open —
  // the timestamps it refreshes are never visible when the sheet is closed,
  // so an always-running interval just burns wakeups/battery.
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [open])

  const entries = mergeKnownServers(recents, devices ?? [])

  function handleSelect(entry: KnownServerEntry) {
    void impact("light")
    toast.message(t("switchingTo", { name: entry.label }))
    if (entry.baseUrl) {
      // Direct pre-fill — the pair page locks this URL and re-validates.
      const params = new URLSearchParams({ baseUrl: entry.baseUrl })
      if (entry.fingerprint) params.set("fingerprint", entry.fingerprint)
      router.push(`/pair?${params.toString()}`)
    } else if (entry.deviceId) {
      // Legacy path: resolve via the recent-server log on the pair page.
      router.push(`/pair?switchTo=${encodeURIComponent(entry.deviceId)}`)
    }
    onOpenChange(false)
  }

  function handleForget(entry: KnownServerEntry) {
    if (!entry.baseUrl) return
    removeRecentServer(entry.baseUrl)
    setRecents(loadRecentServers())
    void impact("light")
    toast.message(t("forgot", { name: entry.label }))
  }

  function formatLastSeen(ts: number | null): string {
    if (!ts) return t("never")
    const diff = now - ts
    if (diff < 60_000) return t("justNow")
    if (diff < 3_600_000) return t("minutesAgo", { n: Math.floor(diff / 60_000) })
    if (diff < 86_400_000) return t("hoursAgo", { n: Math.floor(diff / 3_600_000) })
    return t("daysAgo", { n: Math.floor(diff / 86_400_000) })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[70dvh] gap-0 p-0"
        data-testid="mobile-paired-servers-sheet"
      >
        <SheetHeader className="px-4 pt-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ArrowLeftRightIcon className="size-4" aria-hidden="true" />
            {t("title")}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          {entries.length === 0 ? (
            <EmptyState icon={ServerIcon} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="mobile-paired-servers-list">
              {entries.map((entry) => (
                <li key={entry.key} className="flex items-stretch gap-1.5">
                  <Button
                    variant="outline"
                    className="h-auto min-w-0 flex-1 justify-between gap-3 py-3 text-left"
                    onClick={() => handleSelect(entry)}
                    data-testid={`mobile-paired-row-${entry.key}`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="truncate text-sm font-semibold">{entry.label}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {entry.detail}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {t("lastSeen")}: {formatLastSeen(entry.lastSeenAt)}
                    </span>
                  </Button>
                  {entry.baseUrl ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-auto shrink-0 text-muted-foreground"
                      aria-label={t("forget", { name: entry.label })}
                      onClick={() => handleForget(entry)}
                      data-testid={`mobile-paired-forget-${entry.key}`}
                    >
                      <Trash2Icon className="size-4" aria-hidden="true" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
