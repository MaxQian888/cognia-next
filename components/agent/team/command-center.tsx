"use client"

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNow, useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useIsMobile } from "@/hooks/ui"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import {
  controlDurableRuns,
  type DurableRunControlAction,
} from "@/lib/ai/agent/team/durable-control"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"

const ACTIONS: Array<{
  action: DurableRunControlAction
  icon: typeof PauseIcon
}> = [
  { action: "pause", icon: PauseIcon },
  { action: "resume", icon: PlayIcon },
  { action: "sleep", icon: MoonIcon },
  { action: "wake", icon: RefreshCwIcon },
  { action: "stop", icon: SquareIcon },
  { action: "terminate", icon: XCircleIcon },
]

export interface AgentTeamCommandCenterProps {
  /**
   * Draw the section's own title. False inside a page that already has a
   * header — two stacked titles saying the same thing is noise, and it costs
   * a screenful before the first run row.
   */
  heading?: boolean
}

export function AgentTeamCommandCenter({
  heading = true,
}: AgentTeamCommandCenterProps = {}): React.ReactElement {
  const t = useTranslations("agentTeamsWorkspace.commandCenter")
  const now = useNow().getTime()
  const teams = useAgentTeamStore((state) => state.teams)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<AgentTeamRunStatus | "all">("all")
  const [repository, setRepository] = useState("all")
  const [project, setProject] = useState("all")
  const [teamFilter, setTeamFilter] = useState("all")
  const [runtime, setRuntime] = useState("all")
  const [gate, setGate] = useState("all")
  const [failureClass, setFailureClass] = useState("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // A phone gets the same controls, arranged for a phone. Seven dropdowns and
  // six always-disabled buttons stacked above the first run is the desktop
  // console poured into a column: four rows of chrome before any answer to
  // "what is happening", on the surface whose whole job is to say that.
  const isMobile = useIsMobile()
  const [filtersOpen, setFiltersOpen] = useState(false)

  const snapshot = useLiveQuery(
    async () => {
      const db = getDb()
      const [runs, children, graphs, deliveryNodes, retrospectives] = await Promise.all([
        db.agentTeamRuns.toArray(),
        db.agentTeamChildRuns.toArray(),
        db.agentTeamDeliveryGraphs.toArray(),
        db.agentTeamDeliveryNodes.toArray(),
        db.agentTeamRetrospectives.toArray(),
      ])
      return { runs, children, graphs, deliveryNodes, retrospectives }
    },
    [],
    { runs: [], children: [], graphs: [], deliveryNodes: [], retrospectives: [] }
  )

  const repositories = useMemo(
    () => [...new Set(snapshot.children.map((child) => child.repositoryId))].sort(),
    [snapshot.children]
  )
  const projects = useMemo(
    () =>
      [...new Set(snapshot.runs.flatMap((run) => (run.projectId ? [run.projectId] : [])))].sort(),
    [snapshot.runs]
  )
  const failureClasses = useMemo(
    () =>
      [
        ...new Set(
          snapshot.runs.flatMap((run) =>
            run.recoveryReason ? [run.recoveryReason.split(":")[0]!] : []
          )
        ),
      ].sort(),
    [snapshot.runs]
  )
  const pendingGateRunIds = useMemo(() => {
    const ids = new Set(
      snapshot.runs.filter((run) => run.status === "needs_input").map((run) => run.id)
    )
    for (const graph of snapshot.graphs) {
      if (graph.status === "awaiting_approval") ids.add(graph.runId)
    }
    for (const retrospective of snapshot.retrospectives) {
      if (retrospective.status === "pending_approval") ids.add(retrospective.runId)
    }
    return ids
  }, [snapshot.graphs, snapshot.retrospectives, snapshot.runs])
  const queueOrder = useMemo(
    () =>
      snapshot.runs
        .filter((run) => run.status === "queued")
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            (a.queueEnteredAt ?? a.createdAt) - (b.queueEnteredAt ?? b.createdAt)
        )
        .map((run) => run.id),
    [snapshot.runs]
  )
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return snapshot.runs
      .filter((run) => status === "all" || run.status === status)
      .filter((run) => project === "all" || run.projectId === project)
      .filter((run) => teamFilter === "all" || run.teamId === teamFilter)
      .filter(
        (run) =>
          runtime === "all" || (teams[run.teamId]?.config.runtimeVersion ?? "legacy") === runtime
      )
      .filter((run) => gate === "all" || (gate === "pending") === pendingGateRunIds.has(run.id))
      .filter((run) => failureClass === "all" || run.recoveryReason?.split(":")[0] === failureClass)
      .filter(
        (run) =>
          repository === "all" ||
          snapshot.children.some(
            (child) => child.runId === run.id && child.repositoryId === repository
          )
      )
      .filter((run) => {
        const team = teams[run.teamId]
        return (
          !needle ||
          run.id.toLowerCase().includes(needle) ||
          run.objective.toLowerCase().includes(needle) ||
          team?.name.toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [
    failureClass,
    gate,
    pendingGateRunIds,
    project,
    query,
    repository,
    runtime,
    snapshot.children,
    snapshot.runs,
    status,
    teamFilter,
    teams,
  ])

  const apply = async (action: DurableRunControlAction, runIds: string[]) => {
    if (runIds.length === 0) return
    setBusy(true)
    try {
      const results = await controlDurableRuns(runIds, action)
      const failures = results.filter((result) => result.error)
      if (failures.length > 0) toast.error(t("actionFailed", { count: failures.length }))
      else toast.success(t("actionApplied", { count: results.length }))
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  /**
   * The six dropdowns, defined once and placed twice: inline on a wide row,
   * inside the disclosure on a phone. One definition, because two would be
   * two places to add the seventh filter.
   */
  // What the disclosure's badge counts: dropdowns actually narrowing the list.
  // The search box is outside the disclosure and speaks for itself.
  const activeFilterCount = [
    status,
    repository,
    project,
    teamFilter,
    runtime,
    gate,
    failureClass,
  ].filter((value) => value !== "all").length

  const filterControls = (
    <>
      <NativeSelect
        value={status}
        onChange={(event) => setStatus(event.target.value as AgentTeamRunStatus | "all")}
        wrapperClassName="w-auto"
        className="h-8 text-xs"
        aria-label={t("filters.status")}
      >
        <NativeSelectOption value="all">{t("filters.allStatuses")}</NativeSelectOption>
        {Array.from(new Set(snapshot.runs.map((run) => run.status))).map((value) => (
          <NativeSelectOption key={value} value={value}>
            {t(`status.${value}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        value={repository}
        onChange={(event) => setRepository(event.target.value)}
        wrapperClassName="w-auto"
        className="h-8 text-xs"
        aria-label={t("filters.repository")}
      >
        <NativeSelectOption value="all">{t("filters.allRepositories")}</NativeSelectOption>
        {repositories.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {value}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        value={project}
        onChange={(event) => setProject(event.target.value)}
        wrapperClassName="w-auto"
        className="h-8 text-xs"
        aria-label={t("filters.project")}
      >
        <NativeSelectOption value="all">{t("filters.allProjects")}</NativeSelectOption>
        {projects.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {value}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        value={teamFilter}
        onChange={(event) => setTeamFilter(event.target.value)}
        wrapperClassName="w-auto"
        className="h-8 text-xs"
        aria-label={t("filters.team")}
      >
        <NativeSelectOption value="all">{t("filters.allTeams")}</NativeSelectOption>
        {Object.values(teams).map((team) => (
          <NativeSelectOption key={team.id} value={team.id}>
            {team.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        value={runtime}
        onChange={(event) => setRuntime(event.target.value)}
        wrapperClassName="w-auto"
        className="h-8 text-xs"
        aria-label={t("filters.runtime")}
      >
        <NativeSelectOption value="all">{t("filters.allRuntimes")}</NativeSelectOption>
        {/* i18n-exempt: runtime protocol identifier */}
        <NativeSelectOption value="legacy">legacy</NativeSelectOption>
        {/* i18n-exempt: runtime protocol identifier */}
        <NativeSelectOption value="durable-v2">durable-v2</NativeSelectOption>
      </NativeSelect>
      <NativeSelect
        value={gate}
        onChange={(event) => setGate(event.target.value)}
        wrapperClassName="w-auto"
        className="h-8 text-xs"
        aria-label={t("filters.gate")}
      >
        <NativeSelectOption value="all">{t("filters.allGates")}</NativeSelectOption>
        <NativeSelectOption value="pending">{t("filters.pendingGate")}</NativeSelectOption>
        <NativeSelectOption value="clear">{t("filters.clearGate")}</NativeSelectOption>
      </NativeSelect>
      <NativeSelect
        value={failureClass}
        onChange={(event) => setFailureClass(event.target.value)}
        wrapperClassName="w-auto"
        className="h-8 text-xs"
        aria-label={t("filters.failureClass")}
      >
        <NativeSelectOption value="all">{t("filters.allFailures")}</NativeSelectOption>
        {failureClasses.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {value}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </>
  )

  return (
    <section className="space-y-4" data-testid="agent-team-command-center">
      {heading ? (
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
      ) : null}

      <div className="space-y-2" data-testid="command-center-filters">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("filters.search")}
          aria-label={t("filters.search")}
          className="h-8 w-full text-xs sm:w-56"
        />
        {/* On a phone the six dropdowns sit behind one disclosure that counts
            how many are narrowing the list, so a filtered view still announces
            itself while an unfiltered one costs a single row. Above the
            breakpoint they stay inline, where they always were. */}
        {isMobile ? (
          <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-full justify-between text-xs"
                data-testid="command-center-filters-toggle"
              >
                <span className="flex items-center gap-1.5">
                  <SlidersHorizontalIcon aria-hidden className="size-3.5" />
                  {t("filters.toggle")}
                  {activeFilterCount > 0 ? (
                    <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                      {activeFilterCount}
                    </Badge>
                  ) : null}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", filtersOpen && "rotate-180")}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="grid grid-cols-2 gap-1.5 pt-2">
              {filterControls}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">{filterControls}</div>
        )}
      </div>

      {/* Bulk actions act on a selection, and on a phone six permanently
          disabled buttons is a screenful of chrome that can do nothing. They
          appear with the selection there, and say how many rows they will act
          on. The wide row keeps them standing, where the space is free and
          their presence is what tells you the selection is worth making. */}
      {!isMobile || selected.size > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label={t("bulkActions")}
          data-testid="command-center-actions"
        >
          {isMobile ? (
            <span className="text-xs text-muted-foreground">
              {t("selectedCount", { count: selected.size })}
            </span>
          ) : null}
          {ACTIONS.map(({ action, icon: Icon }) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              disabled={busy || selected.size === 0}
              onClick={() => void apply(action, [...selected])}
            >
              <Icon className="mr-1 size-3.5" />
              {t(`actions.${action}`)}
            </Button>
          ))}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{t("empty")}</Card>
      ) : (
        <div className="space-y-3">
          {visible.map((run) => {
            const runChildren = snapshot.children.filter((child) => child.runId === run.id)
            const graph = snapshot.graphs.find((item) => item.runId === run.id)
            const delivery = graph
              ? snapshot.deliveryNodes.filter((node) => node.graphId === graph.id)
              : []
            const retrospective = snapshot.retrospectives.find((item) => item.runId === run.id)
            const queuePosition = queueOrder.indexOf(run.id)
            const stale = now - run.updatedAt > 120_000
            const activeSlots = runChildren.filter((child) => child.status === "running").length
            const maxSlots =
              teams[run.teamId]?.config.resourcePolicy?.maxConcurrentChildren ??
              teams[run.teamId]?.config.maxConcurrentTeammates ??
              0
            const gateCount =
              (run.status === "needs_input" ? 1 : 0) +
              (graph?.status === "awaiting_approval" ? 1 : 0) +
              (retrospective?.status === "pending_approval" ? 1 : 0)
            return (
              <Card key={run.id} className="space-y-3 p-4" data-testid={`command-run-${run.id}`}>
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={selected.has(run.id)}
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current)
                        if (checked) next.add(run.id)
                        else next.delete(run.id)
                        return next
                      })
                    }
                    aria-label={t("selectRun", { id: run.id })}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{teams[run.teamId]?.name ?? run.teamId}</p>
                      <Badge variant={run.status === "failed" ? "destructive" : "outline"}>
                        {t(`status.${run.status}`)}
                      </Badge>
                      {stale ? <Badge variant="secondary">{t("stale")}</Badge> : null}
                      {gateCount > 0 ? (
                        <Badge variant="secondary">{t("gates", { count: gateCount })}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">{run.objective}</p>
                  </div>
                </div>
                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
                  <span>{t("children", { count: runChildren.length })}</span>
                  <span>{t("priority", { value: run.priority })}</span>
                  <span>
                    {queuePosition >= 0
                      ? t("queuePosition", { value: queuePosition + 1 })
                      : t("queueInactive")}
                  </span>
                  <span>
                    {t("usage", {
                      tokens: run.resourceUsage?.totalTokens ?? 0,
                      seconds: Math.round((run.resourceUsage?.wallTimeMs ?? 0) / 1000),
                    })}
                  </span>
                  <span>
                    {run.resourceUsage?.costUsd === undefined
                      ? t("costUnavailable")
                      : t("cost", { value: run.resourceUsage.costUsd.toFixed(4) })}
                  </span>
                  <span>{t("slots", { active: activeSlots, max: maxSlots })}</span>
                  <span>
                    {t("attempts", {
                      attempts: run.resourceUsage?.attempts ?? 0,
                      failures: run.resourceUsage?.failures ?? 0,
                    })}
                  </span>
                  <span>{t("delivery", { count: delivery.length })}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {runChildren.map((child) => (
                    <Badge key={child.id} variant="outline">
                      {child.repositoryId}
                      {child.branch ? ` · ${child.branch}` : ""} · {t(`status.${child.status}`)}
                    </Badge>
                  ))}
                </div>
                {delivery.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {delivery
                      .slice()
                      .sort((left, right) => left.order - right.order)
                      .map((node) => (
                        <Badge key={node.id} variant="secondary">
                          {node.repositoryId} · {node.branch} · {t(`deliveryStatus.${node.status}`)}
                          {node.pullRequestNumber
                            ? ` · ${t("pullRequest", { number: node.pullRequestNumber })}`
                            : ""}
                        </Badge>
                      ))}
                  </div>
                ) : null}
              </Card>
            )
          })}
        </div>
      )}
    </section>
  )
}
