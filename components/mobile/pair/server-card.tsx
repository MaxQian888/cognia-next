"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRightIcon,
  CircleCheckIcon,
  HistoryIcon,
  MonitorIcon,
  PinIcon,
  RouterIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  WifiIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

/** Transient per-row state for the discover-step pre-flight `/healthz` check. */
export type ServerCardStatus = "idle" | "checking" | "ok" | "error"

export interface ServerCardProps {
  server: DiscoveredServer
  onSelect: (server: DiscoveredServer) => void
  selected?: boolean
  /** Pre-flight check state — drives the trailing affordance + status line. */
  status?: ServerCardStatus
  /** Localized result line shown under the badges when `status` is ok/error. */
  statusLabel?: ReactNode
  /** Stored fingerprint disagrees with the one this server reported. */
  mismatch?: boolean
  /** Blocks taps (e.g. while a pre-flight check is in flight). */
  disabled?: boolean
  className?: string
}

const SOURCE_TO_ICON = {
  paired: PinIcon,
  mdns: WifiIcon,
  // Loopback is this computer, not the network — a monitor reads truer than
  // a Wi-Fi or router glyph for "the Host running right here".
  loopback: MonitorIcon,
  probe: RouterIcon,
  history: HistoryIcon,
} as const

const SOURCE_TO_KEY = {
  paired: "viaPaired",
  mdns: "viaMdns",
  loopback: "viaLoopback",
  probe: "viaProbe",
  history: "viaHistory",
} as const

export function ServerCard({
  server,
  onSelect,
  selected,
  status = "idle",
  statusLabel,
  mismatch = false,
  disabled = false,
  className,
}: ServerCardProps) {
  const t = useTranslations("mobile.pair.discover")
  const Icon = SOURCE_TO_ICON[server.source]
  const sourceKey = SOURCE_TO_KEY[server.source]
  const subtitle = server.hostname && server.hostname !== server.ip ? server.hostname : server.ip
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onSelect(server)}
      disabled={disabled}
      data-testid="pair-server-card"
      data-server-id={server.id}
      data-source={server.source}
      data-selected={selected ? "true" : undefined}
      data-status={status}
      data-mismatch={mismatch ? "true" : undefined}
      aria-pressed={selected}
      aria-busy={status === "checking"}
      className={cn(
        "group h-auto min-h-16 w-full items-center justify-start gap-3 rounded-lg border bg-card p-3 text-left font-normal",
        "active:bg-muted/60",
        selected ? "border-primary/60 bg-primary/5" : "border-border hover:bg-muted/30",
        mismatch && "border-destructive/50",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-10 shrink-0 items-center justify-center rounded-md",
          server.source === "paired" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          server.source === "mdns" && "bg-success/10 text-success",
          server.source === "loopback" && "bg-primary/10 text-primary",
          server.source === "probe" && "bg-warning/10 text-warning",
          server.source === "history" && "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{server.hostname || server.ip}</span>
          {server.fingerprint ? (
            <Badge
              variant="outline"
              className={cn(
                "gap-1 px-1.5 text-[10px]",
                mismatch
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-success/40 bg-success/10 text-success"
              )}
            >
              {mismatch ? (
                <TriangleAlertIcon className="size-3" aria-hidden="true" />
              ) : (
                <ShieldCheckIcon className="size-3" aria-hidden="true" />
              )}
              {mismatch ? t("tlsMismatch") : t("tlsPinned")}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono">
            {subtitle === server.ip ? server.ip : `${subtitle} · ${server.ip}`}
            <span className="ml-1 opacity-70">:{server.port}</span>
          </span>
          {server.serverVersion ? <span className="shrink-0">v{server.serverVersion}</span> : null}
        </div>
        <div className="flex items-center gap-1.5 pt-0.5">
          <Badge variant="secondary" className="px-1.5 text-[10px] uppercase tracking-wide">
            {t(sourceKey)}
          </Badge>
          {typeof server.latencyMs === "number" ? (
            <span className="text-[10px] text-muted-foreground">
              {t("latencyMs", { ms: server.latencyMs })}
            </span>
          ) : null}
          {!server.fingerprint && server.source === "probe" ? (
            <span className="text-[10px] text-muted-foreground">{t("tlsUnverified")}</span>
          ) : null}
        </div>
        {statusLabel && (status === "ok" || status === "error") ? (
          <p
            className={cn(
              "pt-0.5 text-[11px]",
              status === "ok" ? "text-success" : "text-destructive"
            )}
            data-testid="pair-server-card-status"
          >
            {statusLabel}
          </p>
        ) : null}
      </div>
      <TrailingAffordance status={status} mismatch={mismatch} />
    </Button>
  )
}

function TrailingAffordance({
  status,
  mismatch,
}: {
  status: ServerCardStatus
  mismatch: boolean
}) {
  if (status === "checking") {
    return <Spinner className="size-5 shrink-0 text-muted-foreground" />
  }
  if (status === "ok") {
    return <CircleCheckIcon aria-hidden="true" className="size-5 shrink-0 text-success" />
  }
  if (status === "error") {
    return <TriangleAlertIcon aria-hidden="true" className="size-5 shrink-0 text-destructive" />
  }
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "size-5 shrink-0 transition-transform group-hover:translate-x-0.5",
        mismatch ? "text-destructive" : "text-muted-foreground"
      )}
    />
  )
}
