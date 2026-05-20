"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, Loader2Icon, PinIcon, ShieldCheckIcon, WifiIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import {
  type DiscoveredServer,
  type PairedSummary,
  rankSource,
  scanLan,
} from "@/lib/connectivity/lan-scanner"
import { requestMdnsPermission } from "@/lib/connectivity/mdns-permission"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { cn } from "@/lib/utils"

import { EmptyState } from "@/components/mobile/empty-state"

export interface MobileServerScanSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Bottom sheet that drives `scanLan()` and renders discovered cognia
 * desktops grouped by source. Tapping a row navigates to
 * `/pair?baseUrl=<...>&fingerprint=<...>` so the pair page can pre-fill
 * the form (Wave 4 / ADR-0026).
 *
 * Wave 4.x additions:
 *   - Multi-port probing — paired and emulator-alias IPs sweep 7890 /
 *     7891 / 7900 / 8443 instead of only the primary port. Distinct
 *     `ip:port` hits show up as separate rows since each maps to a
 *     potentially-different server instance.
 *   - Paired-IP ranking — known paired devices are layered into
 *     `scanLan()` so they surface at the top with a "Last paired" badge.
 *   - Fingerprint-mismatch banner — when a paired device's stored
 *     fingerprint differs from the one returned by `/healthz` on the
 *     same IP, a folded warning surfaces above the list. Catches
 *     mid-pair MITM and cert-rotation cases.
 *
 * iOS Local Network permission is requested up-front via
 * `requestMdnsPermission()`. Permission-denied state offers an
 * `openAppSettings()` deep link.
 */
export function MobileServerScanSheet({ open, onOpenChange }: MobileServerScanSheetProps) {
  const t = useTranslations("mobile.connectionState.scan")
  const router = useRouter()
  const [servers, setServers] = useState<DiscoveredServer[]>([])
  const [scanning, setScanning] = useState(false)
  const [permission, setPermission] = useState<"granted" | "denied" | "prompt" | "unsupported">(
    "prompt"
  )
  const [bannerDismissed, setBannerDismissed] = useState(false)

  // Project the active CompanionConfig (single source of truth for the
  // currently-paired desktop) into the scan-time `paired` opt + a quick
  // lookup map for the mismatch detector. Re-evaluated on every `open`
  // transition so the data is fresh after a recent re-pair — but as a
  // pure `useMemo` so we don't pay a setState-in-effect cascade.
  const pairedSummaries = useMemo<PairedSummary[]>(() => {
    if (!open) return []
    const config = loadCompanionConfig()
    if (!config) return []
    try {
      const u = new URL(config.baseUrl)
      const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
      if (!u.hostname) return []
      return [
        {
          ip: u.hostname,
          port,
          fingerprint: config.serverFingerprint,
          // `lastSeenAt` omitted on purpose — calling Date.now() inside
          // a render-time useMemo is flagged as an impure call. The
          // scanner only uses lastSeenAt for sort tie-break inside the
          // dedupe map, and the paired tier already outranks everything
          // by source, so the field doesn't matter here.
        },
      ]
    } catch {
      return []
    }
  }, [open])

  const pairedFingerprintByIp = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of pairedSummaries) {
      if (p.fingerprint) map.set(p.ip, p.fingerprint.toLowerCase())
    }
    return map
  }, [pairedSummaries])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let cancelled = false

    void (async () => {
      // Reset transient UI state inside the async lambda so React's
      // set-state-in-effect rule is satisfied — these calls run in the
      // microtask queue after the effect setup returns.
      setServers([])
      setScanning(true)
      setBannerDismissed(false)
      const perm = await requestMdnsPermission()
      if (cancelled) return
      setPermission(perm.kind)
      if (perm.kind === "denied") {
        setScanning(false)
        return
      }
      try {
        await scanLan({
          signal: controller.signal,
          paired: pairedSummaries,
          onFound: (server) => {
            if (cancelled) return
            setServers((prev) => {
              const next = prev.filter((s) => s.id !== server.id)
              next.push(server)
              return next
            })
          },
        })
      } finally {
        if (!cancelled) setScanning(false)
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [open, pairedSummaries])

  // Mismatch detection — any server hit on an IP we've paired with
  // before whose fingerprint disagrees with the stored one is flagged.
  // Probe hits without a fingerprint (legacy desktops missing /healthz)
  // don't trigger the banner because we have no positive evidence of
  // rotation; only a strict mismatch raises the alarm.
  const mismatches = useMemo(() => {
    return servers.filter((s) => {
      const expected = pairedFingerprintByIp.get(s.ip)
      if (!expected) return false
      const reported = s.fingerprint?.toLowerCase()
      return !!reported && reported !== expected
    })
  }, [servers, pairedFingerprintByIp])

  function handleSelect(server: DiscoveredServer) {
    const params = new URLSearchParams({ baseUrl: server.baseUrl })
    if (server.fingerprint) params.set("fingerprint", server.fingerprint)
    router.push(`/pair?${params.toString()}`)
    onOpenChange(false)
  }

  const sortedServers = useMemo(() => {
    return servers.slice().sort((a, b) => {
      // Higher rank source first; within same source the most recently
      // discovered wins to keep paired desktops sticky at the top.
      const r = rankSource(b.source) - rankSource(a.source)
      if (r !== 0) return r
      return b.discoveredAt - a.discoveredAt
    })
  }, [servers])

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
            {scanning ? (
              <Loader2Icon
                className="size-3 animate-spin text-muted-foreground"
                aria-label={t("scanning")}
              />
            ) : null}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
          {mismatches.length > 0 && !bannerDismissed ? (
            <Alert
              variant="destructive"
              className="mb-3"
              data-testid="scan-fingerprint-mismatch-banner"
            >
              <AlertTriangleIcon />
              <AlertTitle>{t("fingerprintMismatch.title")}</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  {t("fingerprintMismatch.description", {
                    count: mismatches.length,
                  })}
                </span>
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
                    <Button
                      variant="outline"
                      className={cn(
                        "h-auto w-full justify-between gap-3 py-3 text-left",
                        hasMismatch && "border-destructive/40"
                      )}
                      onClick={() => handleSelect(server)}
                      data-testid={`mobile-server-row-${server.id}`}
                      data-mismatch={hasMismatch ? "true" : "false"}
                    >
                      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                        <span className="flex items-center gap-1.5 truncate text-sm font-semibold">
                          {server.hostname ?? server.ip}
                          {server.source === "paired" ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0 text-[9px] font-normal uppercase text-emerald-700 dark:text-emerald-300"
                              data-testid={`mobile-server-row-${server.id}-paired-badge`}
                            >
                              <PinIcon className="size-2.5" aria-hidden="true" />
                              {t("source.pairedTag")}
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">
                          {server.baseUrl}
                        </span>
                        <span className="text-[9px] font-mono text-muted-foreground">
                          {t("portLabel")}: {server.port}
                        </span>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[9px] uppercase",
                            server.source === "paired" &&
                              "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                            server.source === "mdns" &&
                              "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                            server.source === "probe" &&
                              "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
                            server.source === "history" &&
                              "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400"
                          )}
                        >
                          {t(`source.${server.source}`)}
                        </span>
                        {server.fingerprint ? (
                          <span
                            className={cn(
                              "flex items-center gap-1 text-[9px]",
                              hasMismatch ? "text-destructive" : "text-muted-foreground"
                            )}
                          >
                            <ShieldCheckIcon className="size-3" aria-hidden="true" />
                            {server.fingerprint.slice(0, 6)}…
                          </span>
                        ) : null}
                      </div>
                    </Button>
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
