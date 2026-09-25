"use client"

/**
 * What the outbound queue is holding, and the way to take something back.
 *
 * The offline banner counted queued actions ("1 queued") and nothing else:
 * there was no surface that listed them, so a workflow run tapped by mistake
 * while the Host was away could only wait to fire. The row type has carried a
 * human `label` "rendered in the queue UI" all along; this is that UI.
 *
 * What each row offers follows what is safe for it:
 *   - pending, standalone (a workflow trigger, an approval): Withdraw. The
 *     data layer re-checks inside a transaction, so a runner that claims it
 *     first wins and the user is told it is already on its way.
 *   - pending in a conversation channel: nothing — its optimistic copy is on
 *     screen in order, and dropping it would strand that copy.
 *   - sending: nothing; the Host may already have it.
 *   - dead-lettered: Retry (same idempotency key) or Discard.
 *   - rejected: Discard. Conflicted (collab): Discard, as the Issues conflict
 *     panel does.
 */

import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { useClientLiveQuery } from "@/hooks/data"
import {
  deleteRow,
  discardCollabConflict,
  listByStatus,
  retryDeadletter,
  withdrawPending,
} from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow, MobileOutboundStatus } from "@/lib/db/mobile-outbound-types"

/** Everything the user can still see or act on; `sent` rows are history. */
export const QUEUE_SHEET_STATUSES: readonly MobileOutboundStatus[] = [
  "pending",
  "sending",
  "deadlettered",
  "rejected",
  "conflicted",
]

type QueueRowStatus = "pending" | "sending" | "deadlettered" | "rejected" | "conflicted"

export interface OutboundQueueSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OutboundQueueSheet({ open, onOpenChange }: OutboundQueueSheetProps) {
  const t = useTranslations("mobile.offline.queueSheet")
  const rows = useClientLiveQuery<MobileOutboundJobRow[]>(
    async () => {
      if (!open) return []
      const lists = await Promise.all(QUEUE_SHEET_STATUSES.map((status) => listByStatus(status)))
      return lists.flat().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    },
    [open],
    []
  )

  const run = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work()
      if (done) toast.success(done)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const withdraw = async (row: MobileOutboundJobRow) => {
    try {
      const withdrawn = await withdrawPending(row.id)
      if (withdrawn) toast.success(t("withdrawn"))
      else toast.message(t("tooLate"))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[80vh] gap-0 overflow-y-auto p-0"
        data-testid="outbound-queue-sheet"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-left">{t("title")}</SheetTitle>
          <SheetDescription className="text-left">{t("description")}</SheetDescription>
        </SheetHeader>
        {(rows ?? []).length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground" data-testid="outbound-queue-empty">
            {t("empty")}
          </p>
        ) : (
          <ul className="divide-y">
            {(rows ?? []).map((row) => (
              <QueueRow
                key={row.id}
                row={row}
                onWithdraw={() => void withdraw(row)}
                onRetry={() => void run(() => retryDeadletter(row.id), t("retrying"))}
                onDiscard={() =>
                  void run(
                    () =>
                      row.status === "conflicted"
                        ? discardCollabConflict(row.id)
                        : deleteRow(row.id),
                    t("discarded")
                  )
                }
              />
            ))}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  )
}

function QueueRow({
  row,
  onWithdraw,
  onRetry,
  onDiscard,
}: {
  row: MobileOutboundJobRow
  onWithdraw: () => void
  onRetry: () => void
  onDiscard: () => void
}) {
  const t = useTranslations("mobile.offline.queueSheet")
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  const status = row.status as QueueRowStatus
  const withdrawable = status === "pending" && !row.channel

  return (
    <li
      className="flex items-start gap-3 px-4 py-3"
      data-testid={`outbound-queue-row-${row.id}`}
      data-status={status}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.label?.trim() || t("unlabeled")}</p>
        <p className="text-xs text-muted-foreground">
          {t(`status.${status}`)} · {format.relativeTime(new Date(row.createdAt), now)}
        </p>
        {status === "pending" && row.channel ? (
          <p className="text-xs text-muted-foreground">{t("inOrder")}</p>
        ) : null}
        {(status === "deadlettered" || status === "rejected") && row.lastError ? (
          <p className="line-clamp-2 text-xs text-destructive">{row.lastError}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {withdrawable ? (
          <Button size="sm" variant="outline" onClick={onWithdraw}>
            {t("withdraw")}
          </Button>
        ) : null}
        {status === "deadlettered" ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("retry")}
          </Button>
        ) : null}
        {status === "deadlettered" || status === "rejected" || status === "conflicted" ? (
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            {t("discard")}
          </Button>
        ) : null}
      </div>
    </li>
  )
}
