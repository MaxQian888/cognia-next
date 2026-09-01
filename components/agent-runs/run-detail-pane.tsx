"use client"

/**
 * The cockpit's detail pane: Overview, Activity, Changes, Tests, Artifacts,
 * Approvals for one run.
 *
 * Everything it renders comes from the run journal, so the same pane works for
 * a chat turn, a workflow, a delegation and a background job without knowing
 * anything about the engine behind them.
 *
 * Control buttons are rendered from `allowedActions` on the live snapshot, via
 * `useRunControlActions`. The pane never decides for itself what a kind can do
 * — those rules live in `run-reducer.ts` and a second copy here would drift.
 *
 * Note for the harness work (`docs/plans/2026-08-21-codex-open-harness-adoption.md`
 * WP4): this is the surface that plan generalizes from `components/chat/run-panel.tsx`.
 * When WP4 lands, this pane should CONSUME that component rather than keep a
 * second implementation of the same sections.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  FileIcon,
  XCircleIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InspectRow } from "@/components/scheduler/details/_shared/inspect-row"
import { RunImOrigin, useRunImOrigin } from "@/components/execution/run-im-origin"
import { formatDuration, formatRelativeTime } from "@/lib/scheduler/format-utils"
import { cn } from "@/lib/utils"
import { isSquadRun, RunCoordinationTab } from "./run-coordination-tab"
import { RunReportTab } from "./run-report-tab"
import { RunOperationsTab } from "./run-operations-tab"
import { useExecutionRunDetail } from "@/hooks/agent-runs/use-execution-run-detail"
import { changeKindLabelKey, changesAreComplete } from "@/lib/execution/run-detail-model"
import { runKindLabelKey } from "@/lib/execution/cockpit-model"
import type { RunControlActions, RunControlOutcome } from "@/hooks/agent-runs/use-agent-run-actions"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type { RunControlAction, RunVerificationConclusion } from "@/types/execution/run"
import { ExecutionStatusPill } from "./agent-run-status-pill"

/** Verbs the pane offers, in the order they are shown. */
const CONTROL_ORDER: readonly RunControlAction[] = [
  "approve",
  "deny",
  "pause",
  "resume",
  "retry",
  "stop",
]

const CONCLUSION_ICON: Record<RunVerificationConclusion, typeof CheckCircle2Icon> = {
  passed: CheckCircle2Icon,
  failed: XCircleIcon,
  inconclusive: CircleHelpIcon,
}

const CONCLUSION_CLASS: Record<RunVerificationConclusion, string> = {
  passed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  // Deliberately amber, not green: output that could not be parsed is a
  // question, and colouring it like a pass is exactly the silent green the
  // verification projection exists to avoid.
  inconclusive: "text-amber-600 dark:text-amber-400",
}

export interface RunDetailPaneProps {
  row: UnifiedExecutionRow
  actions: RunControlActions
}

export function RunDetailPane({ row, actions }: RunDetailPaneProps) {
  const t = useTranslations("agentRuns")
  const { run, detail, interrupts, journalAvailable, isLoading } = useExecutionRunDetail(row.runId)
  const [outcome, setOutcome] = useState<RunControlOutcome | null>(null)
  const [steerText, setSteerText] = useState("")

  const busy = actions.pendingRowId === row.rowId
  const duration = row.endedAt ? formatDuration(row.endedAt - row.startedAt) : undefined
  // Null for every run started on the desktop, which is what gates the row.
  const imOrigin = useRunImOrigin(row.runId)
  // Only a Squad run has consensus and delegations to show.
  const squadRun = isSquadRun(row)

  const dispatch = async (action: RunControlAction, steerMessage?: string) => {
    const result = await actions.dispatch(row, action, steerMessage ? { steerMessage } : {})
    setOutcome(result)
    // A steer that was not accepted leaves the text in the box: the message is
    // still the user's and clearing it would drop what they typed.
    if (result.accepted && action === "steer") setSteerText("")
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words text-base font-semibold">{row.label}</h2>
        <ExecutionStatusPill status={row.status} />
      </div>

      <ControlBar
        row={row}
        actions={actions}
        busy={busy}
        onDispatch={(action) => void dispatch(action)}
      />

      {actions.can(row, "steer") && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (steerText.trim()) void dispatch("steer", steerText.trim())
          }}
        >
          <Input
            value={steerText}
            onChange={(event) => setSteerText(event.target.value)}
            placeholder={t("actions.steerPlaceholder")}
            aria-label={t("actions.steerPlaceholder")}
            className="h-8 text-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !steerText.trim()}>
            {t("actions.steer")}
          </Button>
        </form>
      )}

      {outcome && !outcome.accepted && outcome.reason && (
        <p
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400"
        >
          {t(`outcome.${outcome.reason}`)}
          {outcome.degradedReason ? ` (${t(`degraded.${outcome.degradedReason}`)})` : ""}
        </p>
      )}
      {outcome?.accepted && outcome.retryRunId && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("outcome.retried")}
        </p>
      )}

      <Tabs defaultValue="overview" className="min-h-0">
        <TabsList>
          <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
          <TabsTrigger value="activity">
            {t("tabs.activity")}
            <SectionCount value={detail.activities.length} />
          </TabsTrigger>
          <TabsTrigger value="changes">
            {t("tabs.changes")}
            <SectionCount value={detail.changes.length} />
          </TabsTrigger>
          <TabsTrigger value="tests">
            {t("tabs.tests")}
            <SectionCount value={detail.verifications.length} />
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            {t("tabs.artifacts")}
            <SectionCount value={detail.artifacts.length} />
          </TabsTrigger>
          <TabsTrigger value="approvals">
            {t("tabs.approvals")}
            <SectionCount value={interrupts.length} />
          </TabsTrigger>
          {/*
            Only a Squad run has coordination. Offering the tab on a direct-chat
            or workflow run would be a permanently empty section rather than a
            capability.
          */}
          {squadRun ? (
            <>
              <TabsTrigger value="coordination">{t("tabs.coordination")}</TabsTrigger>
              <TabsTrigger value="report">{t("tabs.report")}</TabsTrigger>
              <TabsTrigger value="operations">{t("tabs.operations")}</TabsTrigger>
            </>
          ) : null}
        </TabsList>

        {squadRun ? (
          <>
            <TabsContent value="coordination" className="pt-2">
              <RunCoordinationTab row={row} />
            </TabsContent>
            {/* The report and durable-operations halves of the retired
                workspace's activity and operations tabs. ADR-0140 moved
                coordination here and left these two behind, so the execution
                report, the `agent.team.report` plugin slot, and every durable
                control a running Squad has had no host at all. */}
            <TabsContent value="report" className="pt-2">
              <RunReportTab row={row} />
            </TabsContent>
            <TabsContent value="operations" className="pt-2">
              <RunOperationsTab row={row} />
            </TabsContent>
          </>
        ) : null}

        <TabsContent value="overview" className="pt-2">
          <InspectRow label={t("detail.kind")} value={t(`kind.${runKindLabelKey(row)}`)} />
          <InspectRow label={t("detail.status")} value={t(`status.${row.status}`)} />
          <InspectRow
            label={t("detail.started")}
            value={formatRelativeTime(new Date(row.startedAt))}
          />
          {row.endedAt !== undefined && (
            <InspectRow
              label={t("detail.finished")}
              value={`${formatRelativeTime(new Date(row.endedAt))} (${duration})`}
            />
          )}
          {row.progressRatio !== undefined && (
            <InspectRow
              label={t("detail.progress")}
              value={`${Math.round(row.progressRatio * 100)}%`}
            />
          )}
          {run?.latestSnapshot?.waitingReason && (
            <InspectRow
              label={t("detail.waitingReason")}
              value={run.latestSnapshot.waitingReason}
            />
          )}
          {row.error && <InspectRow label={t("detail.error")} value={row.error} />}
          {/* Only for a run a chat handed over. `RunImOrigin` renders nothing
              otherwise, so the row is gated on the same lookup rather than on
              a guess about the run kind. */}
          {imOrigin && (
            <InspectRow label={t("detail.imOrigin")} value={<RunImOrigin runId={row.runId} />} />
          )}
          {row.source !== "journal" && (
            <p className="pt-2 text-xs text-muted-foreground">{t("detail.notJournalled")}</p>
          )}
        </TabsContent>

        <TabsContent value="activity" className="pt-2">
          <Unavailable when={!journalAvailable} label={t("detail.journalUnavailable")}>
            <EmptyOr
              empty={detail.activities.length === 0}
              label={isLoading ? t("detail.loading") : t("detail.noActivity")}
            >
              <ul className="space-y-1">
                {detail.activities.map((activity) => (
                  <li
                    key={activity.id}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
                  >
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t(`activityCategory.${activity.category}`)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{activity.label}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {t(`activityStatus.${activity.status}`)}
                    </span>
                  </li>
                ))}
              </ul>
              {detail.omittedActivityCount > 0 && (
                <p className="pt-2 text-xs text-muted-foreground">
                  {t("detail.activityOmitted", { count: detail.omittedActivityCount })}
                </p>
              )}
            </EmptyOr>
          </Unavailable>
        </TabsContent>

        <TabsContent value="changes" className="pt-2">
          <Unavailable when={!journalAvailable} label={t("detail.journalUnavailable")}>
            {!changesAreComplete(detail.changeSummary) && (
              <p className="mb-2 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                {t("detail.changesIncomplete")}
              </p>
            )}
            <EmptyOr empty={detail.changes.length === 0} label={t("detail.noChanges")}>
              <ul className="space-y-1">
                {detail.changes.map((change) => (
                  <li
                    key={change.path}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
                  >
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                    {change.sensitive && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {t("detail.sensitive")}
                      </Badge>
                    )}
                    {changeKindLabelKey(change.changeKind) && (
                      <span className="shrink-0 text-muted-foreground">
                        {t(`changeKind.${changeKindLabelKey(change.changeKind)}`)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </EmptyOr>
          </Unavailable>
        </TabsContent>

        <TabsContent value="tests" className="pt-2">
          <EmptyOr empty={detail.verifications.length === 0} label={t("detail.noTests")}>
            <ul className="space-y-1">
              {detail.verifications.map((artifact) => {
                const summary = artifact.verification
                const Icon = CONCLUSION_ICON[summary.conclusion]
                return (
                  <li
                    key={artifact.id}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
                  >
                    <Icon
                      className={cn("size-3.5 shrink-0", CONCLUSION_CLASS[summary.conclusion])}
                    />
                    <span
                      className={cn("shrink-0 font-medium", CONCLUSION_CLASS[summary.conclusion])}
                    >
                      {t(`tests.${summary.conclusion}`)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {summary.conclusion === "inconclusive"
                        ? t("tests.inconclusiveHint")
                        : t("tests.counts", {
                            passed: summary.passed,
                            failed: summary.failed,
                            skipped: summary.skipped,
                          })}
                    </span>
                    {summary.durationMs !== undefined && (
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatDuration(summary.durationMs)}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </EmptyOr>
        </TabsContent>

        <TabsContent value="artifacts" className="pt-2">
          <EmptyOr empty={detail.artifacts.length === 0} label={t("detail.noArtifacts")}>
            <ul className="space-y-1">
              {detail.artifacts.map((artifact) => (
                <li key={artifact.id} className="rounded border px-2 py-1 text-xs">
                  <span className="truncate">{artifact.title}</span>
                </li>
              ))}
            </ul>
          </EmptyOr>
        </TabsContent>

        <TabsContent value="approvals" className="pt-2">
          <Unavailable when={!journalAvailable} label={t("detail.journalUnavailable")}>
            <EmptyOr empty={interrupts.length === 0} label={t("detail.noApprovals")}>
              <ul className="space-y-1">
                {interrupts.map((interrupt) => (
                  <li
                    key={interrupt.id}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
                  >
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t(`approvals.${interrupt.status}`)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{interrupt.title}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatRelativeTime(new Date(interrupt.createdAt))}
                    </span>
                  </li>
                ))}
              </ul>
            </EmptyOr>
          </Unavailable>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function SectionCount({ value }: { value: number }) {
  if (value === 0) return null
  return <span className="ml-1 tabular-nums opacity-70">{value}</span>
}

function EmptyOr({
  empty,
  label,
  children,
}: {
  empty: boolean
  label: string
  children: React.ReactNode
}) {
  if (empty) return <p className="py-4 text-center text-xs text-muted-foreground">{label}</p>
  return <>{children}</>
}

/**
 * Says "not available here" instead of rendering an empty list.
 *
 * The distinction is the point: an empty Changes list on a device that never
 * received the journal would claim the run touched no files.
 */
function Unavailable({
  when,
  label,
  children,
}: {
  when: boolean
  label: string
  children: React.ReactNode
}) {
  if (when) return <p className="py-4 text-center text-xs text-muted-foreground">{label}</p>
  return <>{children}</>
}

function ControlBar({
  row,
  actions,
  busy,
  onDispatch,
}: {
  row: UnifiedExecutionRow
  actions: RunControlActions
  busy: boolean
  onDispatch: (action: RunControlAction) => void
}) {
  const t = useTranslations("agentRuns")
  const available = CONTROL_ORDER.filter((action) => actions.can(row, action))
  if (available.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {available.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={action === "stop" || action === "deny" ? "destructive" : "outline"}
          disabled={busy}
          onClick={() => onDispatch(action)}
        >
          {t(`actions.${action}`)}
        </Button>
      ))}
    </div>
  )
}
