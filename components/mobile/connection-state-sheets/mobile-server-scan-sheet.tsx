"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Loader2Icon, ShieldCheckIcon, WifiIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { type DiscoveredServer, scanLan } from "@/lib/connectivity/lan-scanner"
import { requestMdnsPermission } from "@/lib/connectivity/mdns-permission"
import { cn } from "@/lib/utils"

import { EmptyState } from "@/components/mobile/empty-state"

export interface MobileServerScanSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Bottom sheet that drives `scanLan()` and renders discovered cognia
 * desktops grouped by source (`mdns` / `probe` / `history`). Tapping a row
 * navigates to `/pair?baseUrl=<...>&fingerprint=<...>` so the pair page
 * can pre-fill the form (Wave 4 / ADR-0026).
 *
 * iOS Local Network permission is requested up-front via
 * `requestMdnsPermission()`. If the user has previously denied, the
 * permission-denied banner offers an `openAppSettings()` deep link.
 */
export function MobileServerScanSheet({ open, onOpenChange }: MobileServerScanSheetProps) {
  const t = useTranslations("mobile.connectionState.scan")
  const router = useRouter()
  const [servers, setServers] = useState<DiscoveredServer[]>([])
  const [scanning, setScanning] = useState(false)
  const [permission, setPermission] = useState<"granted" | "denied" | "prompt" | "unsupported">(
    "prompt"
  )

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let cancelled = false

    void (async () => {
      // Both `setServers([])` and `setScanning(true)` happen inside the
      // async body so they queue as microtask continuations rather than
      // synchronous render-time side effects.
      setServers([])
      setScanning(true)
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
  }, [open])

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
            {scanning ? (
              <Loader2Icon
                className="size-3 animate-spin text-muted-foreground"
                aria-label={t("scanning")}
              />
            ) : null}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
          {permission === "denied" ? (
            <EmptyState
              icon={WifiIcon}
              title={t("mdnsDenied")}
              cta={{
                label: t("openSettings"),
                onSelect: () => void openAppSettings(),
              }}
            />
          ) : servers.length === 0 && !scanning ? (
            <EmptyState icon={WifiIcon} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="mobile-server-scan-list">
              {servers
                .slice()
                .sort((a, b) => b.discoveredAt - a.discoveredAt)
                .map((server) => (
                  <li key={server.id}>
                    <Button
                      variant="outline"
                      className="h-auto w-full justify-between gap-3 py-3 text-left"
                      onClick={() => handleSelect(server)}
                      data-testid={`mobile-server-row-${server.id}`}
                    >
                      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                        <span className="truncate text-sm font-semibold">
                          {server.hostname ?? server.ip}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">
                          {server.baseUrl}
                        </span>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[9px] uppercase",
                            server.source === "mdns" &&
                              "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                            server.source === "probe" &&
                              "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
                            server.source === "history" &&
                              "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400"
                          )}
                        >
                          {t(`source.${server.source}`)}
                        </span>
                        {server.fingerprint ? (
                          <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
                            <ShieldCheckIcon className="size-3" aria-hidden="true" />
                            {server.fingerprint.slice(0, 6)}…
                          </span>
                        ) : null}
                      </div>
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
