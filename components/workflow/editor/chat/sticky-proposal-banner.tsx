"use client"

/**
 * StickyProposalBanner — top-of-chat-pane strip that surfaces the
 * currently OPEN proposal so the Apply / Discard / Reveal-in-chat
 * actions are always reachable regardless of how far the user has
 * scrolled.
 *
 * Reuses `useProposalStore` keyed by the workflow id; the proposal
 * card in the chat stream renders independently and stays the source
 * of detailed op-by-op review. This banner is the lightweight pinned
 * surface for Apply / Discard only.
 *
 * Toasts: emits Sonner notifications on Apply / Discard transitions
 * so background work (e.g., the agent fires Apply via a tool path,
 * not through this UI) still surfaces to the user.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, XIcon, ZapIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useProposalStore, type ProposalPayload } from "@/lib/workflow/editor/proposal-store"
import { getEditorStore } from "@/lib/workflow/editor/store-registry"

export interface StickyProposalBannerProps {
  workflowId: string
  /** Optional callback for the "reveal in chat" button. The banner stays
   *  agnostic about HOW to scroll to the card — the chat tab passes
   *  a scroll handler that knows the message list. */
  onRevealInChat?: (proposalId: string) => void
  className?: string
}

export function StickyProposalBanner({
  workflowId,
  onRevealInChat,
  className,
}: StickyProposalBannerProps) {
  const t = useTranslations("workflowEditor.chat.proposal")
  const entry = useProposalStore((s) => s.entries[workflowId])
  const open = entry?.open
  // Track last-seen proposal ids so we only toast on transitions, not on
  // initial mount. Sonner is idempotent on duplicates but firing a toast
  // every render would still spam.
  const seenOpenRef = useRef<string | null>(null)
  const seenAppliedRef = useRef<string | null>(null)
  const seenDiscardedRef = useRef<string | null>(null)

  useEffect(() => {
    const openId = open?.proposalId ?? null
    if (openId && openId !== seenOpenRef.current) {
      seenOpenRef.current = openId
      toast.info(t("toast.proposed", { summary: open?.summary ?? "" }))
    }
    if (!openId) {
      seenOpenRef.current = null
    }
  }, [open?.proposalId, open?.summary, t])

  useEffect(() => {
    const appliedId = entry?.lastApplied?.proposalId ?? null
    if (appliedId && appliedId !== seenAppliedRef.current) {
      seenAppliedRef.current = appliedId
      toast.success(t("toast.applied", { summary: entry?.lastApplied?.summary ?? "" }))
    }
  }, [entry?.lastApplied?.proposalId, entry?.lastApplied?.summary, t])

  useEffect(() => {
    const discardedId = entry?.lastDiscarded?.proposalId ?? null
    if (discardedId && discardedId !== seenDiscardedRef.current) {
      seenDiscardedRef.current = discardedId
      toast.message(t("toast.discarded", { summary: entry?.lastDiscarded?.summary ?? "" }))
    }
  }, [entry?.lastDiscarded?.proposalId, entry?.lastDiscarded?.summary, t])

  if (!open) return null

  return (
    <div
      data-testid="workflow-proposal-banner"
      data-proposal-id={open.proposalId}
      className={cn(
        "sticky top-0 z-10 flex items-center gap-2 border-b bg-amber-50 px-3 py-1.5 text-xs",
        "dark:bg-amber-950/30",
        className
      )}
    >
      <ZapIcon
        className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate" title={open.summary}>
        {open.summary}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {t("banner.ops", { count: open.ops.length })}
      </span>
      {onRevealInChat ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => onRevealInChat(open.proposalId)}
          data-testid="workflow-proposal-banner-reveal"
        >
          {t("banner.revealInChat")}
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 gap-1 px-2 text-[11px] text-destructive hover:text-destructive"
        onClick={() => discardOpen(workflowId)}
        data-testid="workflow-proposal-banner-discard"
      >
        <XIcon className="size-3" aria-hidden="true" />
        {t("banner.discard")}
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={() => void applyOpen(workflowId, open)}
        data-testid="workflow-proposal-banner-apply"
      >
        <CheckIcon className="size-3" aria-hidden="true" />
        {t("banner.applyAll")}
      </Button>
    </div>
  )
}

function discardOpen(workflowId: string): void {
  useProposalStore.getState().discardProposal(workflowId)
}

async function applyOpen(workflowId: string, open: ProposalPayload): Promise<void> {
  const store = getEditorStore(workflowId)
  if (!store) {
    toast.error("Editor is not open — cannot apply proposal.")
    return
  }
  const result = store.getState().applyProposalOps(open.ops)
  if (result.firstError) {
    toast.error(result.firstError)
    return
  }
  useProposalStore.getState().markApplied(workflowId)
}
