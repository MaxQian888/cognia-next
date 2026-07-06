"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftRightIcon, ServerIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useClientLiveQuery } from "@/hooks/data"
import { listPairedDevices } from "@/lib/db/paired-devices"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import { EmptyState } from "@/components/mobile/empty-state"

export interface MobilePairedServersSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Lists every paired desktop from the local Dexie `pairedDevices` table
 * (Wave 4 / ADR-0026) so the user can switch the active companion config
 * between known servers without re-pairing.
 *
 * Switching is implemented by navigating to `/pair?switchTo=<deviceId>`;
 * the pair page handles loading the cached baseUrl/JWT and re-installing
 * the companion config. Revoked rows are filtered out.
 *
 * NOTE: deep switching (rewriting `saveCompanionConfig` directly) is
 * deliberately not wired here — the pair page already runs the device-jwt
 * validation against the target server, so routing through it ensures we
 * never strand the user on a stale rendezvous tuple.
 */
export function MobilePairedServersSheet({ open, onOpenChange }: MobilePairedServersSheetProps) {
  const t = useTranslations("mobile.connectionState.switch")
  const router = useRouter()
  const devices = useClientLiveQuery<PairedDeviceRow[]>(() => listPairedDevices(), [], [])
  const [now, setNow] = useState<number>(() => Date.now())

  // Only tick the "last seen" relative-time clock while the sheet is open —
  // the timestamps it refreshes are never visible when the sheet is closed,
  // so an always-running interval just burns wakeups/battery.
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [open])

  const visible = (devices ?? []).filter((d) => !d.revokedAt)

  function handleSelect(device: PairedDeviceRow) {
    toast.message(t("switchingTo", { name: device.label }))
    // Route through Next.js navigation — the pair page handles loading
    // the cached baseUrl/JWT and revalidating against the target server,
    // see jsdoc above.
    router.push(`/pair?switchTo=${encodeURIComponent(device.deviceId)}`)
    onOpenChange(false)
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

        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
          {visible.length === 0 ? (
            <EmptyState icon={ServerIcon} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="mobile-paired-servers-list">
              {visible.map((device) => (
                <li key={device.deviceId}>
                  <Button
                    variant="outline"
                    className="h-auto w-full justify-between gap-3 py-3 text-left"
                    onClick={() => handleSelect(device)}
                    data-testid={`mobile-paired-row-${device.deviceId}`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="truncate text-sm font-semibold">{device.label}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {device.platform} · {device.deviceId.slice(0, 8)}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {t("lastSeen")}: {formatLastSeen(device.lastSeenAt)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
