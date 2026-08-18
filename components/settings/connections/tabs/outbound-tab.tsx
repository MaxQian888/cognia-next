"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  InboxIcon,
  RefreshCwIcon,
  XIcon,
  ZapOffIcon,
  MoonIcon,
  BanIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Toggle } from "@/components/ui/toggle"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { getDb } from "@/lib/db/schema"
import type {
  AdapterInstanceRow,
  ConnectorHeartbeatRow,
  OutboundJobRow,
  OutboundJobStatus,
} from "@/lib/db/connector-types"
import { replayDeadlettered } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"
import { cn } from "@/lib/utils"
import {
  deriveJobBadge,
  type DerivedJobBadge,
  type DerivedJobBadgeKind,
} from "@/lib/connectors/derive-job-badge"
import { buildDlqDownload } from "@/lib/connectors/dlq-export"
import { FileTextIcon, FileJsonIcon, Trash2Icon } from "lucide-react"

const ALL_STATUSES: OutboundJobStatus[] = [
  "pending",
  "sending",
  "sent",
  "failed",
  "delivery_unknown",
  "deadlettered",
]

type StatusFilter = OutboundJobStatus | "all"

const STATUS_VARIANT_MAP: Record<
  OutboundJobStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "secondary",
  sending: "default",
  sent: "outline",
  failed: "destructive",
  delivery_unknown: "secondary",
  deadlettered: "destructive",
}

function StatusBadge({ status }: { status: OutboundJobStatus }) {
  // Reuse the inbox's already-translated outbound status labels
  // (components/inbox/outbound-status-pill.tsx) instead of the raw enum.
  const tStatus = useTranslations("inbox.outboundStatus")
  return (
    <Badge
      variant={STATUS_VARIANT_MAP[status]}
      className={cn("text-xs shrink-0", {
        "text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30":
          status === "sending",
      })}
    >
      {tStatus(`status.${status}`)}
    </Badge>
  )
}

/**
 * Re-arm a failed or dead-lettered job for immediate retry. Dead-lettered
 * rows go through `replayDeadlettered` (clears the error state, resets
 * attempts, and emits the enqueue wake so the runner re-checks `pickNextDue`
 * right away). Failed rows also reset `attempts` (matching
 * `replayDeadlettered` semantics) — a manual retry is a fresh operator
 * decision, and a job already at max attempts would otherwise instantly
 * re-dead-letter without a single new send. Either way an
 * `outbound.replayed` audit row records the operator action with the
 * original error code so the replay is traceable.
 */
async function retryJob(id: string) {
  const row = await getDb().outboundQueue.get(id)
  if (!row) return
  if (row.status === "deadlettered") {
    await replayDeadlettered(id)
  } else {
    await getDb().outboundQueue.update(id, {
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  void appendAudit({
    adapterId: row.adapterId,
    kind: "outbound.replayed",
    at: Date.now(),
    conversationKey: row.conversationKey,
    fields: { jobId: id, lastErrorCode: row.lastErrorCode },
  })
}

async function cancelJob(id: string) {
  await getDb().outboundQueue.delete(id)
}

/**
 * Tier 5.2 — bulk re-enqueue every dead-letter row in the current scope.
 * Each row goes through `replayDeadlettered` so the error state is cleared,
 * attempts reset, and the runner is woken — and each is audited as
 * `outbound.replayed` with its original error code.
 */
async function retryAllDeadlettered(ids: string[]) {
  if (ids.length === 0) return
  for (const id of ids) {
    await retryJob(id)
  }
}

/** Drop every dead-letter row from the active filter scope. */
async function clearAllDeadlettered(ids: string[]) {
  if (ids.length === 0) return
  await getDb().outboundQueue.bulkDelete(ids)
}

/**
 * Hand the operator a CSV / JSON download of the rows in the current
 * filter scope. Uses `buildDlqDownload` so the column set stays stable
 * with the unit tests in `dlq-export.test.ts`.
 */
function downloadDlq(rows: OutboundJobRow[], format: "csv" | "json"): void {
  if (typeof window === "undefined") return
  const dl = buildDlqDownload(rows, format)
  const url = URL.createObjectURL(dl.blob)
  const a = document.createElement("a")
  a.href = url
  a.download = dl.filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const BADGE_STYLE: Record<DerivedJobBadgeKind, string | null> = {
  normal: null,
  "paused-muted": "text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30",
  "paused-quiet-hours": "text-sky-700 bg-sky-100 dark:text-sky-300 dark:bg-sky-900/30",
  "circuit-blocked": "text-destructive bg-destructive/10",
}

type AgeTranslator = (key: string, values?: Record<string, string | number | Date>) => string

/**
 * Coarse "time since" formatter — returns a short human label like
 * `"just now"` / `"5min"` / `"3h"` / `"2d"`. Used for deadletter age
 * (Task P2.3); kept inside the component file because the rendering and
 * formatting need to agree on rounding rules.
 */
function formatCoarseAge(ageMs: number, t: AgeTranslator): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000))
  if (seconds < 60) return t("ageJustNow")
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t("ageMinutes", { minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t("ageHours", { hours })
  const days = Math.round(hours / 24)
  return t("ageDays", { days })
}

function DerivedBadge({ badge, label }: { badge: DerivedJobBadge; label: string }) {
  if (badge.kind === "normal") return null
  const Icon =
    badge.kind === "circuit-blocked"
      ? BanIcon
      : badge.kind === "paused-muted"
        ? ZapOffIcon
        : MoonIcon
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-xs shrink-0", BADGE_STYLE[badge.kind])}
      data-testid={`outbound-derived-${badge.kind}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  )
}

interface OutboundTabProps {
  /** Injected in tests to pre-populate the filter. Defaults to "all". */
  initialFilter?: StatusFilter
  /**
   * When supplied (im-refactored-crayon), scopes the view to a single
   * adapter. The status-filter chip row is still shown so the operator
   * can drill into pending / failed / deadlettered states per-adapter.
   */
  adapterId?: string
}

export function OutboundTab({ initialFilter = "all", adapterId }: OutboundTabProps = {}) {
  const t = useTranslations("settings.connections.outbound")
  const tStatus = useTranslations("inbox.outboundStatus")
  const [filter, setFilter] = useState<StatusFilter>(initialFilter)
  // Capture render time once so we don't call Date.now() during render on every re-render
  // (satisfies react-hooks/purity). Jobs with nextAttemptAt in the future show a retry hint.
  const [now] = useState(() => Date.now())
  // Set of job ids currently expanded so the operator can drill into one row's
  // segments / lastError / idempotencyKey without leaving the tab. Local-only
  // state — collapses on remount, which is the intended "fresh start" semantic.
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(() => new Set())
  const toggleExpanded = (jobId: string) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }

  const allJobs = useLiveQuery<OutboundJobRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb().outboundQueue.orderBy("createdAt").reverse().toArray(),
    []
  )

  // Adapter rows — joined per-job so derive-job-badge can read `muted` /
  // `quietHours` without an extra live query per row.
  const adapterRows = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )
  const adapterById = new Map((adapterRows ?? []).map((a) => [a.id, a]))

  // Latest heartbeat per adapter — used to read the breaker state snapshot
  // that the runner writes alongside each heartbeat row (Task 2.1).
  const recentHeartbeats = useLiveQuery<ConnectorHeartbeatRow[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    const since = Date.now() - 60 * 60 * 1000 // last hour is plenty
    // Dedicated heartbeat table (v51) — every row is a heartbeat, no filter.
    return getDb().connectorHeartbeats.where("at").above(since).toArray()
  }, [])
  const breakerStateById = new Map<string, "closed" | "open" | "half_open">()
  // Keep the newest heartbeat per adapter so the derived badge tracks the
  // live breaker state. Sorting descending by `at` and taking the first
  // hit per adapter is O(n log n) on a max-1h slice, which is plenty.
  const newestHeartbeats = (recentHeartbeats ?? []).slice().sort((a, b) => b.at - a.at)
  for (const row of newestHeartbeats) {
    if (breakerStateById.has(row.adapterId)) continue
    const state = row.fields?.breakerState
    if (state === "closed" || state === "open" || state === "half_open") {
      breakerStateById.set(row.adapterId, state)
    }
  }

  const scoped = !allJobs
    ? []
    : adapterId
      ? allJobs.filter((j) => j.adapterId === adapterId)
      : allJobs
  const jobs = filter === "all" ? scoped : scoped.filter((j) => j.status === filter)

  const deadletteredIds = jobs.filter((j) => j.status === "deadlettered").map((j) => j.id)
  const showBulkRetry = filter === "deadlettered" && deadletteredIds.length > 0

  return (
    <div className="space-y-4">
      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Toggle
          size="sm"
          pressed={filter === "all"}
          onPressedChange={() => setFilter("all")}
          aria-label={t("filterAllAria")}
        >
          {t("filterAll")}
        </Toggle>
        {ALL_STATUSES.map((s) => {
          const statusLabel = tStatus(`status.${s}`)
          return (
            <Toggle
              key={s}
              size="sm"
              pressed={filter === s}
              onPressedChange={() => setFilter(s)}
              aria-label={t("filterStatusAria", { status: statusLabel })}
            >
              {statusLabel}
            </Toggle>
          )
        })}
        {showBulkRetry && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => downloadDlq(jobs, "csv")}
              data-testid="outbound-export-csv"
            >
              <FileTextIcon className="mr-1.5 h-3.5 w-3.5" />
              {t("exportCsv")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => downloadDlq(jobs, "json")}
              data-testid="outbound-export-json"
            >
              <FileJsonIcon className="mr-1.5 h-3.5 w-3.5" />
              {t("exportJson")}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  data-testid="outbound-clear-trigger"
                >
                  <Trash2Icon className="mr-1.5 h-3.5 w-3.5" />
                  {t("clearAll", { count: deadletteredIds.length })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("clearAllConfirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("clearAllConfirmDescription", { count: deadletteredIds.length })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("bulkRetryCancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => clearAllDeadlettered(deadletteredIds)}
                    data-testid="outbound-clear-confirm"
                  >
                    {t("clearAllConfirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" data-testid="outbound-bulk-retry-trigger">
                  <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
                  {t("bulkRetryDeadlettered", { count: deadletteredIds.length })}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("bulkRetryConfirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("bulkRetryConfirmDescription", { count: deadletteredIds.length })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("bulkRetryCancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => retryAllDeadlettered(deadletteredIds)}
                    data-testid="outbound-bulk-retry-confirm"
                  >
                    {t("bulkRetryConfirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      {/* Job list */}
      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <InboxIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => {
            const derivedBadge = deriveJobBadge({
              job,
              adapter: adapterById.get(job.adapterId) ?? null,
              breakerState: breakerStateById.get(job.adapterId) ?? null,
              now,
            })
            const derivedLabel =
              derivedBadge.kind === "circuit-blocked"
                ? t("badgeCircuitBlocked")
                : derivedBadge.kind === "paused-muted"
                  ? t("badgePausedMuted")
                  : derivedBadge.kind === "paused-quiet-hours"
                    ? t("badgePausedQuietHours")
                    : ""
            const expanded = expandedJobs.has(job.id)
            const isDead = job.status === "deadlettered"
            const ageLabel = isDead ? formatCoarseAge(now - job.createdAt, t) : null
            return (
              <div
                key={job.id}
                className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-sm"
                data-testid={`outbound-row-${job.id}`}
              >
                <div className="flex items-start gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleExpanded(job.id)}
                    className="mt-0.5 size-5 text-muted-foreground hover:text-foreground"
                    aria-label={
                      expanded
                        ? t("collapseDetailsAria", { id: job.id })
                        : t("expandDetailsAria", { id: job.id })
                    }
                    aria-expanded={expanded}
                    data-testid={`outbound-toggle-${job.id}`}
                  >
                    {expanded ? (
                      <ChevronDownIcon className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRightIcon className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <StatusBadge status={job.status} />
                  <DerivedBadge badge={derivedBadge} label={derivedLabel} />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="truncate font-mono text-xs">{job.conversationKey}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("adapterLabel", { adapter: job.adapterId, attempts: job.attempts })}
                    </p>
                    {job.status === "failed" && job.nextAttemptAt > now && (
                      <p className="text-xs text-muted-foreground">
                        {t("nextRetry", {
                          time: new Date(job.nextAttemptAt).toLocaleTimeString(),
                        })}
                      </p>
                    )}
                    {isDead && ageLabel && (
                      <p
                        className="text-xs text-destructive"
                        data-testid={`outbound-deadletter-age-${job.id}`}
                      >
                        {t("deadletterAge", { age: ageLabel })}
                      </p>
                    )}
                    {derivedBadge.kind === "paused-quiet-hours" && derivedBadge.etaMs !== null && (
                      <p className="text-xs text-muted-foreground" data-testid="outbound-quiet-eta">
                        {t("quietHoursResume", {
                          minutes: Math.max(1, Math.round(derivedBadge.etaMs / 60_000)),
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(job.status === "failed" || job.status === "deadlettered") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => retryJob(job.id)}
                        aria-label={t("retryAria", { id: job.id })}
                      >
                        <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
                        {t("retry")}
                      </Button>
                    )}
                    {job.status === "pending" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancelJob(job.id)}
                        aria-label={t("cancelAria", { id: job.id })}
                      >
                        <XIcon className="mr-1.5 h-3.5 w-3.5" />
                        {t("cancel")}
                      </Button>
                    )}
                  </div>
                </div>
                {expanded && (
                  <div
                    className="space-y-2 rounded-md border bg-muted/30 px-3 py-2 text-xs"
                    data-testid={`outbound-detail-${job.id}`}
                  >
                    <div className="flex flex-wrap gap-2">
                      <span className="text-muted-foreground">{t("detailIdempotencyKey")}:</span>
                      <code className="break-all">{job.idempotencyKey}</code>
                    </div>
                    {job.lastError && (
                      <div className="flex flex-wrap gap-2">
                        <span className="text-muted-foreground">{t("detailLastError")}:</span>
                        <span className="break-all text-destructive">
                          {job.lastErrorCode ? `[${job.lastErrorCode}] ` : ""}
                          {job.lastError}
                        </span>
                      </div>
                    )}
                    {job.sourceWorkflow && (
                      <div className="flex flex-wrap gap-2">
                        <span className="text-muted-foreground">{t("detailWorkflow")}:</span>
                        <code className="break-all">
                          {job.sourceWorkflow.workflowId} · {job.sourceWorkflow.nodeId}
                        </code>
                      </div>
                    )}
                    <div className="space-y-1">
                      <span className="text-muted-foreground">{t("detailSegments")}:</span>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-card px-2 py-1 font-mono">
                        {JSON.stringify(job.request.segments, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
