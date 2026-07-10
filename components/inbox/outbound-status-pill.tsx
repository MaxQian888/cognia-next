"use client"

/**
 * Outbound status pill — rendered next to assistant messages when
 * `metadata.outboundJobId` is set. Subscribes to the matching outboundQueue
 * row via useLiveQuery.
 *
 * States: queued / sending / sent / failed (with retry button) / deadlettered.
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
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getDb } from "@/lib/db/schema"
import type { OutboundJobRow, OutboundJobStatus } from "@/lib/db/connector-types"

interface OutboundStatusPillProps {
  jobId: string
  className?: string
}

const STATUS_CONFIG: Record<
  OutboundJobStatus,
  { icon: React.ComponentType<{ className?: string }>; colorClass: string }
> = {
  pending: { icon: ClockIcon, colorClass: "text-muted-foreground" },
  sending: { icon: LoaderIcon, colorClass: "text-amber-500" },
  sent: { icon: CheckIcon, colorClass: "text-emerald-500" },
  failed: { icon: AlertCircleIcon, colorClass: "text-destructive" },
  deadlettered: { icon: BanIcon, colorClass: "text-destructive" },
}

export function OutboundStatusPill({ jobId, className }: OutboundStatusPillProps) {
  const t = useTranslations("inbox.outboundStatus")
  const job = useLiveQuery<OutboundJobRow | undefined>(
    () =>
      typeof window === "undefined" ? Promise.resolve(undefined) : getDb().outboundQueue.get(jobId),
    [jobId]
  )

  if (!job) return null

  const config = STATUS_CONFIG[job.status]
  const Icon = config.icon
  const statusLabel = t(`status.${job.status}`)

  const handleRetry = async () => {
    await getDb().outboundQueue.update(jobId, {
      status: "pending",
      nextAttemptAt: Date.now(),
    })
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn("inline-flex items-center gap-1 text-xs", config.colorClass, className)}
            data-testid={`outbound-status-pill-${jobId}`}
            data-status={job.status}
          >
            <Icon className={cn("h-3 w-3", job.status === "sending" && "animate-spin")} />
            <span>{statusLabel}</span>
            {job.status === "failed" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1 text-xs"
                onClick={() => void handleRetry()}
                data-testid={`outbound-retry-btn-${jobId}`}
              >
                <RefreshCwIcon className="h-3 w-3" />
                <span className="sr-only">{t("retry")}</span>
              </Button>
            )}
          </span>
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
          <Link
            href={`/workflows/run?id=${encodeURIComponent(workflowId)}&runId=${encodeURIComponent(runId)}#node-${nodeId}`}
            data-testid={`outbound-source-badge-${job.id}`}
            data-source="workflow"
            className="inline-flex items-center gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
          >
            <WorkflowIcon className="h-3 w-3" />
            <span>{t("workflow")}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t("workflowTooltip", { nodeId })}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (job.source === "manual") {
    return (
      <span
        data-testid={`outbound-source-badge-${job.id}`}
        data-source="manual"
        className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400"
      >
        {t("manual")}
      </span>
    )
  }

  if (job.source === "draft-approved") {
    return (
      <span
        data-testid={`outbound-source-badge-${job.id}`}
        data-source="draft-approved"
        className="inline-flex items-center rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400"
      >
        {t("draftApproved")}
      </span>
    )
  }

  if (job.source === "skill") {
    // im.* built-in skill sends (W2): new-chat first message / broadcast.
    return (
      <span
        data-testid={`outbound-source-badge-${job.id}`}
        data-source="skill"
        className="inline-flex items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
      >
        {t("skill")}
      </span>
    )
  }

  return null
}
