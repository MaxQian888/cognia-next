"use client"

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  LoaderIcon,
  PauseCircleIcon,
  PlayCircleIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { RunStatus } from "@/types/workflow/visual"

const STATUS_META: Record<RunStatus, { className: string; icon: typeof CheckCircle2Icon }> = {
  pending: {
    className: "bg-wf-status-idle/15 text-wf-status-idle border-wf-status-idle/40",
    icon: CircleDashedIcon,
  },
  running: {
    className: "bg-wf-status-waiting/15 text-wf-status-waiting border-wf-status-waiting/40",
    icon: LoaderIcon,
  },
  waiting: {
    className: "bg-wf-status-running/15 text-wf-status-running border-wf-status-running/40",
    icon: PlayCircleIcon,
  },
  paused: {
    className: "bg-wf-status-running/15 text-wf-status-running border-wf-status-running/40",
    icon: PauseCircleIcon,
  },
  succeeded: {
    className: "bg-wf-status-succeeded/15 text-wf-status-succeeded border-wf-status-succeeded/40",
    icon: CheckCircle2Icon,
  },
  failed: {
    className: "bg-wf-status-failed/15 text-wf-status-failed border-wf-status-failed/40",
    icon: CircleAlertIcon,
  },
  cancelled: {
    className: "bg-wf-status-skipped/15 text-wf-status-skipped border-wf-status-skipped/40",
    icon: CircleSlashIcon,
  },
}

export function RunStatusPill({
  status,
  className,
  showIcon = true,
}: {
  status: RunStatus
  className?: string
  showIcon?: boolean
}) {
  const t = useTranslations("workflows.runs.status")
  const meta = STATUS_META[status]
  const Icon = meta.icon
  const animate = status === "running" ? "animate-spin" : ""
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-normal", meta.className, className)}
      data-testid={`run-status-${status}`}
    >
      {showIcon ? <Icon className={cn("size-3", animate)} aria-hidden="true" /> : null}
      {t(status)}
    </Badge>
  )
}
