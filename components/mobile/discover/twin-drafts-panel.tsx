"use client"

/**
 * Mobile Twin Drafts panel (Wave 3.2).
 *
 * Lists pending drafts for the selected Twin and queues review commands.
 * The desktop owns the idempotent Character / Skill creation, playbook
 * promotion, and final draft-status update.
 */

import { CheckIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { SwipeRow } from "@/components/interactions/swipe-row"
import { TwinDraftCard } from "@/components/mobile/discover/twin-draft-card"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { listTwinDraftsByTwinAndStatus } from "@/lib/db/twin-drafts"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import type { TwinDraft } from "@/types/twin"
import { cn } from "@/lib/utils"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"

export interface TwinDraftsPanelProps {
  twinId: string
  className?: string
}

export function TwinDraftsPanel({ twinId, className }: TwinDraftsPanelProps) {
  const t = useTranslations("mobile.twinDraftActions")
  const reduce = useReducedMotion()
  const runtimeSnapshot = useRuntimeSnapshot()
  const supportsDraftReview =
    runtimeSnapshot.target === null ||
    runtimeSnapshot.host?.operations.includes("twin_draft_review") === true
  const drafts =
    useLiveQuery<TwinDraft[]>(
      () => listTwinDraftsByTwinAndStatus(twinId, "pending") as Promise<TwinDraft[]>,
      [twinId]
    ) ?? []

  const onAccept = async (draft: TwinDraft) => {
    await enqueue({
      command: "twin_draft_review",
      payload: { twinId, draftId: draft.id, action: "accept" },
      label: t("queueAcceptLabel"),
    })
    toast.success(t("accepted", { kind: draft.kind }))
  }

  const onReject = async (draft: TwinDraft) => {
    await enqueue({
      command: "twin_draft_review",
      payload: { twinId, draftId: draft.id, action: "reject" },
      label: t("queueRejectLabel"),
    })
    toast.info(t("rejected"))
  }

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="twin-drafts-panel">
      {!supportsDraftReview && drafts.length > 0 ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("upgradeRequired")}
        </p>
      ) : null}
      {drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{/* delegated to caller's empty state */}</p>
      ) : (
        <motion.ul
          className="flex flex-col gap-2"
          initial={reduce ? false : "initial"}
          animate="animate"
          variants={STAGGER_CONTAINER}
        >
          {drafts.map((d) => (
            <motion.li key={d.id} variants={STAGGER_CHILD}>
              <SwipeRow
                leftActions={
                  supportsDraftReview
                    ? [
                        {
                          id: "reject",
                          label: t("reject"),
                          icon: <XIcon className="size-4" />,
                          destructive: true,
                          onSelect: () => void onReject(d),
                        },
                      ]
                    : []
                }
                rightActions={
                  supportsDraftReview
                    ? [
                        {
                          id: "accept",
                          label: t("accept"),
                          icon: <CheckIcon className="size-4" />,
                          className: "bg-primary text-primary-foreground",
                          onSelect: () => void onAccept(d),
                        },
                      ]
                    : []
                }
              >
                <TwinDraftCard draft={d} />
              </SwipeRow>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  )
}
