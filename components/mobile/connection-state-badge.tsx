"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftRightIcon, CircleIcon, QrCodeIcon, RefreshCwIcon, WifiIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { runSyncDown, snapshotSyncStates } from "@/lib/sync/companion-sync"
import { transport } from "@/lib/tauri"
import { cn } from "@/lib/utils"

import { MobilePairedServersSheet } from "./connection-state-sheets/mobile-paired-servers-sheet"
import { MobileServerScanSheet } from "./connection-state-sheets/mobile-server-scan-sheet"

/**
 * Connection-state pill with a dropdown affordance (Wave 4 / ADR-0026).
 *
 * Tap the badge to open a dropdown with:
 *   - **Reconnect now** — re-runs the WebRTC handshake (when RTC tier is
 *     enabled) and kicks the sync orchestrator so reads refresh.
 *   - **Scan LAN** — opens a sheet that runs mDNS + IP-segment probes to
 *     re-discover the desktop after a server move or network change.
 *   - **Switch paired server** — lists every previously-paired desktop
 *     (from Dexie `pairedDevices`) so the user can hop between them.
 *   - **Go to /pair** — full pair wizard for adding a new device.
 *
 * A "Sync status" footer shows `lastSyncedAt` for the four high-traffic
 * tables so users can tell at a glance which data may be stale.
 */
export function ConnectionStateBadge({ className }: { className?: string }) {
  const t = useTranslations("mobile.connectionState")
  const state = useConnectionState()
  const router = useRouter()
  const [scanOpen, setScanOpen] = useState(false)
  const [pairedOpen, setPairedOpen] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!state) return null

  const styles = {
    connected: {
      labelKey: "live",
      tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    },
    reconnecting: {
      labelKey: "reconnecting",
      tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    offline: {
      labelKey: "offline",
      tone: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
    },
    unauthenticated: {
      labelKey: "repairNeeded",
      tone: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
    },
  } as const

  const meta = styles[state]
  const label = t(meta.labelKey)

  async function handleReconnect() {
    // Re-run the WebRTC handshake when an RTC tier is active. If no tier
    // is wired (or we got throttled by the 5s defense), the sync kick
    // below still re-establishes the chat list so the UI feels responsive.
    let outcome: "ok" | "no-tier" | "throttled" = "no-tier"
    const txWithRtc = transport as unknown as {
      reconnectRtc?: () => "ok" | "no-tier" | "throttled"
    }
    if (typeof txWithRtc.reconnectRtc === "function") {
      outcome = txWithRtc.reconnectRtc()
    }
    if (outcome === "throttled") {
      toast.info(t("toasts.reconnectThrottled"))
    } else if (outcome === "ok") {
      toast.success(t("toasts.reconnectStarted"))
    }
    try {
      await runSyncDown()
      if (outcome !== "throttled") {
        toast.success(t("toasts.syncKicked"))
      }
    } catch (err) {
      toast.error(t("toasts.syncFailed", { message: err instanceof Error ? err.message : "" }))
    }
  }

  const lastSync = snapshotSyncStates()
  const formatAgo = (ts: number | null): string => {
    if (ts === null) return t("sync.never")
    const diff = now - ts
    if (diff < 60_000) return t("sync.justNow")
    if (diff < 3_600_000) return t("sync.minutesAgo", { n: Math.floor(diff / 60_000) })
    if (diff < 86_400_000) return t("sync.hoursAgo", { n: Math.floor(diff / 3_600_000) })
    return t("sync.daysAgo", { n: Math.floor(diff / 86_400_000) })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("aria.menu", { label })}
            data-testid="connection-state-badge"
            data-state={state}
            className="appearance-none border-none bg-transparent p-0"
          >
            <Badge
              variant="outline"
              role="status"
              className={cn(
                "gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase",
                meta.tone,
                className
              )}
            >
              <CircleIcon className="h-2 w-2 fill-current" aria-hidden="true" />
              {label}
            </Badge>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>{t("menu.title")}</DropdownMenuLabel>
          <DropdownMenuItem
            data-testid="connection-action-reconnect"
            onSelect={() => void handleReconnect()}
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            {t("actions.reconnect")}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="connection-action-scan-lan"
            onSelect={() => setScanOpen(true)}
          >
            <WifiIcon className="size-4" aria-hidden="true" />
            {t("actions.scanLan")}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="connection-action-switch-server"
            onSelect={() => setPairedOpen(true)}
          >
            <ArrowLeftRightIcon className="size-4" aria-hidden="true" />
            {t("actions.switchServer")}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="connection-action-go-to-pair"
            onSelect={() => router.push("/pair")}
          >
            <QrCodeIcon className="size-4" aria-hidden="true" />
            {t("actions.goToPair")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
            {t("sync.heading")}
          </DropdownMenuLabel>
          {(["sessions", "messages", "characters", "workflows"] as const).map((table) => (
            <DropdownMenuItem
              key={table}
              disabled
              className="text-xs"
              data-testid={`connection-sync-row-${table}`}
            >
              <span className="flex-1 font-mono">{table}</span>
              <span className="text-[10px] text-muted-foreground">
                {formatAgo(lastSync[table]?.lastSyncAt ?? null)}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <MobileServerScanSheet open={scanOpen} onOpenChange={setScanOpen} />
      <MobilePairedServersSheet open={pairedOpen} onOpenChange={setPairedOpen} />
    </>
  )
}
