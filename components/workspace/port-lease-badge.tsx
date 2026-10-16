"use client"

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import type { PortLeaseDiagnostic, WorkspacePortLease } from "@/lib/task-workspace/types"

export interface PortLeaseBadgeProps {
  lease?: WorkspacePortLease | null
  occupiedPorts?: number[] | null
  occupancyError?: string | null
  diagnostics?: PortLeaseDiagnostic[]
  loading?: boolean
  error?: string | null
  inert?: boolean
}

/** Presentation only: absent leases and unknown occupancy never trigger allocation or probing. */
export function PortLeaseBadge({
  lease,
  occupiedPorts,
  occupancyError,
  diagnostics = [],
  loading = false,
  error,
  inert = false,
}: PortLeaseBadgeProps) {
  const t = useTranslations("portLease")
  if (inert) return <Badge variant="outline">{t("desktopRequired")}</Badge>
  if (loading) return <Badge variant="outline">{t("loading")}</Badge>
  if (error)
    return (
      <span role="alert" className="text-xs text-destructive">
        {t("readError", { error })}
      </span>
    )
  if (!lease) return <Badge variant="outline">{t("unassigned")}</Badge>

  const relevantDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.leaseIds.includes(lease.leaseId)
  )
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" aria-label={t("label")}>
      <Badge variant="secondary">
        {t("range", {
          base: lease.basePort,
          end: lease.basePort + lease.portCount - 1,
          count: lease.portCount,
        })}
      </Badge>
      <Badge variant="outline">
        {lease.namespaceKey === "host-loopback"
          ? t("host")
          : t("runtime", { namespace: lease.namespaceKey })}
      </Badge>
      <Badge variant={occupiedPorts?.length ? "secondary" : "outline"}>
        {occupiedPorts === undefined
          ? t("occupancyUnchecked")
          : occupiedPorts === null
            ? t("occupancyUnavailable")
            : occupiedPorts.length
              ? t("occupied", { ports: occupiedPorts.join(", ") })
              : t("unoccupied")}
      </Badge>
      {occupancyError && <span className="text-muted-foreground">{occupancyError}</span>}
      {relevantDiagnostics.map((diagnostic, index) => (
        <Badge key={`${diagnostic.kind}-${index}`} variant="destructive" title={diagnostic.detail}>
          {t(`diagnostics.${diagnostic.kind}`)}
        </Badge>
      ))}
    </span>
  )
}
