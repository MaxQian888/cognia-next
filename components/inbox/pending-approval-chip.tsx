"use client"

/**
 * "N pending approvals" chip for a platform conversation.
 *
 * Surfaces the HITL tool-permission cards (`lib/connectors/hitl/`) that are
 * currently waiting for an Allow/Deny press in this session, so an operator
 * scanning the header can see the AI turn is suspended on a decision. Reads
 * `usePendingApprovalCount` (registry-backed, no polling) and renders nothing
 * at 0 — an idle conversation must not carry a permanent "0 pending" badge.
 *
 * Intended mount point: `ConversationHeaderOverflow` → `groupStatus`, next to
 * `SlaBadge` / `LifecycleStatusChip`.
 */

import { useTranslations } from "next-intl"
import { InboxChip } from "./inbox-chip"
import { ShieldAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { usePendingApprovalCount } from "@/hooks/connectors/use-pending-approval-count"

export interface PendingApprovalChipProps {
  sessionId: string
  className?: string
}

export function PendingApprovalChip({ sessionId, className }: PendingApprovalChipProps) {
  const t = useTranslations("inbox.pendingApprovals")
  const count = usePendingApprovalCount(sessionId)

  if (count <= 0) return null

  return (
    <InboxChip
      role="status"
      icon={<ShieldAlertIcon className="size-3" aria-hidden />}
      className={cn("border-amber-500/40 text-amber-700 dark:text-amber-300", className)}
      data-testid="pending-approval-chip"
      dataAttributes={{ "data-count": count }}
    >
      {t("count", { count })}
    </InboxChip>
  )
}
