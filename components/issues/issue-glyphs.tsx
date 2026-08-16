"use client"

/**
 * Status and priority glyphs for the issue tracker.
 *
 * Kept in one module so the board, the list, the detail inspector and the IM
 * card projection cannot drift into three different visual vocabularies for
 * the same six statuses. Colour lives here too (as Tailwind text classes on
 * theme tokens, so both themes stay legible) rather than at each call site.
 */

import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleDotDashedIcon,
  MinusIcon,
  SignalHighIcon,
  SignalLowIcon,
  SignalMediumIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react"

import type { IssuePriority, IssueStatus } from "@/types/issues"
import { cn } from "@/lib/utils"

const STATUS_ICON: Record<IssueStatus, LucideIcon> = {
  backlog: CircleDashedIcon,
  todo: CircleIcon,
  in_progress: CircleDotIcon,
  in_review: CircleDotDashedIcon,
  done: CircleCheckIcon,
  canceled: CircleSlashIcon,
}

/** Tailwind text colour per status. Tokens, not raw hex, so dark mode holds. */
const STATUS_COLOR: Record<IssueStatus, string> = {
  backlog: "text-muted-foreground",
  todo: "text-foreground/70",
  in_progress: "text-amber-500",
  in_review: "text-emerald-500",
  done: "text-blue-500",
  canceled: "text-muted-foreground/60",
}

/** Soft column tint mirroring the board's grouped background. */
export const STATUS_COLUMN_TINT: Record<IssueStatus, string> = {
  backlog: "bg-muted/30",
  todo: "bg-muted/20",
  in_progress: "bg-amber-500/5",
  in_review: "bg-emerald-500/5",
  done: "bg-blue-500/5",
  canceled: "bg-muted/20",
}

export interface IssueStatusIconProps {
  status: IssueStatus
  className?: string
}

export function IssueStatusIcon({ status, className }: IssueStatusIconProps) {
  const Icon = STATUS_ICON[status]
  return (
    <Icon
      aria-hidden
      className={cn("size-4 shrink-0", STATUS_COLOR[status], className)}
      data-testid={`issue-status-icon-${status}`}
    />
  )
}

const PRIORITY_ICON: Record<IssuePriority, LucideIcon> = {
  urgent: TriangleAlertIcon,
  high: SignalHighIcon,
  medium: SignalMediumIcon,
  low: SignalLowIcon,
  none: MinusIcon,
}

const PRIORITY_COLOR: Record<IssuePriority, string> = {
  urgent: "text-red-500",
  high: "text-foreground/80",
  medium: "text-foreground/70",
  low: "text-muted-foreground",
  none: "text-muted-foreground/60",
}

export interface IssuePriorityIconProps {
  priority: IssuePriority
  className?: string
}

export function IssuePriorityIcon({ priority, className }: IssuePriorityIconProps) {
  const Icon = PRIORITY_ICON[priority]
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", PRIORITY_COLOR[priority], className)}
      data-testid={`issue-priority-icon-${priority}`}
    />
  )
}
