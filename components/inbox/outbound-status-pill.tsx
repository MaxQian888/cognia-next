"use client"

/**
 * Outbound status pill — rendered next to assistant messages when
 * `metadata.outboundJobId` is set. Subscribes to the matching outboundQueue
 * row via useLiveQuery.
 *
 * States: queued / sending / sent / failed (with retry button) / deadlettered.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ClockIcon,
  LoaderIcon,
  CheckIcon,
  AlertCircleIcon,
  BanIcon,
  RefreshCwIcon,
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
  { label: string; icon: React.ComponentType<{ className?: string }>; colorClass: string }
> = {
  pending: { label: "Queued", icon: ClockIcon, colorClass: "text-muted-foreground" },
  sending: { label: "Sending", icon: LoaderIcon, colorClass: "text-amber-500" },
  sent: { label: "Sent", icon: CheckIcon, colorClass: "text-emerald-500" },
  failed: { label: "Failed", icon: AlertCircleIcon, colorClass: "text-destructive" },
  deadlettered: { label: "Dead-lettered", icon: BanIcon, colorClass: "text-destructive" },
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

  const handleRetry = async () => {
    await getDb().outboundQueue.update(jobId, {
      status: "pending",
      nextAttemptAt: Date.now(),
    })
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("inline-flex items-center gap-1 text-xs", config.colorClass, className)}
          data-testid={`outbound-status-pill-${jobId}`}
          data-status={job.status}
        >
          <Icon className={cn("h-3 w-3", job.status === "sending" && "animate-spin")} />
          <span>{config.label}</span>
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
          ? (job.lastError ?? "Unknown error")
          : config.label}
      </TooltipContent>
    </Tooltip>
  )
}
