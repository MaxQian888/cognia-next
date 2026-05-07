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
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { RunStatus } from "@/types/workflow/visual"

const STATUS_META: Record<
  RunStatus,
  { className: string; icon: typeof CheckCircle2Icon; label: string }
> = {
  pending: {
    className: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/40",
    icon: CircleDashedIcon,
    label: "Pending",
  },
  running: {
    className: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
    icon: LoaderIcon,
    label: "Running",
  },
  waiting: {
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
    icon: PlayCircleIcon,
    label: "Waiting",
  },
  paused: {
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
    icon: PauseCircleIcon,
    label: "Paused",
  },
  succeeded: {
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
    icon: CheckCircle2Icon,
    label: "Succeeded",
  },
  failed: {
    className: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40",
    icon: CircleAlertIcon,
    label: "Failed",
  },
  cancelled: {
    className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/40",
    icon: CircleSlashIcon,
    label: "Cancelled",
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
      {meta.label}
    </Badge>
  )
}
