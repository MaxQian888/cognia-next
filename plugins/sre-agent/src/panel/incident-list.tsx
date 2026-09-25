"use client"

import { useMemo, useState } from "react"
import { AlertOctagonIcon, AlertTriangleIcon, InfoIcon, PlusIcon, RadarIcon } from "lucide-react"
import { Button } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { PLUGIN_ID } from "../ids"
import type { SreRuntime } from "../runtime"
import type { SreIncident, SreIncidentSeverity, SreIncidentStatus } from "../incident/model"
import { SourcesCard } from "./sources-card"
import { TOUCH_BUTTON } from "./touch"

type Group = "investigating" | "unconfirmed" | "closed"

const GROUP_STATUSES: Record<Group, SreIncidentStatus[]> = {
  investigating: ["investigating"],
  unconfirmed: ["unconfirmed"],
  closed: ["resolved", "dismissed"],
}

/**
 * Severity is carried by an icon AND a word, the colour only reinforces it —
 * a red/amber/grey dot alone says nothing to someone who cannot tell them apart.
 */
const SEVERITY_STYLE: Record<SreIncidentSeverity, { Icon: typeof AlertOctagonIcon; tone: string }> =
  {
    critical: { Icon: AlertOctagonIcon, tone: "text-destructive" },
    warning: { Icon: AlertTriangleIcon, tone: "text-warning" },
    info: { Icon: InfoIcon, tone: "text-muted-foreground" },
  }

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

export function SeverityLabel({ severity }: { severity: SreIncidentSeverity }) {
  const t = usePluginTranslations(PLUGIN_ID)
  const { Icon, tone } = SEVERITY_STYLE[severity]
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs", tone)}
      data-testid="sre-severity"
      data-severity={severity}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span>{t(`severity.${severity}`)}</span>
    </span>
  )
}

export function IncidentList({
  incidents,
  runtime,
  canCreate,
  onOpen,
  onNew,
  onOpenDemo,
}: {
  incidents: readonly SreIncident[]
  runtime: SreRuntime
  /** False outside a session: an incident belongs to the conversation it came from. */
  canCreate: boolean
  onOpen: (incidentId: string) => void
  /** Start the "describe the incident" form. */
  onNew: () => void
  /** Open the incident that ships with the demo corpus. */
  onOpenDemo: () => void
}) {
  const t = usePluginTranslations(PLUGIN_ID)
  const groups = useMemo(() => groupIncidents(incidents), [incidents])
  const [group, setGroup] = useState<Group>("investigating")
  const rows = groups[group]
  const demo = runtime.provider().demo

  if (incidents.length === 0) {
    return (
      <div className="space-y-4 p-3" data-testid="sre-incident-empty">
        <div className="space-y-2 py-4 text-center">
          <RadarIcon aria-hidden className="mx-auto size-6 text-muted-foreground" />
          <p className="text-sm">{t("list.empty.title")}</p>
          <p className="text-xs text-muted-foreground">{t("list.empty.body")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className={TOUCH_BUTTON}
              disabled={!canCreate}
              onClick={onNew}
              data-testid="sre-create-incident"
            >
              {t("list.empty.create")}
            </Button>
            {demo ? (
              <Button
                size="sm"
                variant="outline"
                className={TOUCH_BUTTON}
                onClick={onOpenDemo}
                data-testid="sre-create-from-alert"
              >
                {t("list.empty.fromAlert")}
              </Button>
            ) : null}
          </div>
          {!canCreate ? (
            <p className="text-xs text-muted-foreground">{t("create.noSession")}</p>
          ) : null}
        </div>
        <SourcesCard runtime={runtime} />
      </div>
    )
  }

  return (
    <div className="space-y-2 p-3" data-testid="sre-incident-list">
      <div className="flex flex-wrap items-center gap-1">
        {(Object.keys(GROUP_STATUSES) as Group[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setGroup(candidate)}
            aria-pressed={group === candidate}
            className={cn(
              "min-h-9 rounded-pill px-3 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-7 sm:px-2",
              group === candidate
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground [@media(hover:hover)]:hover:bg-muted"
            )}
          >
            {t(`list.filter.${candidate}`, { count: groups[candidate].length })}
          </button>
        ))}
        <Button
          size="sm"
          variant="outline"
          className={cn(TOUCH_BUTTON, "ml-auto")}
          disabled={!canCreate}
          onClick={onNew}
          data-testid="sre-new-incident"
        >
          <PlusIcon aria-hidden className="size-3" />
          {t("list.new")}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">{t("list.noneInFilter")}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                className="flex min-h-11 w-full items-start gap-2 rounded-sm py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:hover)]:hover:bg-muted/50"
                onClick={() => onOpen(incident.id)}
                data-testid="sre-incident-row"
              >
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-xs break-words">{incident.title}</span>
                  <span className="block text-xs break-words text-muted-foreground">
                    {incident.services.join(" · ") || incident.environment}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <SeverityLabel severity={incident.severity} />
                    {incident.demo ? (
                      <span
                        className="rounded-pill bg-muted px-1.5 text-[10px] text-muted-foreground"
                        data-testid="sre-incident-demo-tag"
                      >
                        {t("demo.badge")}
                      </span>
                    ) : null}
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
