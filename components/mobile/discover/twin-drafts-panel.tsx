"use client"

/**
 * Mobile Twin Drafts panel (Wave 3.2).
 *
 * Lists every pending TwinDraft (newest-first) and lets the user accept /
 * reject each one with swipe gestures or explicit buttons. Accepting
 * persists the embedded character / skill via the existing CRUD helpers
 * AND marks the draft accepted (`markTwinDraftAccepted`); rejecting
 * marks `rejected`. Both also enqueue an outbound mirror so the desktop
 * twin runtime can record the decision.
 */

import { CheckIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { SwipeRow } from "@/components/interactions/swipe-row"
import { TwinDraftCard } from "@/components/mobile/discover/twin-draft-card"
import { createCharacter } from "@/lib/db/characters"
import { createSkill } from "@/lib/db/skills"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import {
  listTwinDraftsByTwinAndStatus,
  markTwinDraftAccepted,
  markTwinDraftRejected,
} from "@/lib/db/twin-drafts"
import { getDb } from "@/lib/db/schema"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import type { TwinDraft } from "@/types/twin"
import { cn } from "@/lib/utils"

export interface TwinDraftsPanelProps {
  twinId?: string
  className?: string
}

async function listAllPending(): Promise<TwinDraft[]> {
  const rows = await getDb().twinDrafts.where("status").equals("pending").toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows as TwinDraft[]
}

function dataAs<T extends Record<string, unknown>>(draft: TwinDraft): T {
  return draft.payload.data as T
}

export function TwinDraftsPanel({ twinId, className }: TwinDraftsPanelProps) {
  const t = useTranslations("mobile.twinDraftActions")
  const reduce = useReducedMotion()
  const drafts =
    useLiveQuery<TwinDraft[]>(
      () =>
        twinId
          ? (listTwinDraftsByTwinAndStatus(twinId, "pending") as Promise<TwinDraft[]>)
          : (listAllPending() as Promise<TwinDraft[]>),
      [twinId]
    ) ?? []

  const onAccept = async (draft: TwinDraft) => {
    let acceptedAsId: string
    if (draft.kind === "character") {
      const data = dataAs<{
        name: string
        description?: string
        avatarColor?: string
        avatarEmoji?: string
        systemPrompt?: string
      }>(draft)
      const ch = await createCharacter({
        name: data.name ?? "Twin character",
        description: data.description ?? "",
        avatarColor: data.avatarColor ?? "oklch(0.6 0.1 240)",
        avatarEmoji: data.avatarEmoji,
        systemPrompt: data.systemPrompt ?? "",
      } as never)
      acceptedAsId = ch.id
    } else {
      const data = dataAs<{ name: string; description?: string; content?: string }>(draft)
      const sk = await createSkill({
        name: data.name ?? "Twin skill",
        description: data.description ?? "",
        content: data.content ?? "",
      } as never)
      acceptedAsId = sk.id
    }
    await markTwinDraftAccepted(draft.id, acceptedAsId)
    await enqueue({
      command: "twin_ingest_source",
      payload: { kind: "twin_draft_accept", draftId: draft.id, acceptedAsId },
      label: t("queueAcceptLabel"),
    })
    toast.success(t("accepted", { kind: draft.kind }))
  }

  const onReject = async (draft: TwinDraft) => {
    await markTwinDraftRejected(draft.id)
    await enqueue({
      command: "twin_ingest_source",
      payload: { kind: "twin_draft_reject", draftId: draft.id },
      label: t("queueRejectLabel"),
    })
    toast.info(t("rejected"))
  }

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="twin-drafts-panel">
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
                leftActions={[
                  {
                    id: "reject",
                    label: t("reject"),
                    icon: <XIcon className="size-4" />,
                    destructive: true,
                    onSelect: () => void onReject(d),
                  },
                ]}
                rightActions={[
                  {
                    id: "accept",
                    label: t("accept"),
                    icon: <CheckIcon className="size-4" />,
                    className: "bg-primary text-primary-foreground",
                    onSelect: () => void onAccept(d),
                  },
                ]}
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
