"use client"

/**
 * Delivery state of a follow-up the user typed while a turn was still running
 * ("steer"), rendered under its own bubble.
 *
 * The bubble is the single home for a steer: the run panel only reports how
 * many are still pending, so reading, editing, and removing all happen here.
 *
 * Nothing renders once the message is `applied` — at that point it is an
 * ordinary part of the conversation and a permanent badge would just be noise
 * on every historical follow-up. The badge leaving IS the "it landed" signal,
 * which is why it exits through `AnimatePresence` rather than disappearing.
 *
 * Motion is opacity/scale only. These bubbles live inside the virtualized
 * message list (`message-list.tsx`), where a height change mid-animation feeds
 * the per-row `ResizeObserver` back into the virtualizer and jitters the
 * scroll position.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import type { UIMessage } from "ai"
import { CheckIcon, ClockIcon, PencilIcon, TriangleAlertIcon, Undo2Icon, XIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { resolveSteerDisplayState, steerMetaOf, stripSteerPrefix } from "@/lib/claude/steer"
import { discardPendingSteer, editPendingSteer } from "@/hooks/chat/steer-runtime"
import { dispatchComposerAppend } from "@/components/chat/composer"
import { useSessionStatus, useSessionSteerQueue } from "@/stores/chat"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"

export function SteerStatusBadge({
  message,
  sessionId,
}: {
  message: UIMessage
  sessionId: string | null
}) {
  const t = useTranslations("chat.steer")
  const status = useSessionStatus(sessionId)
  const steerQueue = useSessionSteerQueue(sessionId)
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  const [draft, setDraft] = useState<string | null>(null)

  const meta = steerMetaOf(message.metadata)
  if (!meta || !sessionId) return null

  const state = resolveSteerDisplayState(meta, {
    sessionBusy: status === "streaming" || status === "awaiting_approval",
    stillQueued: steerQueue.some((entry) => entry.id === meta.entryId),
  })
  // Delivered and folded into the conversation — nothing left to say.
  if (state === "applied") return null

  const pending = state === "queued"

  const commitEdit = () => {
    const next = (draft ?? "").trim()
    setDraft(null)
    if (!next) discardPendingSteer(sessionId, meta.entryId)
    else editPendingSteer(sessionId, meta.entryId, next)
  }

  if (draft !== null) {
    return (
      <div className="mt-1 flex w-full justify-end">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commitEdit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              setDraft(null)
            }
          }}
          aria-label={t("ariaEdit")}
          className="h-7 max-w-[min(82%,42rem)] text-[12px]"
          data-testid="steer-edit-input"
        />
      </div>
    )
  }

  const tone =
    state === "failed"
      ? "text-destructive"
      : state === "accepted"
        ? "text-emerald-600 dark:text-emerald-500"
        : "text-muted-foreground"
  const Icon = state === "failed" ? TriangleAlertIcon : state === "accepted" ? CheckIcon : ClockIcon

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={state}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }}
        transition={transition}
        className={cn("group/steer mt-1 flex items-center justify-end gap-1 text-[11px]", tone)}
        data-testid="steer-status-badge"
        data-state={state}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span title={state === "failed" ? (meta.reason ?? t("failedHint")) : t(`${state}Hint`)}>
          {t(state)}
        </span>

        {pending && (
          <>
            <button
              type="button"
              onClick={() => setDraft(stripSteerPrefix(extractPlainText(message.parts)))}
              aria-label={t("ariaEdit")}
              className="opacity-0 transition-opacity hover:text-foreground group-hover/steer:opacity-100 focus-visible:opacity-100"
            >
              <PencilIcon className="size-3" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => discardPendingSteer(sessionId, meta.entryId)}
              aria-label={t("ariaRemove")}
              className="opacity-0 transition-opacity hover:text-foreground group-hover/steer:opacity-100 focus-visible:opacity-100"
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </>
        )}

        {state === "failed" && (
          <>
            {/* Put it back in the composer rather than re-sending silently: the
                run this was meant to steer is over, so the user should decide
                whether it still applies before it costs another turn. */}
            <button
              type="button"
              onClick={() => {
                dispatchComposerAppend({
                  text: stripSteerPrefix(extractPlainText(message.parts)),
                  sessionId,
                })
                discardPendingSteer(sessionId, meta.entryId)
              }}
              aria-label={t("ariaPutBack")}
              className="flex items-center gap-0.5 underline-offset-2 hover:underline"
              data-testid="steer-put-back"
            >
              <Undo2Icon className="size-3" aria-hidden />
              {t("putBack")}
            </button>
            <button
              type="button"
              onClick={() => discardPendingSteer(sessionId, meta.entryId)}
              aria-label={t("ariaRemove")}
              className="underline-offset-2 hover:underline"
            >
              {t("discard")}
            </button>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
