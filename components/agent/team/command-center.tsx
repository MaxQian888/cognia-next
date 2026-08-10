"use client"

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNow, useTranslations } from "next-intl"
import { MoonIcon, PauseIcon, PlayIcon, RefreshCwIcon, SquareIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
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

export function AgentTeamCommandCenter(): React.ReactElement {
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

  return (
    <section className="space-y-4" data-testid="agent-team-command-center">
      <div>
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("filters.search")}
          aria-label={t("filters.search")}
        />
        <NativeSelect
          value={status}
          onChange={(event) => setStatus(event.target.value as AgentTeamRunStatus | "all")}
          wrapperClassName="w-full"
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
          wrapperClassName="w-full"
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
          wrapperClassName="w-full"
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
          wrapperClassName="w-full"
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
          wrapperClassName="w-full"
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
          wrapperClassName="w-full"
          aria-label={t("filters.gate")}
        >
          <NativeSelectOption value="all">{t("filters.allGates")}</NativeSelectOption>
          <NativeSelectOption value="pending">{t("filters.pendingGate")}</NativeSelectOption>
          <NativeSelectOption value="clear">{t("filters.clearGate")}</NativeSelectOption>
        </NativeSelect>
        <NativeSelect
          value={failureClass}
          onChange={(event) => setFailureClass(event.target.value)}
          wrapperClassName="w-full"
          aria-label={t("filters.failureClass")}
        >
          <NativeSelectOption value="all">{t("filters.allFailures")}</NativeSelectOption>
          {failureClasses.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      <div className="flex flex-wrap gap-2" aria-label={t("bulkActions")}>
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
