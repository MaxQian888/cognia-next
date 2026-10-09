"use client"

/**
 * Mobile connector draft approval panel (Wave 2.5).
 *
 * The phone's queue of every pending `ConnectorDraftRow`, as a flat divided
 * list (no cards): each row names the conversation (session title, platform
 * badge) and how long ago the bot drafted the reply (relative, in the app
 * locale), quotes the draft, and offers Edit · Reject · Approve.
 *
 * Approving SENDS a message to someone outside the app, so it is never a
 * single gesture. Swiping left reveals an Approve button; tapping it — or the
 * inline Approve — asks for confirmation with the text that will go out.
 * Rejecting (swipe right, or the inline Reject) only drops a draft, and goes
 * straight through. Edit opens the shared `DraftEditor` in a drawer, where
 * "Approve & Send" is the explicit, reviewed send.
 *
 * Writes go through `useDraftApproval`, which never throws: it toasts the
 * outcome (sent / queued for the paired host / failed) and returns it, and
 * this panel adds a haptic for success or failure. A failed approve keeps the
 * row in place for a retry. Approval also relays a `connector_approve_draft`
 * to the paired host (ADR-0131), which performs the platform send.
 *
 * Pulls live from Dexie via `useLiveQuery`. PullToRefresh sweeps expired
 * drafts (status → "expired") and refreshes the list.
 */

import { useMemo, useState } from "react"
import { CheckIcon, MessageSquareIcon, PencilIcon, XIcon } from "lucide-react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { motion, useReducedMotion } from "motion/react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Skeleton } from "@/components/ui/skeleton"
import { DraftEditor } from "@/components/inbox/draft-editor"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { SwipeRow } from "@/components/interactions/swipe-row"
import { useDraftApproval } from "@/hooks/use-draft-approval"
import { notify } from "@/lib/capacitor/haptics"
import { listAllPendingDrafts, sweepExpired } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { parseConversationKey } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { ChatSession } from "@cognia/agent-config-types"

export interface DraftApprovalPanelProps {
  className?: string
}

/** The draft's text as one line of preview; a non-text draft names its kind. */
export function summarizeDraft(row: ConnectorDraftRow): string {
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

function platformOf(conversationKey: string): PlatformKind | null {
  try {
    return parseConversationKey(conversationKey).platform
  } catch {
    return null
  }
}

/** Platform-bound session titles by conversationKey, for naming each draft. */
async function readTitlesByKey(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (typeof window === "undefined") return map
  const sessions: ChatSession[] = await getDb()
    .sessions.filter((session) => session.platformBinding != null)
    .toArray()
  for (const session of sessions) {
    const key = session.platformBinding?.conversationKey
    if (key && session.title) map.set(key, session.title)
  }
  return map
}

interface RowProps {
  row: ConnectorDraftRow
  title: string
  now: Date
  onEdit: (row: ConnectorDraftRow) => void
}

function DraftApprovalRow({ row, title, now, onEdit }: RowProps) {
  const t = useTranslations("mobile.draftApproval")
  const format = useFormatter()
  const [confirming, setConfirming] = useState(false)
  // ADR-0131: the phone used to hand-roll its own `mobileOutboundQueue` rows
  // here. The hook now routes through `lib/connectors/inbox-writes`, which
  // enqueues the same RPCs under a draft-derived idempotency key AND flips
  // the local mirror — so a retried approval can never send twice.
  const { approve, reject, busy } = useDraftApproval(row, {
    label: t("queueLabelApprove"),
    rejectLabel: t("queueLabelReject"),
  })
  const platform = platformOf(row.conversationKey)
  const summary = summarizeDraft(row)

  const confirmApprove = async () => {
    setConfirming(false)
    const outcome = await approve()
    void notify(outcome.ok ? "success" : "error")
  }
  const doReject = async () => {
    const outcome = await reject()
    void notify(outcome.ok ? "success" : "error")
  }

  return (
    <>
      <SwipeRow
        leftActions={[
          {
            id: "reject",
            label: t("reject"),
            icon: <XIcon className="size-4" />,
            destructive: true,
            onSelect: () => void doReject(),
          },
        ]}
        rightActions={[
          {
            id: "approve",
            label: t("approve"),
            icon: <CheckIcon className="size-4" />,
            className: "bg-primary text-primary-foreground hover:bg-primary/90",
            // Revealing the action is not consent: the tap asks first.
            onSelect: () => setConfirming(true),
          },
        ]}
        actionWidth={80}
      >
        <article
          className="px-4 py-3"
          aria-labelledby={`draft-title-${row.id}`}
          aria-busy={busy || undefined}
          data-testid={`draft-row-${row.id}`}
        >
          <header className="flex min-w-0 items-center gap-2">
            {platform ? (
              <span aria-hidden className="contents">
                <PlatformBadge platform={platform} iconOnly />
              </span>
            ) : null}
            <h3
              id={`draft-title-${row.id}`}
              className="min-w-0 flex-1 truncate text-sm font-medium"
              data-testid={`draft-title-${row.id}`}
            >
              {title}
            </h3>
            <time
              dateTime={new Date(row.createdAt).toISOString()}
              className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
              data-testid={`draft-time-${row.id}`}
            >
              {format.relativeTime(new Date(row.createdAt), now)}
            </time>
          </header>
          <p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap text-foreground/90">
            {summary}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onEdit(row)}
              disabled={busy}
              className="touch-target gap-1.5"
              data-testid={`draft-edit-${row.id}`}
            >
              <PencilIcon className="size-4" aria-hidden />
              {t("edit")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void doReject()}
              disabled={busy}
              className="touch-target flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              data-testid={`draft-reject-${row.id}`}
            >
              {t("reject")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={busy}
              className="touch-target flex-1"
              data-testid={`draft-approve-${row.id}`}
            >
              {t("approve")}
            </Button>
          </div>
        </article>
      </SwipeRow>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid={`draft-approve-confirm-${row.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmDescription", { name: title })}</AlertDialogDescription>
          </AlertDialogHeader>
          <blockquote className="max-h-40 overflow-y-auto border-s-2 ps-3 text-sm whitespace-pre-wrap text-foreground/90">
            {summary}
          </blockquote>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" data-testid="draft-approve-cancel">
              {t("confirmCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              onClick={() => void confirmApprove()}
              data-testid="draft-approve-confirm"
            >
              {t("confirmSend")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function DraftApprovalPanel({ className }: DraftApprovalPanelProps) {
  const t = useTranslations("mobile.draftApproval")
  // `undefined` until the first read lands. It used to collapse to `[]`, so
  // every open of the Drafts tab flashed "No drafts pending" first.
  const drafts = useLiveQuery<ConnectorDraftRow[]>(() => listAllPendingDrafts(), [])
  const titlesByKey = useLiveQuery(readTitlesByKey, [])
  const now = useNow({ updateInterval: 60_000 })
  const reduce = useReducedMotion()
  const [editing, setEditing] = useState<ConnectorDraftRow | null>(null)
  // Keep the draft on screen while the drawer slides out.
  const [editShown, setEditShown] = useState<ConnectorDraftRow | null>(null)
  if (editing && editing !== editShown) setEditShown(editing)
  // A draft approved / rejected elsewhere while its editor is open closes it.
  const editingLive = useMemo(
    () => (editing && drafts ? drafts.some((draft) => draft.id === editing.id) : true),
    [editing, drafts]
  )
  const titleOf = (conversationKey: string) => titlesByKey?.get(conversationKey) ?? conversationKey

  const onRefresh = async () => {
    await sweepExpired()
  }

  if (drafts === undefined) {
    return (
      <div
        className={cn("flex h-full flex-col divide-y", className)}
        role="status"
        aria-busy="true"
        aria-label={t("loading")}
        data-testid="draft-approval-loading"
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="space-y-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-full" />
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="ms-auto h-3 w-12" />
            </div>
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-2/3" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-11 w-16" />
              <Skeleton className="h-11 flex-1" />
              <Skeleton className="h-11 flex-1" />
            </div>
          </div>
        ))}
      </div>
    )
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
          className="flex flex-col divide-y divide-border"
          aria-label={t("listAria", { count: drafts.length })}
          initial={reduce ? false : "initial"}
          animate="animate"
          variants={STAGGER_CONTAINER}
        >
          {drafts.map((row) => (
            <motion.li key={row.id} variants={STAGGER_CHILD}>
              <DraftApprovalRow
                row={row}
                title={titleOf(row.conversationKey)}
                now={now}
                onEdit={setEditing}
              />
            </motion.li>
          ))}
        </motion.ul>
      </PullToRefresh>

      <Drawer
        open={editing !== null && editingLive}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DrawerContent
          className="flex flex-col data-[vaul-drawer-direction=bottom]:max-h-[90dvh]"
          data-testid="draft-edit-drawer"
          data-edge-swipe-ignore=""
        >
          <DrawerHeader className="gap-1 text-left md:text-left">
            <DrawerTitle className="truncate text-base">
              {editShown ? t("editTitle", { name: titleOf(editShown.conversationKey) }) : null}
            </DrawerTitle>
            <DrawerDescription>{t("editDescription")}</DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {editShown ? (
              // Keyed by draft so its edits belong to that draft only. Cancel
              // and a landed approve / reject close the drawer.
              <DraftEditor
                key={editShown.id}
                draft={editShown}
                onClose={() => setEditing(null)}
              />
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}
