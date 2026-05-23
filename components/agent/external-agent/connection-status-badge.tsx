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

const STATUS_CONFIG: Record<
  ExternalAgentConnectionStatus,
  { labelKey: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  disconnected: { labelKey: "statusDisconnected", variant: "outline" },
  connecting: { labelKey: "statusConnecting", variant: "secondary" },
  connected: { labelKey: "statusConnected", variant: "default" },
  reconnecting: { labelKey: "statusReconnecting", variant: "secondary" },
  error: { labelKey: "statusError", variant: "destructive" },
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
    <Badge variant={config.variant} className={cn("text-xs", className)}>
      {withIcon && status === "connected" && <Activity className="mr-1 h-3 w-3" />}
      {withIcon && status === "error" && <AlertCircle className="mr-1 h-3 w-3" />}
      {t(config.labelKey)}
    </Badge>
  )
}
