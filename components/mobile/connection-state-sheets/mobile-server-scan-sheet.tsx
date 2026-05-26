"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { TriangleAlertIcon, WifiIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { EmptyState } from "@/components/mobile/empty-state"
import { ServerCard } from "@/components/mobile/pair/server-card"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { type DiscoveredServer, rankSource } from "@/lib/connectivity/lan-scanner"
import { companionConfigToPairedSummary } from "@/lib/connectivity/paired-summary"
import { requestMdnsPermission } from "@/lib/connectivity/mdns-permission"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { useLanScan } from "@/hooks/connectivity/use-lan-scan"

export interface MobileServerScanSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Bottom sheet that drives the shared `useLanScan` hook and renders
 * discovered cognia desktops via the shared `ServerCard`. Tapping a row
 * navigates to `/pair?baseUrl=<...>&fingerprint=<...>` so the pair page
 * pre-fills its form (Wave 4 / ADR-0026).
 *
 * The scan lifecycle (permission gate, `scanLan` invocation, streamed
 * dedupe) lives in `useLanScan`, shared with the pair-page Discover step.
 * This component keeps only what's sheet-specific: the fingerprint-mismatch
 * banner (paired fp vs `/healthz` fp) and the recency sort.
 */
export function MobileServerScanSheet({ open, onOpenChange }: MobileServerScanSheetProps) {
  const t = useTranslations("mobile.connectionState.scan")
  const router = useRouter()
  const [bannerDismissed, setBannerDismissed] = useState(false)

  // Project the active CompanionConfig into the scan-time `paired` opt + a
  // quick lookup for the mismatch detector. Re-evaluated per `open` so the
  // data is fresh after a recent re-pair, but kept a pure `useMemo` to
  // avoid a setState-in-effect cascade.
  const pairedSummaries = useMemo(() => {
    if (!open) return []
    const summary = companionConfigToPairedSummary(loadCompanionConfig())
    return summary ? [summary] : []
  }, [open])

  const pairedFingerprintByIp = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of pairedSummaries) {
      if (p.fingerprint) map.set(p.ip, p.fingerprint.toLowerCase())
    }
    return map
  }, [pairedSummaries])

  const { servers, scanning, permission } = useLanScan({
    enabled: open,
    paired: pairedSummaries,
    requestPermission: requestMdnsPermission,
    resetOnRun: true,
  })

  // Reset the dismissed banner whenever the sheet (re)opens. Uses React's
  // "adjust state during render on prop change" pattern instead of an effect.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setBannerDismissed(false)
  }

  const mismatches = useMemo(() => {
    return servers.filter((s) => {
      const expected = pairedFingerprintByIp.get(s.ip)
      if (!expected) return false
      const reported = s.fingerprint?.toLowerCase()
      return !!reported && reported !== expected
    })
  }, [servers, pairedFingerprintByIp])

  const sortedServers = useMemo(() => {
    return servers.slice().sort((a, b) => {
      const r = rankSource(b.source) - rankSource(a.source)
      if (r !== 0) return r
      return b.discoveredAt - a.discoveredAt
    })
  }, [servers])

  function handleSelect(server: DiscoveredServer) {
    const params = new URLSearchParams({ baseUrl: server.baseUrl })
    if (server.fingerprint) params.set("fingerprint", server.fingerprint)
    router.push(`/pair?${params.toString()}`)
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[80dvh] gap-0 p-0"
        data-testid="mobile-server-scan-sheet"
      >
        <SheetHeader className="px-4 pt-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <WifiIcon className="size-4" aria-hidden="true" />
            {t("title")}
            {scanning ? <Spinner className="size-3 text-muted-foreground" /> : null}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
          {mismatches.length > 0 && !bannerDismissed ? (
            <Alert
              variant="destructive"
              className="mb-3"
              data-testid="scan-fingerprint-mismatch-banner"
            >
              <TriangleAlertIcon />
              <AlertTitle>{t("fingerprintMismatch.title")}</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>{t("fingerprintMismatch.description", { count: mismatches.length })}</span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setBannerDismissed(true)}
                    data-testid="scan-fingerprint-mismatch-dismiss"
                  >
                    {t("fingerprintMismatch.dismiss")}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          {permission === "denied" ? (
            <EmptyState
              icon={WifiIcon}
              title={t("mdnsDenied")}
              cta={{
                label: t("openSettings"),
                onSelect: () => void openAppSettings(),
              }}
            />
          ) : sortedServers.length === 0 && !scanning ? (
            <EmptyState icon={WifiIcon} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="mobile-server-scan-list">
              {sortedServers.map((server) => {
                const expected = pairedFingerprintByIp.get(server.ip)
                const reported = server.fingerprint?.toLowerCase()
                const hasMismatch = !!expected && !!reported && expected !== reported
                return (
                  <li key={server.id}>
                    <ServerCard server={server} onSelect={handleSelect} mismatch={hasMismatch} />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
