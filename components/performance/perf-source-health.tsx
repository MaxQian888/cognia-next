"use client"

import { Surface } from "@/components/surface/surface"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Clock3Icon,
  MinusCircleIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type {
  PerfConnectionState,
  PerfGap,
  PerfLeaseRejectionCode,
  PerfSourceDescriptor,
} from "@/lib/perf/backend/types"
import type { PerfHostIssue } from "@/lib/perf/host-live-lease"

const stateIcons: Record<PerfConnectionState, typeof CheckCircle2Icon> = {
  connecting: Clock3Icon,
  live: CheckCircle2Icon,
  stale: AlertCircleIcon,
  error: AlertCircleIcon,
  unsupported: MinusCircleIcon,
}

/** Which sentence names the holder of a contended lease. */
const CONTENDED_KEY: Partial<Record<PerfLeaseRejectionCode, string>> = {
  "device-purpose-limit": "issue.contended.deviceBusy",
  "host-lease-limit": "issue.contended.hostBusy",
  "rate-limited": "issue.contended.rateLimited",
  "target-mismatch": "issue.contended.targetBusy",
  "routing-generation-mismatch": "issue.contended.targetBusy",
}

/** The localized sentence for a typed host lease issue. */
function useHostIssueMessage(issue: PerfHostIssue | null): string | null {
  const t = useTranslations("performance.sourceHealth")
  if (!issue) return null
  switch (issue.kind) {
    case "contended":
      return t(CONTENDED_KEY[issue.code] ?? "issue.contended.hostBusy")
    case "rejected":
      return t("issue.rejected", { code: issue.code })
    case "renew-failed":
      return t("issue.renewFailed")
    case "unreachable":
      return t("issue.unreachable")
  }
}

/**
 * The overview's one-line "something about the data is off" notice: a host
 * lease issue, or gaps in the visible window. The full source card moved to
 * Diagnose — it is evidence about the measurement, and it used to sit above
 * the graphs on every visit, pushing the metrics below the fold to say
 * "Renderer: live" in a card. This shows only when there is something to act
 * on, and links to the detail.
 */
export function PerfSourceNotice({
  hostState,
  issue = null,
  gaps,
  onOpenDetails,
}: {
  hostState: PerfConnectionState
  issue?: PerfHostIssue | null
  gaps: PerfGap[]
  onOpenDetails: () => void
}) {
  const t = useTranslations("performance.sourceHealth")
  const issueMessage = useHostIssueMessage(hostState === "unsupported" ? null : issue)
  if (!issueMessage && gaps.length === 0) return null
  const contended = issue?.kind === "contended"
  return (
    <Surface
      role="status"
      className={
        contended
          ? "flex flex-wrap items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs"
          : "flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs"
      }
      data-testid="perf-source-notice"
    >
      <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {issueMessage ?? t("noticeGaps", { count: gaps.length })}
        {issueMessage && gaps.length > 0 ? ` · ${t("noticeGaps", { count: gaps.length })}` : null}
      </span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs"
        onClick={onOpenDetails}
        data-testid="perf-source-notice-details"
      >
        {t("details")}
        <ChevronRightIcon className="size-3" aria-hidden />
      </Button>
    </Surface>
  )
}

export function PerfSourceHealth({
  sources,
  hostState,
  gaps,
  error,
  issue = null,
  collectionDurationMs,
  actualIntervalMs,
}: {
  sources: PerfSourceDescriptor[]
  hostState: PerfConnectionState
  gaps: PerfGap[]
  /** Raw host wording, shown only when no typed {@link issue} explains it. */
  error: string | null
  /** Why the host lease is not live (see `lib/perf/host-live-lease.ts`). */
  issue?: PerfHostIssue | null
  collectionDurationMs?: number
  actualIntervalMs?: number
}) {
  const t = useTranslations("performance.sourceHealth")
  // A lease someone else holds is a wait, not a fault: it is explained in the
  // status line below and retried on its own, so "Latest error" stays clear.
  const contended = issue?.kind === "contended" ? issue : null
  const issueMessage = useHostIssueMessage(issue)
  const errorText = contended ? null : (issueMessage ?? error)
  const overhead =
    collectionDurationMs !== undefined && actualIntervalMs
      ? (collectionDurationMs / actualIntervalMs) * 100
      : null

  return (
    <Card data-testid="perf-source-health">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {sources.map((source) => {
            const state = source.kind === "host" ? hostState : source.connection.state
            const Icon = stateIcons[state]
            return (
              <div key={source.sourceId} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t(`kind.${source.kind}`)}</span>
                  <Badge variant={state === "live" ? "default" : "secondary"}>
                    <Icon className="mr-1 size-3" />
                    {t(`state.${state}`)}
                  </Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {source.runtimeKind} · {source.sourceId}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {source.capabilities.map((capability) => (
                    <Badge key={capability} variant="outline" className="font-mono text-[10px]">
                      {capability}
                    </Badge>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t("gaps")}</dt>
            <dd className="font-medium">{gaps.length}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("overhead")}</dt>
            <dd className="font-medium">
              {overhead === null ? t("notAvailable") : `${overhead.toFixed(2)}%`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("error")}</dt>
            <dd
              className="truncate font-medium"
              title={errorText && issue ? t("issue.detail", { detail: issue.detail }) : undefined}
              data-testid="perf-source-health-error"
            >
              {errorText ?? t("none")}
            </dd>
          </div>
        </dl>
        {contended && (
          <Surface
            role="status"
            className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs"
            title={t("issue.detail", { detail: contended.detail })}
            data-testid="perf-source-health-contended"
          >
            {issueMessage}
          </Surface>
        )}
        {gaps.length > 0 && (
          <Surface
            role="status"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
          >
            {t("latestGap", {
              reason: t(`gapReason.${gaps.at(-1)!.reason}`),
              start: new Date(gaps.at(-1)!.wallStartMs).toLocaleTimeString(),
              end: new Date(gaps.at(-1)!.wallEndMs).toLocaleTimeString(),
            })}
          </Surface>
        )}
      </CardContent>
    </Card>
  )
}
