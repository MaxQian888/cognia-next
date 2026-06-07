"use client"

/**
 * Compact status badges for one LSP server row: binary detection
 * (installed / managed / missing) plus runtime health when the server has
 * been started this session (running / starting / crashed / broken).
 * During a one-click install the install phase replaces the detection
 * badge. Renders nothing when no status is known (web/mobile — the status
 * store is inert there).
 */

import { useTranslations } from "next-intl"
import type { LspServerStatus } from "@/types/lsp/config"
import type { LspInstallProgressEvent } from "@/lib/plugin/lsp/lsp-client-adapter-tauri"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export interface LspServerStatusBadgeProps {
  status?: LspServerStatus
  progress?: LspInstallProgressEvent
}

const HEALTH_CLASS: Record<LspServerStatus["health"], string> = {
  running: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  starting: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  crashed: "border-transparent bg-destructive/15 text-destructive",
  broken: "border-transparent bg-destructive/20 text-destructive",
  stopped: "",
}

export function LspServerStatusBadge({ status, progress }: LspServerStatusBadgeProps) {
  const t = useTranslations("settings.lspServers")
  if (!status) return null

  const installing = progress && (progress.phase === "resolving" || progress.phase === "installing")

  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid={`lsp-status-badge-${status.serverId}`}
    >
      {installing ? (
        <Badge variant="outline" className="animate-pulse text-[10px]">
          {t(`install.phase.${progress.phase}`)}
        </Badge>
      ) : (
        <Badge
          variant={status.install === "missing" ? "destructive" : "outline"}
          className="text-[10px]"
          title={status.resolvedPath ?? status.lastError}
        >
          {t(`status.${status.install}`)}
        </Badge>
      )}
      {status.health !== "stopped" ? (
        <Badge
          variant="outline"
          className={cn("text-[10px]", HEALTH_CLASS[status.health])}
          title={status.lastError}
        >
          {t(`health.${status.health}`)}
          {status.restarts > 0 ? ` ×${status.restarts}` : ""}
        </Badge>
      ) : null}
    </span>
  )
}
