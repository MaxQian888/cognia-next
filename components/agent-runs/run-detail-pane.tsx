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
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  FileIcon,
  XCircleIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InspectRow } from "@/components/scheduler/details/_shared/inspect-row"
import { RunImOrigin, useRunImOrigin } from "@/components/execution/run-im-origin"
import { formatDuration } from "@/lib/scheduler/format-utils"
import { cn } from "@/lib/utils"
import { isSquadRun, RunCoordinationTab } from "./run-coordination-tab"
import { RunReportTab } from "./run-report-tab"
import { RunOperationsTab } from "./run-operations-tab"
import { RunNotificationsTab } from "./run-notifications-tab"
import { useExecutionRunDetail } from "@/hooks/agent-runs/use-execution-run-detail"
import { changeKindLabelKey, changesAreComplete } from "@/lib/execution/run-detail-model"
import { runKindLabelKey } from "@/lib/execution/cockpit-model"
import type { RunControlActions, RunControlOutcome } from "@/hooks/agent-runs/use-agent-run-actions"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type {
  ExecutionRunInterrupt,
  RunControlAction,
  RunVerificationConclusion,
  SquadReviewDecision,
} from "@/types/execution/run"
import { ExecutionStatusPill } from "./agent-run-status-pill"
import { SquadReviewForm, isRenderableSquadReview } from "./squad-review-form"
import { DelegateReviewPane, isFusionApprovalInterrupt } from "./delegate-review-pane"
import { DiffViewer } from "@/components/source-control/diff-viewer"
import type { BotWorkspaceSnapshot } from "@/lib/plugin/workspace/bot-run"

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
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const t = useTranslations("agentRuns")
  const { run, detail, interrupts, journalAvailable, isLoading, botResult } = useExecutionRunDetail(
    row.runId
  )
  const [outcome, setOutcome] = useState<RunControlOutcome | null>(null)
  const [steerText, setSteerText] = useState("")
  const controlRow = run?.latestSnapshot
    ? { ...row, allowedActions: run.latestSnapshot.allowedActions }
    : row

  const busy = actions.pendingRowId === row.rowId
  const duration = row.endedAt ? formatDuration(row.endedAt - row.startedAt) : undefined
  // Null for every run started on the desktop, which is what gates the row.
  const imOrigin = useRunImOrigin(row.runId)
  // Only a Squad run has consensus and delegations to show.
  const squadRun = isSquadRun(row)

  const dispatch = async (
    action: RunControlAction,
    steerMessage?: string,
    reviewDecision?: SquadReviewDecision
  ) => {
    const result = await actions.dispatch(controlRow, action, {
      ...(steerMessage ? { steerMessage } : {}),
      ...(reviewDecision ? { reviewDecision } : {}),
      ...((action === "approve" || action === "deny") && run ? { reviewedRun: run } : {}),
    })
    setOutcome(result)
    // A steer that was not accepted leaves the text in the box: the message is
    // still the user's and clearing it would drop what they typed.
    if (result.accepted && action === "steer") setSteerText("")
  }

  // The Squad review waiting on a person, if the pending interrupt is one.
  // Its typed form replaces the bare Approve / Deny buttons: the gate refuses
  // an approve that does not say how much budget, which teammates or which
  // host, so offering the bare verb would be offering a refusal.
  const pendingReview = interrupts.find(
    (interrupt) =>
      interrupt.status === "pending" &&
      interrupt.id === run?.latestSnapshot?.pendingInterrupt?.id &&
      isRenderableSquadReview(interrupt)
  )
  const pendingBotApproval = interrupts.find(
    (interrupt) =>
      interrupt.type === "bot_approval" &&
      interrupt.status === "pending" &&
      interrupt.id === run?.latestSnapshot?.pendingInterrupt?.id
  )
  // A Router + Fusion delegate run parked on a person (ADR-0188 B4). Like the
  // Squad review above, its decision is typed — what is approved is a digest
  // over paths and a revision — so `DelegateReviewPane` owns approve / deny
  // and the bare verbs are hidden.
  const pendingFusionApproval = interrupts.find(
    (interrupt) =>
      isFusionApprovalInterrupt(interrupt) &&
      interrupt.status === "pending" &&
      interrupt.id === run?.latestSnapshot?.pendingInterrupt?.id
  )
  const botEvidence = botDetailRecord(botResult?.output) ?? pendingBotApproval?.approvalDetail
  const botSnapshot = botSnapshotFrom(botEvidence)
  const botTests = botTestsFrom(botEvidence)
  const botPaths = new Set(botSnapshot?.files?.map((file) => file.path))
  const journalChanges = detail.changes.filter((change) => !botPaths.has(change.path))
  const changeCount = journalChanges.length + (botSnapshot?.files?.length ?? 0)
  const hasRawBotDiff = typeof botSnapshot?.diff === "string" && Boolean(botSnapshot.diff.trim())
  const snapshotError =
    typeof botEvidence?.snapshotError === "string" ? botEvidence.snapshotError : undefined

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words text-base font-semibold">{row.label}</h2>
        <ExecutionStatusPill status={row.status} />
      </div>

      {(run?.sessionId ?? row.sessionId) && (
        <Link
          href={`/${buildSessionHref((run?.sessionId ?? row.sessionId)!)}`}
          className="text-sm text-primary hover:underline"
        >
          {t("actions.openConversation")}
        </Link>
      )}

      <ControlBar
        row={controlRow}
        actions={actions}
        busy={busy}
        hideDecisionVerbs={
          pendingReview !== undefined ||
          row.kind === "bot" ||
          pendingBotApproval !== undefined ||
          pendingFusionApproval !== undefined
        }
        onDispatch={(action) => void dispatch(action)}
      />

      {pendingReview && (
        <SquadReviewForm
          interrupt={pendingReview}
          busy={busy}
          onDecide={(action, decision) => void dispatch(action, undefined, decision)}
        />
      )}

      {pendingBotApproval && (
        <section
          className="space-y-3 rounded-md border p-3"
          aria-label={t(
            pendingBotApproval.approvalDetail?.externalAgent
              ? "botApproval.commandTitle"
              : "botApproval.title"
          )}
        >
          <h3 className="text-sm font-medium">{pendingBotApproval.title}</h3>
          {pendingBotApproval.approvalRisk && (
            <Badge
              variant={botApprovalRiskVariant(pendingBotApproval.approvalRisk)}
              className="text-[10px]"
            >
              {t(`botApproval.risk.${pendingBotApproval.approvalRisk}`)}
            </Badge>
          )}
          {pendingBotApproval.approvalDetail ? (
            <>
              <BotApprovalDetail detail={pendingBotApproval.approvalDetail} />
              <div className="flex gap-2">
                {(["approve", "deny"] as const)
                  .filter((action) => actions.can(controlRow, action))
                  .map((action) => (
                    <Button
                      key={action}
                      size="sm"
                      variant={action === "deny" ? "destructive" : "outline"}
                      disabled={busy}
                      onClick={() => void dispatch(action)}
                    >
                      {t(`actions.${action}`)}
                    </Button>
                  ))}
              </div>
            </>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t("botApproval.detailUnavailable")}
            </p>
          )}
        </section>
      )}

      {/* A Router + Fusion run (`kind: "fusion"`). The pane renders nothing
          unless the run is a delegation and Router + Fusion is switched on —
          it reads that behind the gate — so every other run keeps this pane
          exactly as it was. */}
      {row.kind === "fusion" && (
        <DelegateReviewPane
          runId={row.runId}
          interrupt={pendingFusionApproval ?? null}
          busy={busy}
          onDecide={(action) => void dispatch(action)}
        />
      )}

      {actions.can(controlRow, "steer") && (
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
          {outcome.consentCode && (
            <span className="block">
              {t("outcome.consentCode")} <code>{outcome.consentCode}</code>
            </span>
          )}
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
            <SectionCount value={changeCount} />
          </TabsTrigger>
          <TabsTrigger value="tests">
            {t("tabs.tests")}
            <SectionCount value={detail.verifications.length + botTests.length} />
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            {t("tabs.artifacts")}
            <SectionCount value={detail.artifacts.length + (botResult ? 1 : 0)} />
          </TabsTrigger>
          <TabsTrigger value="approvals">
            {t("tabs.approvals")}
            <SectionCount value={interrupts.length} />
          </TabsTrigger>
          {/* External notification deliveries for this run — the V2 ledger.
              Always offered: any run kind can fan out to a configured target. */}
          <TabsTrigger value="notifications">{t("tabs.notifications")}</TabsTrigger>
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
            value={format.relativeTime(new Date(row.startedAt), now)}
          />
          {row.endedAt !== undefined && (
            <InspectRow
              label={t("detail.finished")}
              value={`${format.relativeTime(new Date(row.endedAt), now)} (${duration})`}
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
              value={waitingReasonLabel(t, run.latestSnapshot.waitingReason)}
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
          <Unavailable
            when={!journalAvailable && !botSnapshot && !snapshotError}
            label={t("detail.journalUnavailable")}
          >
            {!changesAreComplete(detail.changeSummary) && (
              <p className="mb-2 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                {t("detail.changesIncomplete")}
              </p>
            )}
            {snapshotError && (
              <p role="status" className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                {t("detail.changesIncomplete")} {snapshotError}
              </p>
            )}
            <EmptyOr
              empty={changeCount === 0 && !hasRawBotDiff && !snapshotError}
              label={t("detail.noChanges")}
            >
              <>
                <ul className="space-y-1">
                  {journalChanges.map((change) => (
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
                {botSnapshot && <BotSnapshotDetail snapshot={botSnapshot} />}
              </>
            </EmptyOr>
          </Unavailable>
        </TabsContent>

        <TabsContent value="tests" className="pt-2">
          <EmptyOr
            empty={detail.verifications.length === 0 && botTests.length === 0}
            label={t("detail.noTests")}
          >
            <>
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
              {botTests.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t("botApproval.agentReported")}
                  </p>
                  {botTests.map((test, index) => (
                    <div
                      key={`${index}:${test.command}`}
                      className="space-y-1 rounded border p-2 text-xs"
                    >
                      <p className="break-words font-mono">{test.command}</p>
                      <InspectRow label={t("tests.exitCode")} value={String(test.exitCode)} />
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">
                        {test.output}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </>
          </EmptyOr>
        </TabsContent>

        <TabsContent value="artifacts" className="pt-2">
          <EmptyOr
            empty={detail.artifacts.length === 0 && !botResult}
            label={t("detail.noArtifacts")}
          >
            <ul className="space-y-1">
              {botResult && (
                <li className="rounded border px-2 py-1 text-xs">
                  {botResult.summary && (
                    <p className="whitespace-pre-wrap break-words">{botResult.summary}</p>
                  )}
                  {botResult.output &&
                  typeof botResult.output === "object" &&
                  !Array.isArray(botResult.output) ? (
                    <BotApprovalDetail
                      detail={botResult.output as Record<string, unknown>}
                      context="result"
                    />
                  ) : botResult.output !== undefined ? (
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
                      {JSON.stringify(botResult.output, null, 2)}
                    </pre>
                  ) : null}
                </li>
              )}
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
                  <li key={interrupt.id} className="rounded border px-2 py-1 text-xs">
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t(`approvals.${interrupt.status}`)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{interrupt.title}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {format.relativeTime(new Date(interrupt.createdAt), now)}
                    </span>
                    {interrupt.type === "bot_approval" && interrupt.approvalDetail && (
                      <BotApprovalDetail detail={interrupt.approvalDetail} />
                    )}
                  </li>
                ))}
              </ul>
            </EmptyOr>
          </Unavailable>
        </TabsContent>

        <TabsContent value="notifications" className="pt-2">
          <RunNotificationsTab row={row} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function botApprovalRiskVariant(
  risk: NonNullable<ExecutionRunInterrupt["approvalRisk"]>
): "secondary" | "outline" | "destructive" {
  return risk === "high" ? "destructive" : risk === "medium" ? "outline" : "secondary"
}

function botDetailRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function botSnapshotFrom(
  detail: Record<string, unknown> | undefined
): Partial<BotWorkspaceSnapshot> | undefined {
  const candidate = detail?.snapshot as Partial<BotWorkspaceSnapshot> | undefined
  return candidate &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.files) &&
    candidate.files.every(
      (file) =>
        file &&
        typeof file.path === "string" &&
        (file.oldContent === null || typeof file.oldContent === "string") &&
        (file.newContent === null || typeof file.newContent === "string")
    )
    ? candidate
    : undefined
}

interface BotReportedTest {
  command: string
  exitCode: number
  output: string
}

function botTestsFrom(detail: Record<string, unknown> | undefined): BotReportedTest[] {
  const report = botDetailRecord(detail?.report)
  const tests = report?.tests
  return Array.isArray(tests) &&
    tests.every(
      (test) =>
        test &&
        typeof test.command === "string" &&
        test.command.trim() &&
        Number.isInteger(test.exitCode) &&
        typeof test.output === "string"
    )
    ? (tests as BotReportedTest[])
    : []
}

function BotSnapshotDetail({ snapshot }: { snapshot: Partial<BotWorkspaceSnapshot> }) {
  const t = useTranslations("agentRuns")
  return (
    <div className="space-y-3 py-2">
      <>
        <InspectRow label={t("botApproval.baseSha")} value={snapshot.baseSha} />
        <InspectRow label={t("botApproval.headSha")} value={snapshot.headSha} />
        {snapshot.files!.map((file) => (
          <div key={file.path} className="space-y-1">
            <p className="break-all font-mono text-xs">{file.path}</p>
            {typeof file.mode === "string" && (
              <InspectRow label={t("botApproval.fileMode")} value={file.mode} />
            )}
            <div className="h-80 overflow-hidden rounded border">
              <DiffViewer
                staged={false}
                readOnly
                diff={{
                  path: file.path,
                  oldContent: file.oldContent ?? "",
                  newContent: file.newContent ?? "",
                  hunks: [],
                  isBinary: false,
                }}
              />
            </div>
          </div>
        ))}
      </>

      {snapshot.files?.length === 0 &&
        typeof snapshot.diff === "string" &&
        snapshot.diff.trim() && (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
            {snapshot.diff}
          </pre>
        )}
    </div>
  )
}

function BotApprovalDetail({
  detail,
  context = "approval",
}: {
  detail: Record<string, unknown>
  context?: "approval" | "result"
}) {
  const t = useTranslations("agentRuns")
  const snapshot = botSnapshotFrom(detail)
  return (
    <div className="space-y-3 py-2">
      {typeof detail.model === "string" && (
        <InspectRow label={t("botApproval.model")} value={detail.model} />
      )}
      {typeof detail.sessionId === "string" && (
        <InspectRow label={t("botApproval.session")} value={detail.sessionId} />
      )}
      {snapshot && <BotSnapshotDetail snapshot={snapshot} />}
      {detail.testEvidence === "agent-reported" && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("botApproval.agentReported")}
        </p>
      )}
      {detail.report !== undefined && (
        <div>
          <h4 className="text-xs font-medium">{t("botApproval.report")}</h4>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
            {JSON.stringify(detail.report, null, 2)}
          </pre>
        </div>
      )}
      <div>
        <h4 className="text-xs font-medium">
          {t(
            context === "result"
              ? "botApproval.result"
              : detail.externalAgent
                ? "botApproval.command"
                : "botApproval.publication"
          )}
        </h4>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
          {JSON.stringify(
            Object.fromEntries(
              Object.entries(detail).filter(([key]) => !["snapshot", "report"].includes(key))
            ),
            null,
            2
          )}
        </pre>
      </div>
    </div>
  )
}

/**
 * The waiting reason is a code (`waiting_review`, `recovery_required`). A
 * code this catalogue does not know (an older journal, another engine's own
 * vocabulary) is shown verbatim rather than as a missing-key marker.
 */
function waitingReasonLabel(
  t: ReturnType<typeof useTranslations<"agentRuns">>,
  code: string
): string {
  const key = `waitingReasons.${code}` as const
  return typeof t.has === "function" && t.has(key as never) ? t(key as never) : code
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
  hideDecisionVerbs = false,
  onDispatch,
}: {
  row: UnifiedExecutionRow
  actions: RunControlActions
  busy: boolean
  /** True while a typed review form owns approve / deny. */
  hideDecisionVerbs?: boolean
  onDispatch: (action: RunControlAction) => void
}) {
  const t = useTranslations("agentRuns")
  const available = CONTROL_ORDER.filter(
    (action) =>
      actions.can(row, action) &&
      !(hideDecisionVerbs && (action === "approve" || action === "deny"))
  )
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
