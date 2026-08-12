"use client"

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { WorkingSetEntryKind } from "@cognia/agent-config-types/working-set"

import { RunRetrospectiveView } from "@/components/context-workbench/run-retrospective-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { listBackgroundTaskRecords } from "@/lib/db/background-tasks"
import { listExecutionRuns } from "@/lib/db/execution-runs"
import { listSessionRunRetrospectives } from "@/lib/db/run-retrospectives"
import { getSession } from "@/lib/db/sessions"
import { mutateSessionWorkingSet, WorkingSetConflictError } from "@/lib/chat/working-set"
import { generateConfiguredRunRetrospective } from "@/lib/execution/run-retrospective"
import {
  approveRunLearningProposal,
  rejectRunLearningProposal,
  retryRunLearningProposal,
} from "@/lib/execution/run-learning-materializer"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

const ENTRY_KINDS: WorkingSetEntryKind[] = [
  "fact",
  "decision",
  "open-question",
  "resource",
  "subtask",
]

export interface RunContextPanelProps {
  sessionId: string
}

export function RunContextPanel({ sessionId }: RunContextPanelProps) {
  const t = useTranslations("contextWorkbench.runContext")
  const session = useLiveQuery(() => getSession(sessionId), [sessionId])
  const bundles = useLiveQuery(() => listSessionRunRetrospectives(sessionId), [sessionId], [])
  const runs = useLiveQuery(() => listExecutionRuns({ sessionId, limit: 30 }), [sessionId], [])
  const backgroundTasks = useLiveQuery(
    async () => (await listBackgroundTaskRecords()).filter((task) => task.sessionId === sessionId),
    [sessionId],
    []
  )
  const artifactMap = useArtifactStore((state) => state.artifacts)
  const artifacts = useMemo(
    () => Object.values(artifactMap).filter((artifact) => artifact.sessionId === sessionId),
    [artifactMap, sessionId]
  )
  const [summary, setSummary] = useState("")
  const [kind, setKind] = useState<WorkingSetEntryKind>("fact")
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const workingSet = session?.workingSet ?? {
    contractVersion: 1 as const,
    revision: 0,
    entries: [],
    updatedAt: 0,
  }
  const reviewedRunIds = useMemo(
    () => new Set(bundles.map((bundle) => bundle.retrospective.runId)),
    [bundles]
  )
  const terminalRun = runs.find(
    (run) =>
      ["completed", "failed", "cancelled"].includes(run.status) && !reviewedRunIds.has(run.id)
  )
  const pendingCount = bundles.reduce(
    (count, bundle) =>
      count + bundle.proposals.filter((proposal) => proposal.status === "pending").length,
    0
  )

  const mutate = async (
    action: { type: "upsert" } | { type: "resolve" | "remove"; entryId: string }
  ) => {
    try {
      if (action.type === "upsert") {
        const value = summary.trim()
        if (!value) return
        await mutateSessionWorkingSet({
          sessionId,
          expectedRevision: workingSet.revision,
          action: "upsert",
          entry: { kind, summary: value, origin: "user", refs: [] },
        })
        setSummary("")
      } else {
        await mutateSessionWorkingSet({
          sessionId,
          expectedRevision: workingSet.revision,
          action: action.type,
          entryId: action.entryId,
        })
      }
    } catch (error) {
      toast.error(
        error instanceof WorkingSetConflictError
          ? t("workingSet.revisionConflict")
          : error instanceof Error
            ? error.message
            : String(error)
      )
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

  return (
    <Tabs
      defaultValue="working-set"
      className="flex h-full flex-col"
      data-testid="run-context-panel"
    >
      <div className="border-b p-3">
        <TabsList className="w-full">
          <TabsTrigger value="working-set" className="flex-1">
            {t("tabs.workingSet")}
          </TabsTrigger>
          <TabsTrigger value="review" className="flex-1">
            {t("tabs.review")}
            {pendingCount > 0 ? <Badge className="ml-1">{pendingCount}</Badge> : null}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="working-set" className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="space-y-3 p-3">
            <div>
              <h3 className="text-sm font-medium">{t("workingSet.title")}</h3>
              <p className="text-xs text-muted-foreground">{t("workingSet.description")}</p>
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <Textarea
                value={summary}
                maxLength={512}
                rows={3}
                aria-label={t("workingSet.summaryLabel")}
                placeholder={t("workingSet.summaryPlaceholder")}
                onChange={(event) => setSummary(event.target.value)}
              />
              <div className="flex gap-2">
                <Select
                  value={kind}
                  onValueChange={(value) => setKind(value as WorkingSetEntryKind)}
                >
                  <SelectTrigger className="flex-1" aria-label={t("workingSet.kindLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENTRY_KINDS.map((entryKind) => (
                      <SelectItem key={entryKind} value={entryKind}>
                        {t(`workingSet.kinds.${entryKind}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  disabled={!summary.trim()}
                  onClick={() => void mutate({ type: "upsert" })}
                >
                  {t("workingSet.add")}
                </Button>
              </div>
            </div>

            {workingSet.entries.length === 0 ? (
              <Empty className="min-h-48 border">
                <EmptyMedia variant="icon">
                  <ListChecksIcon />
                </EmptyMedia>
                <EmptyTitle className="text-base">{t("workingSet.emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("workingSet.emptyDescription")}</EmptyDescription>
              </Empty>
            ) : (
              workingSet.entries.map((entry) => (
                <article key={entry.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm">{entry.summary}</p>
                    <Badge variant="outline">{t(`workingSet.${entry.status}`)}</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t(`workingSet.kinds.${entry.kind}`)}
                  </p>
                  <div className="flex gap-2">
                    {entry.status === "active" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void mutate({ type: "resolve", entryId: entry.id })}
                      >
                        {t("workingSet.resolve")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void mutate({ type: "remove", entryId: entry.id })}
                    >
                      {t("workingSet.remove")}
                    </Button>
                  </div>
                </article>
              ))
            )}

            <section className="space-y-2 rounded-lg border p-3">
              <h4 className="text-sm font-medium">{t("workingSet.projectionTitle")}</h4>
              <p className="text-xs text-muted-foreground">
                {t("workingSet.projectionDescription")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {runs
                  .filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
                  .map((run) => (
                    <Badge key={run.id} variant="outline">
                      {t("workingSet.projection.run", {
                        kind: t(`workingSet.runKinds.${run.kind}`),
                        status: t(`workingSet.runStatuses.${run.status}`),
                      })}
                    </Badge>
                  ))}
                {backgroundTasks.map((task) => (
                  <Badge key={task.runId} variant="outline">
                    {t("workingSet.projection.backgroundTask", {
                      id: task.subagentId,
                      status: t(`workingSet.backgroundTaskStatuses.${task.status}`),
                    })}
                  </Badge>
                ))}
                {session?.executionContext?.taskWorkspace ? (
                  <Badge variant="outline">
                    {t("workingSet.projection.taskWorkspace", {
                      id: session.executionContext.taskWorkspace.taskId,
                    })}
                  </Badge>
                ) : null}
                {artifacts.map((artifact) => (
                  <Badge key={artifact.id} variant="outline">
                    {t("workingSet.projection.artifact", { title: artifact.title })}
                  </Badge>
                ))}
              </div>
            </section>
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="review" className="min-h-0 flex-1 overflow-auto">
        <RunRetrospectiveView
          bundles={bundles}
          canGenerate={Boolean(terminalRun) && !generating}
          busyProposalId={busyProposalId}
          onGenerate={
            terminalRun
              ? () => {
                  setGenerating(true)
                  void generateConfiguredRunRetrospective(terminalRun.id)
                    .catch((error) =>
                      toast.error(error instanceof Error ? error.message : String(error))
                    )
                    .finally(() => setGenerating(false))
                }
              : undefined
          }
          onApprove={(id) => void proposalAction(id, "approve")}
          onReject={(id) => void proposalAction(id, "reject")}
          onRetry={(id) => void proposalAction(id, "retry")}
        />
      </TabsContent>
    </Tabs>
  )
}
