"use client"

/**
 * ProviderHealthStatus — slim cognia-next version.
 *
 * Cognia's component reads the live provider-manager health metrics
 * (latency p95, error rate, rate-limit headroom) from the routing
 * engine. cognia-next deferred that infrastructure per the provider
 * port plan; this version surfaces just the verification status from
 * `UserProviderSettings.verificationStatus` and the last test outcome
 * stored in the hook's local state.
 */

import { Activity, AlertTriangle, CheckCircle, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"

interface ProviderHealthStatusProps {
  providerId: string
  className?: string
  compact?: boolean
}

type HealthStatus = "healthy" | "degraded" | "error" | "unknown"

const STATUS_ICONS: Record<HealthStatus, React.ReactNode> = {
  healthy: <CheckCircle className="h-4 w-4 text-green-500" />,
  degraded: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
  error: <XCircle className="h-4 w-4 text-red-500" />,
  unknown: <Activity className="h-4 w-4 text-muted-foreground" />,
}

export function ProviderHealthStatus({
  providerId,
  className,
  compact = false,
}: ProviderHealthStatusProps) {
  const settings = useSettingsStore((s) => s.providerSettings[providerId])

  const status: HealthStatus = (() => {
    if (!settings?.apiKey && !settings?.baseURL) return "unknown"
    if (settings?.verificationStatus === "verified") return "healthy"
    if (settings?.verificationStatus === "stale") return "degraded"
    if (settings?.healthStatus === "error") return "error"
    return "unknown"
  })()

  const label = compact
    ? status.toUpperCase()
    : status === "healthy"
      ? "Verified"
      : status === "degraded"
        ? "Stale"
        : status === "error"
          ? "Error"
          : "Unknown"

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {STATUS_ICONS[status]}
      <Badge variant="outline" className="text-xs">
        {label}
      </Badge>
    </div>
  )
}

export default ProviderHealthStatus
