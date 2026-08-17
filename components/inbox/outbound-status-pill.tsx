"use client"

/**
 * Outbound status pill — the delivery state of one outbound job.
 *
 * Two addressing modes (ADR-0009 §3A.2):
 *   - `{ jobId }` — a specific outboundQueue row (message-level provenance,
 *     e.g. `metadata.outboundJobId` on an assistant message).
 *   - `{ conversationKey }` — the NEWEST job of a conversation, resolved by
 *     `useLatestOutboundJob`. This is what the Inbox conversation header's
 *     `⋯` overflow mounts under "Health", so an operator sees at a glance
 *     whether the last reply actually left the building.
 *
 * States: queued / sending / sent / failed (with retry button) /
 * delivery_unknown / deadlettered.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ClockIcon,
  LoaderIcon,
  CheckIcon,
  AlertCircleIcon,
  BanIcon,
  RefreshCwIcon,
  WorkflowIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getDb } from "@/lib/db/schema"
import type { OutboundJobRow, OutboundJobStatus } from "@/lib/db/connector-types"
import { useLatestOutboundJob } from "@/hooks/connectors/use-latest-outbound-job"

export type OutboundStatusPillProps = { className?: string } & (
  { jobId: string; conversationKey?: never } | { conversationKey: string; jobId?: never }
)

const STATUS_CONFIG: Record<
  OutboundJobStatus,
  {
    icon: React.ComponentType<{ className?: string }>
    variant: "outline" | "warning" | "success" | "destructive"
  }
> = {
  pending: { icon: ClockIcon, variant: "outline" },
  sending: { icon: LoaderIcon, variant: "warning" },
  sent: { icon: CheckIcon, variant: "success" },
  failed: { icon: AlertCircleIcon, variant: "destructive" },
  delivery_unknown: { icon: AlertCircleIcon, variant: "warning" },
  deadlettered: { icon: BanIcon, variant: "destructive" },
}

export function OutboundStatusPill(props: OutboundStatusPillProps) {
  const t = useTranslations("inbox.outboundStatus")
  const jobId = props.jobId ?? null
  const byId = useLiveQuery<OutboundJobRow | undefined>(
    () =>
      typeof window === "undefined" || !jobId
        ? Promise.resolve(undefined)
        : getDb().outboundQueue.get(jobId),
    [jobId]
  )
  const latest = useLatestOutboundJob(props.conversationKey ?? null)
  const job = jobId ? byId : (latest ?? undefined)
  const className = props.className

  if (!job) return null

  const config = STATUS_CONFIG[job.status]
  const Icon = config.icon
  const statusLabel = t(`status.${job.status}`)

  const handleRetry = async () => {
    await getDb().outboundQueue.update(job.id, {
      status: "pending",
      nextAttemptAt: Date.now(),
    })
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={config.variant}
            className={cn("h-5 gap-1 px-1.5 text-[10px]", className)}
            data-testid={`outbound-status-pill-${job.id}`}
            data-status={job.status}
          >
            <Icon className={cn("size-3", job.status === "sending" && "animate-spin")} />
            <span>{statusLabel}</span>
            {job.status === "failed" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1 text-xs"
                onClick={() => void handleRetry()}
                data-testid={`outbound-retry-btn-${job.id}`}
              >
                <RefreshCwIcon className="h-3 w-3" />
                <span className="sr-only">{t("retry")}</span>
              </Button>
            )}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {job.status === "failed" || job.status === "deadlettered"
            ? (job.lastError ?? t("unknownError"))
            : statusLabel}
        </TooltipContent>
      </Tooltip>
      <OutboundSourceBadge job={job} />
    </span>
  )
}

/**
 * Source provenance badge (ADR-0009 v41 / E2). Appears next to the status
 * pill when the job's `source` is anything other than the dominant
 * `"ai-run"` path. Workflow-sourced jobs render with a click-to-jump link
 * into the workflow run view; manual / draft-approved render as plain
 * badges (those origins are already self-evident from the inbox UX, but
 * surfacing them keeps the audit story uniform).
 *
 * Rows persisted before v41 backfill to `source: "ai-run"` so this
 * component renders nothing for legacy data — matching the v18-v40 UX.
 */
function OutboundSourceBadge({ job }: { job: OutboundJobRow }) {
  const t = useTranslations("inbox.outboundSource")
  if (job.source === "ai-run") return null

  if (job.source === "workflow" && job.sourceWorkflow) {
    const { workflowId, runId, nodeId } = job.sourceWorkflow
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge asChild variant="outline" className="h-5 gap-0.5 px-1.5 text-[10px]">
            <Link
              href={`/workflows/run?id=${encodeURIComponent(workflowId)}&runId=${encodeURIComponent(runId)}#node-${nodeId}`}
              data-testid={`outbound-source-badge-${job.id}`}
              data-source="workflow"
            >
              <WorkflowIcon className="size-3" />
              <span>{t("workflow")}</span>
            </Link>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t("workflowTooltip", { nodeId })}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (job.source === "manual") {
    return (
      <Badge
        variant="secondary"
        data-testid={`outbound-source-badge-${job.id}`}
        data-source="manual"
        className="h-5 px-1.5 text-[10px]"
      >
        {t("manual")}
      </Badge>
    )
  }

  if (job.source === "draft-approved") {
    return (
      <Badge
        variant="outline"
        data-testid={`outbound-source-badge-${job.id}`}
        data-source="draft-approved"
        className="h-5 px-1.5 text-[10px]"
      >
        {t("draftApproved")}
      </Badge>
    )
  }

  if (job.source === "plugin") {
    // ctx.connectors.enqueueSend — plugin-driven durable sends.
    return (
      <Badge
        variant="secondary"
        data-testid={`outbound-source-badge-${job.id}`}
        data-source="plugin"
        className="h-5 px-1.5 text-[10px]"
      >
        {t("plugin")}
      </Badge>
    )
  }

  if (job.source === "skill") {
    // im.* built-in skill sends (W2): new-chat first message / broadcast.
    return (
      <Badge
        variant="outline"
        data-testid={`outbound-source-badge-${job.id}`}
        data-source="skill"
        className="h-5 px-1.5 text-[10px]"
      >
        {t("skill")}
      </Badge>
    )
  }

  return null
}
