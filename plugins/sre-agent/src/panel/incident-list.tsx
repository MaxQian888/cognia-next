"use client"

import { useMemo, useState } from "react"
import { RadarIcon } from "lucide-react"
import { Button } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import type { SreRuntime } from "../runtime"
import type { SreIncident, SreIncidentStatus } from "../incident/model"
import { usePluginT } from "../use-plugin-t"
import { SourcesCard } from "./sources-card"

type Group = "investigating" | "unconfirmed" | "closed"

const GROUP_STATUSES: Record<Group, SreIncidentStatus[]> = {
  investigating: ["investigating"],
  unconfirmed: ["unconfirmed"],
  closed: ["resolved", "dismissed"],
}

const SEVERITY_TONE = {
  critical: "bg-destructive",
  warning: "bg-amber-500",
  info: "bg-muted-foreground/50",
} as const

/** Split incidents into the three groups the filter row offers. */
export function groupIncidents(incidents: readonly SreIncident[]): Record<Group, SreIncident[]> {
  return {
    investigating: incidents.filter((incident) => incident.status === "investigating"),
    unconfirmed: incidents.filter((incident) => incident.status === "unconfirmed"),
    closed: incidents.filter(
      (incident) => incident.status === "resolved" || incident.status === "dismissed"
    ),
  }
}

export function IncidentList({
  incidents,
  runtime,
  canCreate,
  onOpen,
  onCreate,
  onCreateFromAlert,
}: {
  incidents: readonly SreIncident[]
  runtime: SreRuntime
  canCreate: boolean
  onOpen: (incidentId: string) => void
  onCreate: () => void
  onCreateFromAlert: () => void
}) {
  const t = usePluginT()
  const groups = useMemo(() => groupIncidents(incidents), [incidents])
  const [group, setGroup] = useState<Group>("investigating")
  const rows = groups[group]

  if (incidents.length === 0) {
    return (
      <div className="space-y-4 p-3" data-testid="sre-incident-empty">
        <div className="space-y-2 py-4 text-center">
          <RadarIcon className="mx-auto size-6 text-muted-foreground" />
          <p className="text-sm">{t("list.empty.title")}</p>
          <p className="text-xs text-muted-foreground">{t("list.empty.body")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canCreate}
              onClick={onCreate}
              data-testid="sre-create-incident"
            >
              {t("list.empty.create")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={onCreateFromAlert}
              data-testid="sre-create-from-alert"
            >
              {t("list.empty.fromAlert")}
            </Button>
          </div>
        </div>
        <SourcesCard runtime={runtime} />
      </div>
    )
  }

  return (
    <div className="space-y-2 p-3" data-testid="sre-incident-list">
      <div className="flex flex-wrap gap-1">
        {(Object.keys(GROUP_STATUSES) as Group[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setGroup(candidate)}
            aria-pressed={group === candidate}
            className={cn(
              "rounded-pill px-2 py-0.5 text-xs",
              group === candidate
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            {t(`list.filter.${candidate}`, { count: groups[candidate].length })}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">{t("list.noneInFilter")}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                className="flex w-full items-start gap-2 py-2 text-left hover:bg-muted/50"
                onClick={() => onOpen(incident.id)}
                data-testid="sre-incident-row"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    SEVERITY_TONE[incident.severity]
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{incident.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {incident.services.join(" · ") || incident.environment}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-xs text-muted-foreground">
                    {t(`status.${incident.status}`)}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">
                    {t("list.evidenceCount", { count: incident.evidenceIds.length })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
