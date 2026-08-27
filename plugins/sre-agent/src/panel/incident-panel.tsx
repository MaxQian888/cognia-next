"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeftIcon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useElementWidth } from "@/hooks/use-element-width"
import { cn } from "@/lib/utils"
import type { ContextPanelRenderProps } from "@/types/context-workbench"
import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import { FIXTURE_ALERT } from "../fixtures"
import type { SreRuntime } from "../runtime"
import { defaultIncidentWindow } from "../runtime"
import {
  applyTimeline,
  applyValidation,
  attachEvidence,
  compareIncidents,
  concludeIncident,
  confirmIncident,
  createIncident,
  createIncidentFromAlert,
  dismissIncident,
  reopenIncident,
  type SreIncident,
} from "../incident/model"
import {
  deleteIncident as deleteIncidentRow,
  listIncidentsForSession,
  listIncidents,
  putIncident,
} from "../incident/store"
import {
  peekSrePanelRuntime,
  recentSreToolActivity,
  subscribeSreToolActivity,
  type SreToolActivity,
} from "../panel-runtime"
import { PANEL_ID } from "../ids"
import { usePluginT } from "../use-plugin-t"
import { ConclusionCard } from "./conclusion-card"
import { IncidentList } from "./incident-list"
import { LogLens } from "./log-lens"
import { PhaseStrip } from "./phase-strip"
import { TimelineTable } from "./timeline-table"

/**
 * Width at which the panel stops being a column and starts being a workbench.
 *
 * Measured off the panel's own element, not the viewport: this lives in a
 * resizable right-hand dock, so a media query would report the window and get
 * it wrong in both directions.
 */
const WIDE_AT_PX = 560

const nowIso = () => new Date().toISOString()

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `inc_${crypto.randomUUID()}`
    : `inc_${Math.random().toString(36).slice(2)}`

/** Activity published after this incident was opened — what the agent did for it. */
export function activityForIncident(
  activity: readonly SreToolActivity[],
  incident: SreIncident
): SreToolActivity[] {
  return activity.filter((entry) => entry.at >= incident.createdAt)
}

/**
 * Evidence the agent fetched that this incident has not pinned, split by how
 * pinning it has to re-fetch it.
 *
 * Log evidence is re-read through `queryLogs` (the ids only address rows inside
 * a window); everything else resolves out of the runtime's pool. The split
 * lives here, in one place, because the badge counts these ids and the pin
 * button acts on them — computing it twice is how a button that says "pin 7"
 * ends up pinning a different 7.
 */
export function unpinnedAgentEvidenceByKind(
  activity: readonly SreToolActivity[],
  incident: SreIncident
): { logIds: string[]; pooledIds: string[] } {
  const pinned = new Set(incident.evidenceIds)
  const entries = activityForIncident(activity, incident)
  const collect = (fromLogs: boolean) => [
    ...new Set(
      entries
        .filter((entry) => (entry.tool === "sre_query_logs") === fromLogs)
        .flatMap((entry) => entry.evidenceIds)
        .filter((id) => !pinned.has(id))
    ),
  ]
  return { logIds: collect(true), pooledIds: collect(false) }
}

/** Evidence the agent fetched that this incident has not pinned. */
export function unpinnedAgentEvidence(
  activity: readonly SreToolActivity[],
  incident: SreIncident
): string[] {
  const { logIds, pooledIds } = unpinnedAgentEvidenceByKind(activity, incident)
  return [...new Set([...logIds, ...pooledIds])]
}

/** Latest timeline the agent submitted to the validator for this incident. */
export function latestAgentTimeline(
  activity: readonly SreToolActivity[],
  incident: SreIncident
): SreToolActivity | null {
  return (
    [...activityForIncident(activity, incident)]
      .reverse()
      .find((entry) => entry.timelineDraft && entry.validation) ?? null
  )
}

/**
 * The SRE incident panel — the plugin's whole UI, mounted in the right-hand
 * Context Workbench beside the conversation it belongs to.
 *
 * Incidents are held in component state and written through to the plugin's
 * private Dexie table. Not `useLiveQuery`: this panel is the only writer, so a
 * live query would buy nothing but a second source of truth to keep in step.
 */
export function IncidentPanel({ resource, active }: ContextPanelRenderProps) {
  const t = usePluginT()
  const bridge = peekSrePanelRuntime()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const width = useElementWidth(containerRef)
  const wide = width >= WIDE_AT_PX

  const sessionId = resource.kind === "session" ? resource.sessionId : undefined
  const [incidents, setIncidents] = useState<SreIncident[]>([])
  /**
   * Whether the STORED rows have arrived. `loaded` below folds in the no-storage
   * shell, where there is nothing to wait for — deriving it that way keeps the
   * effect from having to write state synchronously just to unblock the render.
   */
  const [rowsLoaded, setRowsLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [activity, setActivity] = useState<readonly SreToolActivity[]>(() =>
    recentSreToolActivity()
  )

  const runtime = bridge?.runtime ?? null
  const dexie = bridge?.dexie ?? null

  useEffect(() => subscribeSreToolActivity(setActivity), [])

  useEffect(() => {
    if (!dexie) return
    let cancelled = false
    const load = sessionId
      ? listIncidentsForSession(dexie as PluginDexieAPI, sessionId)
      : listIncidents(dexie as PluginDexieAPI)
    load
      .then((rows) => {
        if (cancelled) return
        setIncidents(rows)
        setRowsLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setRowsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [dexie, sessionId])

  const loaded = !dexie || rowsLoaded

  const openCount = useMemo(
    () => incidents.filter((incident) => incident.status === "investigating").length,
    [incidents]
  )

  // Push the open count onto this panel's own rail button. Without it the only
  // way to learn an investigation is running is to open the panel and look —
  // which is the one thing a person on call does not have time to do.
  useEffect(() => {
    bridge?.contextPanels?.setBadge(PANEL_ID, openCount)
  }, [bridge, openCount])

  /** Write one incident through to state and, when there is one, to storage. */
  const save = useCallback(
    (incident: SreIncident) => {
      setIncidents((previous) => {
        const without = previous.filter((entry) => entry.id !== incident.id)
        return [...without, incident].sort(compareIncidents)
      })
      if (dexie) void putIncident(dexie, incident)
    },
    [dexie]
  )

  const selected = useMemo(
    () => incidents.find((incident) => incident.id === selectedId) ?? null,
    [incidents, selectedId]
  )

  const openIncident = useCallback(
    (incident: SreIncident) => {
      save(incident)
      setSelectedId(incident.id)
    },
    [save]
  )

  const createHere = useCallback(() => {
    if (!runtime) return
    openIncident(
      createIncident({
        id: newId(),
        now: nowIso(),
        title: t("panel.title"),
        environment: "prod",
        window: defaultIncidentWindow(),
        sessionId,
      })
    )
  }, [openIncident, runtime, sessionId, t])

  const createFromAlert = useCallback(() => {
    openIncident(
      createIncidentFromAlert(
        {
          time: FIXTURE_ALERT.time,
          severity: FIXTURE_ALERT.severity as "info" | "warning" | "critical",
          service: FIXTURE_ALERT.service,
          message: FIXTURE_ALERT.message,
          provider: FIXTURE_ALERT.provider,
          model: FIXTURE_ALERT.model,
        },
        { id: newId(), now: nowIso(), environment: "prod", sessionId }
      )
    )
  }, [openIncident, sessionId])

  /**
   * Pin evidence by fetching it first.
   *
   * The fetch is the point, not a formality: `sre_validate_timeline` resolves
   * ids against the runtime's evidence pool, and an id pinned without a query
   * behind it comes back `row.evidence_unknown` on the very next check. Only
   * ids the backend actually returned are attached.
   */
  const pin = useCallback(
    async (incident: SreIncident, evidenceIds: string[]) => {
      if (!runtime || evidenceIds.length === 0) return
      const result = await runtime.queryLogs({
        environment: incident.environment,
        ...incident.window,
        ids: evidenceIds,
      })
      save(attachEvidence(incident, result.evidenceIds, nowIso()))
    },
    [runtime, save]
  )

  const pinAgentEvidence = useCallback(
    async (incident: SreIncident) => {
      if (!runtime) return
      const { logIds, pooledIds } = unpinnedAgentEvidenceByKind(activity, incident)
      const resolved = runtime.resolveEvidenceIds(pooledIds)
      const logs =
        logIds.length > 0
          ? await runtime.queryLogs({
              environment: incident.environment,
              ...incident.window,
              ids: logIds,
            })
          : null
      save(attachEvidence(incident, [...(logs?.evidenceIds ?? []), ...resolved], nowIso()))
    },
    [activity, runtime, save]
  )

  const validate = useCallback(
    async (incident: SreIncident) => {
      if (!runtime) return
      setValidating(true)
      try {
        const result = await runtime.validateTimeline({
          rows: incident.timeline,
          findings: incident.findings,
          recommendations: incident.recommendations,
        })
        save(applyValidation(incident, result, nowIso()))
      } finally {
        setValidating(false)
      }
    },
    [runtime, save]
  )

  const remove = useCallback(
    (incident: SreIncident) => {
      setIncidents((previous) => previous.filter((entry) => entry.id !== incident.id))
      setSelectedId(null)
      if (dexie) void deleteIncidentRow(dexie, incident.id)
    },
    [dexie]
  )

  if (!runtime) {
    return (
      <div className="space-y-2 p-4" data-testid="sre-unavailable">
        <div className="flex items-center gap-2">
          <ShieldAlertIcon className="size-4 text-destructive" />
          <h2 className="text-sm font-medium">{t("panel.unavailable.title")}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{t("panel.unavailable.body")}</p>
      </div>
    )
  }

  if (!loaded) {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-testid="sre-loading">
        {t("panel.loading")}
      </p>
    )
  }

  const unpinned = selected ? unpinnedAgentEvidence(activity, selected) : []
  const observed = selected
    ? activityForIncident(activity, selected).filter((entry) => entry.evidenceIds.length > 0).length
    : 0
  const agentTimeline = selected ? latestAgentTimeline(activity, selected) : null
  const agentTimelineDraft = agentTimeline?.timelineDraft
  const agentTimelineValidation = agentTimeline?.validation

  return (
    <div ref={containerRef} className="flex h-full flex-col" data-testid="sre-panel">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {selected ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("panel.back")}
            onClick={() => setSelectedId(null)}
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {selected ? selected.title : t("panel.title")}
        </h2>
        {selected ? (
          <span className="shrink-0 rounded-pill bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t(`severity.${selected.severity}`)}
          </span>
        ) : null}
      </header>

      {!dexie ? (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-amber-700 dark:text-amber-500">
          {t("panel.storageUnavailable")}
        </p>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {!selected ? (
          <IncidentList
            incidents={incidents}
            runtime={runtime as SreRuntime}
            canCreate={Boolean(sessionId)}
            onOpen={setSelectedId}
            onCreate={createHere}
            onCreateFromAlert={createFromAlert}
          />
        ) : (
          <div className={cn("space-y-4 p-3", wide && "px-4")} data-wide={wide || undefined}>
            <PhaseStrip incident={selected} compact={!wide} />

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground" data-testid="sre-agent-activity">
                {observed > 0 ? t("agent.observed", { count: observed }) : t("agent.idle")}
              </span>
              {unpinned.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => void pinAgentEvidence(selected)}
                  data-testid="sre-pin-agent-evidence"
                >
                  {t("agent.pinLatest", { count: unpinned.length })}
                </Button>
              ) : null}
            </div>

            <LogLens
              incident={selected}
              runtime={runtime as SreRuntime}
              wide={wide}
              enabled={active}
              pinnedIds={selected.evidenceIds}
              onPin={(ids) => void pin(selected, ids)}
            />

            <TimelineTable
              incident={selected}
              validating={validating}
              onValidate={() => void validate(selected)}
            />
            {agentTimelineDraft && agentTimelineValidation ? (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  const withTimeline = applyTimeline(selected, agentTimelineDraft, nowIso())
                  save(applyValidation(withTimeline, agentTimelineValidation, nowIso()))
                }}
                data-testid="sre-apply-agent-timeline"
              >
                {t("agent.applyTimeline")}
              </Button>
            ) : null}

            <ConclusionCard
              incident={selected}
              onConclude={() => save(concludeIncident(selected, nowIso()))}
            />

            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              {selected.status === "unconfirmed" ? (
                <Button
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => save(confirmIncident(selected, nowIso()))}
                  data-testid="sre-confirm"
                >
                  {t("actions.confirm")}
                </Button>
              ) : null}
              {selected.status === "investigating" || selected.status === "unconfirmed" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => save(dismissIncident(selected, nowIso()))}
                  data-testid="sre-dismiss"
                >
                  {t("actions.dismiss")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => save(reopenIncident(selected, nowIso()))}
                  data-testid="sre-reopen"
                >
                  {t("actions.reopen")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={() => remove(selected)}
                data-testid="sre-delete"
              >
                {t("actions.delete")}
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">{t("panel.readOnly")}</span>
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
