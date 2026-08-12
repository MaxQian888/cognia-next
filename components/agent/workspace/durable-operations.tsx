"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { GitMergeIcon, HandIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { RunRetrospectiveView } from "@/components/context-workbench/run-retrospective-view"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { getDb } from "@/lib/db/schema"
import { createDecisionLedger } from "@/lib/ai/agent/team/decision-ledger"
import { getDurableTeamCoordinator } from "@/lib/ai/agent/team/durable-runtime"
import { approveAndMergeGithubStack } from "@/lib/ai/agent/team/github-delivery-adapter"
import { createLocalTauriExecutionEnvironment } from "@/lib/ai/agent/execution/local-tauri-environment"
import { getProjectEnvironmentVersion } from "@/lib/db/project-environments"
import { getRunRetrospectiveBundle } from "@/lib/db/run-retrospectives"
import { generateConfiguredRunRetrospective } from "@/lib/execution/run-retrospective"
import {
  approveRunLearningProposal,
  rejectRunLearningProposal,
  retryRunLearningProposal,
} from "@/lib/execution/run-learning-materializer"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { RunRetrospectiveBundle } from "@/types/execution/retrospective"

export interface DurableOperationsProps {
  team: AgentTeam
  onOpenEditor: () => void
  onOpenTerminal: (workspacePath?: string) => void
  onOpenBrowser: () => void
  onMigrate: (config: AgentTeam["config"]) => void
}

export function DurableOperations({
  team,
  onOpenEditor,
  onOpenTerminal,
  onOpenBrowser,
  onMigrate,
}: DurableOperationsProps) {
  const t = useTranslations("agentTeamsWorkspace.operations")
  const [now] = useState(() => Date.now())
  const [steering, setSteering] = useState<Record<string, string>>({})
  const [manualCommands, setManualCommands] = useState<Record<string, string>>({})
  const [manualDiffs, setManualDiffs] = useState<Record<string, string>>({})
  const [retryHosts, setRetryHosts] = useState<Record<string, string>>({})
  const [showMigration, setShowMigration] = useState(false)
  const [generatingRetrospective, setGeneratingRetrospective] = useState(false)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const { snapshot: fleetSnapshot } = useFleetSnapshot()
  const selectedEnvironment = useLiveQuery(
    () =>
      team.config.environmentRef
        ? getProjectEnvironmentVersion(team.config.environmentRef.versionId)
        : Promise.resolve(undefined),
    [team.config.environmentRef?.versionId],
    undefined
  )

  const data = useLiveQuery(
    async () => {
      const db = getDb()
      const runs = await db.agentTeamRuns
        .where("teamId")
        .equals(team.id)
        .reverse()
        .sortBy("updatedAt")
      const run = runs[0]
      if (!run) return null
      const [children, decisions, evidence, graph, retrospectiveRows] = await Promise.all([
        db.agentTeamChildRuns.where("runId").equals(run.id).toArray(),
        db.agentTeamDecisions.where("runId").equals(run.id).toArray(),
        db.agentTeamEvidence.where("runId").equals(run.id).toArray(),
        db.agentTeamDeliveryGraphs.where("runId").equals(run.id).first(),
        db.runRetrospectives.where("runId").equals(run.id).toArray(),
      ])
      const deliveryNodes = graph
        ? await db.agentTeamDeliveryNodes.where("graphId").equals(graph.id).sortBy("order")
        : []
      const environment = team.config.environmentRef
        ? await getProjectEnvironmentVersion(team.config.environmentRef.versionId)
        : undefined
      const retrospectives = (
        await Promise.all(
          retrospectiveRows
            .sort((a, b) => b.analysisVersion - a.analysisVersion)
            .map((row) => getRunRetrospectiveBundle(row.id))
        )
      ).filter((bundle): bundle is RunRetrospectiveBundle => Boolean(bundle))
      return {
        run,
        children,
        decisions,
        evidence,
        graph,
        deliveryNodes,
        retrospectives,
        environment,
      }
    },
    [team.id, team.config.environmentRef?.versionId],
    null
  )

  const invoke = async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation()
      toast.success(success)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const proposalAction = async (proposalId: string, action: "approve" | "reject" | "retry") => {
    setBusyProposalId(proposalId)
    try {
      if (action === "approve") await approveRunLearningProposal(proposalId)
      else if (action === "retry") await retryRunLearningProposal(proposalId)
      else await rejectRunLearningProposal(proposalId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyProposalId(null)
    }
  }

  if (team.config.runtimeVersion !== "durable-v2") {
    const preflight = selectedEnvironment
      ? createLocalTauriExecutionEnvironment().preflight(selectedEnvironment)
      : { ok: false, missing: ["environment_version"] }
    const primaryCount =
      team.config.repositories?.filter((repository) => repository.role === "primary").length ??
      (team.config.workingDir ? 1 : 0)
    const canMigrate = preflight.ok && primaryCount === 1
    return (
      <Card className="space-y-3 p-6 text-sm">
        <p className="text-muted-foreground">{t("legacy")}</p>
        <Button size="sm" variant="outline" onClick={() => setShowMigration((value) => !value)}>
          {t("migration.preview")}
        </Button>
        {showMigration ? (
          <div className="space-y-3 rounded-md border p-3">
            <p>{t("migration.summary")}</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{t("migration.runtime")}</li>
              <li>{t("migration.writer")}</li>
              <li>{t("migration.environment")}</li>
              <li>{t("migration.retention")}</li>
            </ul>
            {!canMigrate ? (
              <p className="text-destructive">
                {t("migration.blocked", {
                  reason:
                    primaryCount !== 1
                      ? t("migration.primaryRepository")
                      : preflight.missing.join(", "),
                })}
              </p>
            ) : null}
            <Button
              size="sm"
              disabled={!canMigrate}
              onClick={() => {
                const repositories =
                  team.config.repositories && team.config.repositories.length > 0
                    ? team.config.repositories
                    : [
                        {
                          id: "primary",
                          role: "primary" as const,
                          path: team.config.workingDir!,
                          writable: true,
                        },
                      ]
                onMigrate({
                  ...team.config,
                  runtimeVersion: "durable-v2",
                  writeMode: "single-writer",
                  repositories,
                })
              }}
            >
              {t("migration.accept")}
            </Button>
          </div>
        ) : null}
      </Card>
    )
  }
  if (!data) return <Card className="p-6 text-sm text-muted-foreground">{t("empty")}</Card>

  const environmentCheck = data.environment
    ? createLocalTauriExecutionEnvironment().preflight(data.environment)
    : { ok: false, missing: ["environment_version"] }

  return (
    <div className="space-y-4" data-testid="durable-operations">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">{t("run.title")}</h3>
            <p className="text-xs text-muted-foreground">{data.run.id}</p>
          </div>
          <Badge variant="outline">{t(`status.${data.run.status}`)}</Badge>
        </div>
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <span>{t("run.decisionVersion", { value: data.run.decisionVersion })}</span>
          <span>{t("run.tokens", { value: data.run.resourceUsage?.totalTokens ?? 0 })}</span>
          <span>{t("run.children", { value: data.children.length })}</span>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">{t("environment.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {data.environment
            ? t("environment.version", {
                name: data.environment.name,
                version: data.environment.version,
              })
            : t("environment.missing")}
        </p>
        <Badge variant={environmentCheck.ok ? "secondary" : "destructive"}>
          {environmentCheck.ok
            ? t("environment.ready")
            : t("environment.blocked", { capabilities: environmentCheck.missing.join(", ") })}
        </Badge>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">{t("decisions.title")}</h3>
        {data.decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("decisions.empty")}</p>
        ) : (
          data.decisions.map((decision) => (
            <div key={decision.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{decision.title}</span>
                <Badge variant="outline">{decision.status}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{decision.detail}</p>
              {decision.status === "proposed" && team.leadId ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      void invoke(
                        () =>
                          createDecisionLedger({ runId: data.run.id, leadId: team.leadId! }).accept(
                            decision.id,
                            team.leadId!
                          ),
                        t("decisions.accepted")
                      )
                    }
                  >
                    {t("decisions.accept")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void invoke(
                        () =>
                          createDecisionLedger({ runId: data.run.id, leadId: team.leadId! }).reject(
                            decision.id,
                            team.leadId!
                          ),
                        t("decisions.rejected")
                      )
                    }
                  >
                    {t("decisions.reject")}
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">{t("children.title")}</h3>
        {data.children.map((child) => (
          <div key={child.id} className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs">{child.id}</span>
              <Badge variant="outline">{t(`status.${child.status}`)}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {child.repositoryId} · {child.workspacePath ?? t("children.noWorkspace")}
            </p>
            <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <span>{t("children.host", { value: child.hostRef ?? t("children.localHost") })}</span>
              <span>
                {t("children.remoteSession", {
                  value: child.remoteSessionId ?? t("children.noRemoteSession"),
                })}
              </span>
              <span>
                {t("children.lease", {
                  value: child.dispatchLeaseId
                    ? (child.dispatchLeaseExpiresAt ?? 0) > now
                      ? t("children.leaseFresh")
                      : t("children.leaseExpired")
                    : t("children.noLease"),
                })}
              </span>
              {child.waitingReason ? (
                <span>{t("children.waitingReason", { value: child.waitingReason })}</span>
              ) : null}
            </div>
            {child.waitingReason === "recovery_required" ? (
              <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-sm font-medium">{t("children.recoveryRequired")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!child.hostRef}
                    onClick={() =>
                      void invoke(
                        () => agentTeamManager.retryChild(child.id, child.hostRef),
                        t("children.retryStarted")
                      )
                    }
                  >
                    {t("children.retrySameHost")}
                  </Button>
                  <NativeSelect
                    size="sm"
                    aria-label={t("children.retryHostLabel")}
                    value={retryHosts[child.id] ?? ""}
                    onChange={(event) =>
                      setRetryHosts((current) => ({
                        ...current,
                        [child.id]: event.target.value,
                      }))
                    }
                  >
                    <NativeSelectOption value="">{t("children.selectHost")}</NativeSelectOption>
                    {(fleetSnapshot.hosts ?? [])
                      .filter((host) => host.online && host.hostRef !== child.hostRef)
                      .map((host) => (
                        <NativeSelectOption key={host.hostRef} value={host.hostRef}>
                          {host.hostRef}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!retryHosts[child.id]}
                    onClick={() =>
                      void invoke(
                        () => agentTeamManager.retryChild(child.id, retryHosts[child.id]),
                        t("children.retryStarted")
                      )
                    }
                  >
                    {t("children.retrySelectedHost")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      void invoke(
                        () => getDurableTeamCoordinator().terminateChild(child.id),
                        t("children.cancelled")
                      )
                    }
                  >
                    {t("children.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Input
                value={steering[child.id] ?? ""}
                onChange={(event) =>
                  setSteering((value) => ({ ...value, [child.id]: event.target.value }))
                }
                placeholder={t("children.steerPlaceholder")}
              />
              <Button
                size="icon"
                aria-label={t("children.steer")}
                disabled={!steering[child.id]?.trim()}
                onClick={() =>
                  void invoke(async () => {
                    await getDurableTeamCoordinator().steer(child.id, steering[child.id]!)
                    setSteering((value) => ({ ...value, [child.id]: "" }))
                  }, t("children.steered"))
                }
              >
                <SendIcon className="size-4" />
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Textarea
                value={manualCommands[child.id] ?? ""}
                onChange={(event) =>
                  setManualCommands((value) => ({ ...value, [child.id]: event.target.value }))
                }
                placeholder={t("children.commandsPlaceholder")}
              />
              <Textarea
                value={manualDiffs[child.id] ?? ""}
                onChange={(event) =>
                  setManualDiffs((value) => ({ ...value, [child.id]: event.target.value }))
                }
                placeholder={t("children.diffPlaceholder")}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={onOpenEditor}>
                {t("children.openEditor")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenTerminal(child.workspacePath)}
              >
                {t("children.openTerminal")}
              </Button>
              <Button size="sm" variant="outline" onClick={onOpenBrowser}>
                {t("children.openBrowser")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void invoke(
                    () => getDurableTeamCoordinator().beginTakeover(child.id),
                    t("children.takeoverStarted")
                  )
                }
              >
                <HandIcon className="mr-1 size-3.5" />
                {t("children.takeover")}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void invoke(
                    () =>
                      getDurableTeamCoordinator().completeTakeover({
                        childRunId: child.id,
                        commands: (manualCommands[child.id] ?? "").split("\n").filter(Boolean),
                        diffContent: manualDiffs[child.id] || undefined,
                      }),
                    t("children.takeoverCompleted")
                  )
                }
              >
                {t("children.resume")}
              </Button>
            </div>
          </div>
        ))}
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">{t("evidence.title")}</h3>
        {data.evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("evidence.empty")}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {data.evidence.map((item) => (
              <div key={item.id} className="rounded-md border p-3">
                <Badge variant="outline">{item.kind}</Badge>
                <p className="mt-1 text-sm">{item.title}</p>
                {item.contentHash ? (
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {item.contentHash}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{t("delivery.title")}</h3>
          {data.graph?.status === "awaiting_approval" || data.graph?.status === "running" ? (
            <Button
              size="sm"
              onClick={() =>
                void invoke(
                  () => approveAndMergeGithubStack(team, data.graph!.id),
                  t("delivery.merged")
                )
              }
            >
              <GitMergeIcon className="mr-1 size-3.5" />
              {t("delivery.approveMerge")}
            </Button>
          ) : null}
        </div>
        {data.deliveryNodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("delivery.empty")}</p>
        ) : (
          data.deliveryNodes.map((node) => (
            <div
              key={node.id}
              className="flex items-center justify-between rounded-md border p-3 text-sm"
            >
              <span>
                {node.repositoryId} · {node.title}
              </span>
              <Badge variant="outline">{node.status}</Badge>
            </div>
          ))
        )}
      </Card>

      <Card className="overflow-hidden">
        <RunRetrospectiveView
          bundles={data.retrospectives}
          canGenerate={
            ["completed", "failed", "cancelled"].includes(data.run.status) &&
            data.retrospectives.length === 0 &&
            !generatingRetrospective
          }
          busyProposalId={busyProposalId}
          onGenerate={() => {
            setGeneratingRetrospective(true)
            void generateConfiguredRunRetrospective(data.run.id, {
              adapterContext: {
                summary: `Agent Team ${team.id}`,
                resourceRefs: [
                  { namespace: "cognia", type: "agent-team", id: team.id },
                  ...(team.config.environmentRef
                    ? [
                        {
                          namespace: "cognia",
                          type: "project-environment-version",
                          id: team.config.environmentRef.versionId,
                        },
                      ]
                    : []),
                ],
              },
              defaultTargetIds: {
                "team-config": team.id,
                ...(team.config.environmentRef
                  ? { "project-environment": team.config.environmentRef.versionId }
                  : {}),
              },
            })
              .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
              .finally(() => setGeneratingRetrospective(false))
          }}
          onApprove={(id) => void proposalAction(id, "approve")}
          onReject={(id) => void proposalAction(id, "reject")}
          onRetry={(id) => void proposalAction(id, "retry")}
        />
      </Card>
    </div>
  )
}
