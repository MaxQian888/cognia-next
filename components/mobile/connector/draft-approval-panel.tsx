"use client"

/**
 * Mobile connector draft approval panel (Wave 2.5).
 *
 * Lists all pending `ConnectorDraftRow`s and lets the user approve / reject
 * each by swiping the row left (approve) or right (reject), or by tapping
 * the explicit buttons inside the swiped panel. Approval also enqueues a
 * `connector_approve_draft` outbound job so the desktop server fires the
 * actual platform send when it next receives the RPC.
 *
 * Pulls live from Dexie via `useLiveQuery`. PullToRefresh sweeps expired
 * drafts (status → "expired") and refreshes the list.
 */

import { CheckIcon, MessageSquareIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Badge } from "@/components/ui/badge"
import { PullToRefresh } from "@/components/mobile/interactions/pull-to-refresh"
import { SwipeRow } from "@/components/mobile/interactions/swipe-row"
import {
  approveDraft,
  listAllPendingDrafts,
  rejectDraft,
  sweepExpired,
} from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { cn } from "@/lib/utils"

export interface DraftApprovalPanelProps {
  className?: string
}

function summarize(row: ConnectorDraftRow): string {
  for (const seg of row.segments) {
    if (seg.type === "text" && seg.text.trim().length > 0) {
      return seg.text
    }
    if (seg.type === "markdown" && seg.md.trim().length > 0) {
      return seg.md
    }
  }
  const first = row.segments[0]
  if (!first) return ""
  return `[${first.type}]`
}

export function DraftApprovalPanel({ className }: DraftApprovalPanelProps) {
  const t = useTranslations("mobile.draftApproval")
  const drafts = useLiveQuery<ConnectorDraftRow[]>(() => listAllPendingDrafts(), []) ?? []

  const onApprove = async (row: ConnectorDraftRow) => {
    await approveDraft(row.id)
    await enqueue({
      command: "connector_approve_draft",
      payload: { draftId: row.id },
      label: t("queueLabelApprove"),
    })
  }

  const onReject = async (row: ConnectorDraftRow) => {
    await rejectDraft(row.id)
    await enqueue({
      command: "connector_reject_draft",
      payload: { draftId: row.id },
      label: t("queueLabelReject"),
    })
  }

  const onRefresh = async () => {
    await sweepExpired()
  }

  if (drafts.length === 0) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2 px-6 text-center",
          className
        )}
        data-testid="draft-approval-empty"
      >
        <MessageSquareIcon className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    )
  }

  return (
    <div className={cn("h-full", className)} data-testid="draft-approval-panel">
      <PullToRefresh onRefresh={onRefresh} silent={false}>
        <ul className="flex flex-col gap-2 p-4">
          {drafts.map((row) => (
            <li key={row.id}>
              <SwipeRow
                leftActions={[
                  {
                    id: "reject",
                    label: t("reject"),
                    icon: <XIcon className="size-4" />,
                    destructive: true,
                    onSelect: () => void onReject(row),
                  },
                ]}
                rightActions={[
                  {
                    id: "approve",
                    label: t("approve"),
                    icon: <CheckIcon className="size-4" />,
                    className: "bg-emerald-600 text-white",
                    onSelect: () => void onApprove(row),
                  },
                ]}
              >
                <div
                  className="rounded-md border border-border bg-card p-3"
                  data-testid={`draft-row-${row.id}`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {row.conversationKey}
                    </Badge>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {new Date(row.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 text-sm">{summarize(row)}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void onReject(row)}
                      className="touch-target flex-1 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive"
                      data-testid={`draft-reject-${row.id}`}
                    >
                      {t("reject")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onApprove(row)}
                      className="touch-target flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white"
                      data-testid={`draft-approve-${row.id}`}
                    >
                      {t("approve")}
                    </button>
                  </div>
                </div>
              </SwipeRow>
            </li>
          ))}
        </ul>
      </PullToRefresh>
    </div>
  )
}
