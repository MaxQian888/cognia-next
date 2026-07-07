"use client"

/**
 * PR status pill for a teammate in the team workspace (ADR — team PR feedback).
 * Renders the read-time-derived PR status via the shared {@link StatusBadge}
 * under the `agentTeam.prStatus` label namespace, optionally linking to the PR.
 * Renders nothing for `none` (the teammate has no observed PR).
 */

import { ExternalLink } from "lucide-react"
import { useTranslations } from "next-intl"

import { StatusBadge } from "@/components/status-badge"
import { cn } from "@/lib/utils"
import { PR_STATUS_CONFIG, type PrDerivedStatus } from "@/types/agent/agent-team"

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

/** Map each derived status to a badge variant (AO palette: fail red, ready green). */
const PR_STATUS_VARIANTS: Record<PrDerivedStatus, BadgeVariant> = {
  none: "outline",
  pr_open: "outline",
  draft: "outline",
  ci_pending: "outline",
  ci_failed: "destructive",
  changes_requested: "outline",
  merge_conflict: "destructive",
  review_pending: "outline",
  approved: "default",
  mergeable: "default",
  merged: "secondary",
  closed: "outline",
}

export interface PrStatusBadgeProps {
  status: PrDerivedStatus
  prUrl?: string
  className?: string
}

export function PrStatusBadge({ status, prUrl, className }: PrStatusBadgeProps) {
  const t = useTranslations("agentTeam")
  if (status === "none") return null

  const badge = (
    <StatusBadge
      value={PR_STATUS_CONFIG[status].labelKey}
      labelNamespace="agentTeam.prStatus"
      variantMap={PR_STATUS_VARIANTS}
      pulse={status === "ci_pending"}
      className={cn("text-[10px]", className)}
      data-testid="pr-status-badge"
    />
  )

  if (!prUrl) return badge

  return (
    <a
      href={prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
      aria-label={t("prStatus.openPr")}
      data-testid="pr-status-link"
    >
      {badge}
      <ExternalLink aria-hidden className="size-2.5 text-muted-foreground" />
    </a>
  )
}
