"use client"

import { useTranslations } from "next-intl"
import { ChevronRightIcon, HistoryIcon, RouterIcon, ShieldCheckIcon, WifiIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

export interface ServerCardProps {
  server: DiscoveredServer
  onSelect: (server: DiscoveredServer) => void
  selected?: boolean
  className?: string
}

const SOURCE_TO_ICON = {
  mdns: WifiIcon,
  probe: RouterIcon,
  history: HistoryIcon,
} as const

const SOURCE_TO_KEY = {
  mdns: "viaMdns",
  probe: "viaProbe",
  history: "viaHistory",
} as const

export function ServerCard({ server, onSelect, selected, className }: ServerCardProps) {
  const t = useTranslations("mobile.pair.discover")
  const Icon = SOURCE_TO_ICON[server.source]
  const sourceKey = SOURCE_TO_KEY[server.source]
  const subtitle = server.hostname && server.hostname !== server.ip ? server.hostname : server.ip
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onSelect(server)}
      data-testid="pair-server-card"
      data-server-id={server.id}
      data-source={server.source}
      data-selected={selected ? "true" : undefined}
      aria-pressed={selected}
      className={cn(
        "group h-auto min-h-16 w-full items-center justify-start gap-3 rounded-lg border bg-card p-3 text-left font-normal",
        "active:bg-muted/60",
        selected ? "border-primary/60 bg-primary/5" : "border-border hover:bg-muted/30",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-10 shrink-0 items-center justify-center rounded-md",
          server.source === "mdns" && "bg-success/10 text-success",
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
              className="gap-1 border-success/40 bg-success/10 px-1.5 text-[10px] text-success"
            >
              <ShieldCheckIcon className="size-3" aria-hidden="true" />
              {t("tlsPinned")}
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
      </div>
      <ChevronRightIcon
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </Button>
  )
}
