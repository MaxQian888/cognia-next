"use client"

/**
 * Shared step-status glyph for plan surfaces (approval card, tracker panel,
 * document view). Kept in its own module so the document surface does not
 * depend on the approval card — the card renders PlanDocument, so importing
 * the icon from it would create a module cycle.
 */

import { CheckCircle2Icon, CircleIcon, ClockIcon, MinusCircleIcon, XCircleIcon } from "lucide-react"
import type { PlanStepStatus } from "@/types/agent/plan"

export function stepStatusIcon(status: PlanStepStatus) {
  switch (status) {
    case "completed":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-green-600" />
    case "in_progress":
      return <ClockIcon className="size-3.5 shrink-0 animate-pulse text-yellow-600" />
    case "failed":
    case "blocked":
      return <XCircleIcon className="size-3.5 shrink-0 text-rose-600" />
    case "skipped":
      return <MinusCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
    default:
      return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
  }
}
