"use client"

/**
 * ConnectionStatusBadge — shared status pill for external (ACP) agents.
 *
 * Extracted from `selector.tsx` and `manager.tsx`, which each carried an
 * identical copy of the status→variant map. The manager layout renders a
 * leading icon (`withIcon`); the selector layout uses a smaller pill via
 * `className`.
 */

import { useTranslations } from "next-intl"
import { Activity, AlertCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ExternalAgentConnectionStatus } from "@/types/agent/external-agent"

/**
 * One outlined pill per status, separated by tint rather than by weight.
 *
 * Connected and error used to be the only filled variants, which made a status
 * line carrying either of them the loudest thing on the row. An error pill
 * beside an agent name was reading as an alert about the panel rather than as
 * one field of that agent's state, and the icon it carried was the same size as
 * the agent's own controls. The tints are the ones already used for the same
 * two meanings elsewhere in settings.
 */
const STATUS_CONFIG: Record<
  ExternalAgentConnectionStatus,
  { labelKey: string; variant: "default" | "secondary" | "destructive" | "outline"; tint: string }
> = {
  disconnected: {
    labelKey: "statusDisconnected",
    variant: "outline",
    tint: "text-muted-foreground",
  },
  connecting: { labelKey: "statusConnecting", variant: "outline", tint: "text-muted-foreground" },
  connected: {
    labelKey: "statusConnected",
    variant: "outline",
    tint: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  reconnecting: {
    labelKey: "statusReconnecting",
    variant: "outline",
    tint: "text-muted-foreground",
  },
  error: {
    labelKey: "statusError",
    variant: "outline",
    tint: "border-destructive/40 bg-destructive/10 text-destructive",
  },
}

export function ConnectionStatusBadge({
  status,
  withIcon = false,
  className,
}: {
  status: ExternalAgentConnectionStatus
  /** Render a leading icon for connected/error states (manager layout). */
  withIcon?: boolean
  className?: string
}) {
  const t = useTranslations("externalAgent")
  const config = STATUS_CONFIG[status]
  return (
    <Badge variant={config.variant} className={cn("text-xs font-normal", config.tint, className)}>
      {withIcon && status === "connected" && <Activity className="mr-1 size-3" />}
      {withIcon && status === "error" && <AlertCircle className="mr-1 size-3" />}
      {t(config.labelKey)}
    </Badge>
  )
}
