"use client"

/**
 * The inspector's triage row (`Issue.triage`).
 *
 * An issue in triage carries a proposal nobody accepted yet, so derived runs
 * (IM, wakeups) refuse it until a person does; this row is where they do.
 * Accepting and sending back are `IssueBulkAction`s like every other edit,
 * so the capability gate and the trail entry are the board's own.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { IssueBulkAction } from "@/lib/issues/bulk-actions"
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface IssueTriageRowProps {
  item: Pick<UnifiedIssueItem, "kind" | "triage" | "capabilities">
  onAction?: (action: IssueBulkAction) => void
}

export function IssueTriageRow({ item, onAction }: IssueTriageRowProps) {
  const t = useTranslations("issues")
  const editable = Boolean(onAction) && item.kind === "local" && item.capabilities.canEdit
  const pending = item.triage === "pending"

  if (pending) {
    return (
      <div
        className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5"
        data-testid="issue-detail-triage"
      >
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
            {t("triage.badge")}
          </Badge>
          <span className="text-xs text-muted-foreground">{t("triage.pendingHint")}</span>
        </div>
        {editable ? (
          <Button
            size="sm"
            className="self-start"
            onClick={() => onAction?.({ kind: "triage", to: null })}
            data-testid="issue-detail-triage-accept"
          >
            {t("triage.accept")}
          </Button>
        ) : null}
      </div>
    )
  }

  if (!editable) return null
  return (
    <Button
      size="sm"
      variant="ghost"
      className="self-start text-xs text-muted-foreground"
      onClick={() => onAction?.({ kind: "triage", to: "pending" })}
      data-testid="issue-detail-triage-send"
    >
      {t("triage.send")}
    </Button>
  )
}
