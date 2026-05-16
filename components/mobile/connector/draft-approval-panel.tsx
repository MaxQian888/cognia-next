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

import { motion, useReducedMotion } from "motion/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { PullToRefresh } from "@/components/mobile/interactions/pull-to-refresh"
import { SwipeRow } from "@/components/mobile/interactions/swipe-row"
import { useDraftApproval } from "@/hooks/use-draft-approval"
import { listAllPendingDrafts, sweepExpired } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
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

interface RowProps {
  row: ConnectorDraftRow
  approveLabel: string
  rejectLabel: string
  queueLabelApprove: string
  queueLabelReject: string
}

function DraftApprovalRow({
  row,
  approveLabel,
  rejectLabel,
  queueLabelApprove,
  queueLabelReject,
}: RowProps) {
  const { approve, reject } = useDraftApproval(row, {
    beforeApprove: async () => {
      await enqueue({
        command: "connector_approve_draft",
        payload: { draftId: row.id },
        label: queueLabelApprove,
      })
    },
    beforeReject: async () => {
      await enqueue({
        command: "connector_reject_draft",
        payload: { draftId: row.id },
        label: queueLabelReject,
      })
    },
  })

  return (
    <SwipeRow
      leftActions={[
        {
          id: "reject",
          label: rejectLabel,
          icon: <XIcon className="size-4" />,
          destructive: true,
          onSelect: () => void reject(),
        },
      ]}
      rightActions={[
        {
          id: "approve",
          label: approveLabel,
          icon: <CheckIcon className="size-4" />,
          className: "bg-primary text-primary-foreground",
          onSelect: () => void approve(),
        },
      ]}
    >
      <Card
        // Compact mobile variant of shadcn Card: tighter padding + radius,
        // no shadow (SwipeRow already gives the row affordance), and
        // overrides Card's default `flex-col gap-6` so the inner content
        // composes naturally with its own gap utilities.
        className="gap-0 rounded-md border-border py-0 shadow-none"
        data-testid={`draft-row-${row.id}`}
      >
        <CardContent className="px-3 py-3">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void reject()}
              className="touch-target flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              data-testid={`draft-reject-${row.id}`}
            >
              {rejectLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void approve()}
              className="touch-target flex-1"
              data-testid={`draft-approve-${row.id}`}
            >
              {approveLabel}
            </Button>
          </div>
        </CardContent>
      </Card>
    </SwipeRow>
  )
}

export function DraftApprovalPanel({ className }: DraftApprovalPanelProps) {
  const t = useTranslations("mobile.draftApproval")
  const drafts = useLiveQuery<ConnectorDraftRow[]>(() => listAllPendingDrafts(), []) ?? []
  const reduce = useReducedMotion()

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
        <motion.ul
          className="flex flex-col gap-2 p-4"
          initial={reduce ? false : "initial"}
          animate="animate"
          variants={STAGGER_CONTAINER}
        >
          {drafts.map((row) => (
            <motion.li key={row.id} variants={STAGGER_CHILD}>
              <DraftApprovalRow
                row={row}
                approveLabel={t("approve")}
                rejectLabel={t("reject")}
                queueLabelApprove={t("queueLabelApprove")}
                queueLabelReject={t("queueLabelReject")}
              />
            </motion.li>
          ))}
        </motion.ul>
      </PullToRefresh>
    </div>
  )
}
