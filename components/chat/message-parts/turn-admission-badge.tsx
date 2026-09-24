"use client"

/**
 * Whether the user's turn actually ran, rendered under the user's own bubble.
 *
 * Sibling of `SteerStatusBadge`, for the turn itself rather than a follow-up:
 *
 *  - **queued** — the execution broker is holding the turn until whatever owns
 *    its working tree lets go. Names that holder, and offers to withdraw the
 *    message (it goes back to the composer, like a failed steer's "put back").
 *  - **interrupted** — the row was persisted as queued but the wait did not
 *    survive (the app was closed or reloaded). The turn never ran.
 *  - **failed** — the turn was refused or died before producing anything (Pi
 *    exiting during startup, a working copy or agent process held elsewhere).
 *    Shows the diagnostic's localized label, its hint on hover, and Retry.
 *
 * Nothing renders for a message without `metadata.turnAdmission`, which is
 * every turn that ran normally.
 */

import { useTranslations } from "next-intl"
import type { UIMessage } from "ai"
import { ClockIcon, RotateCcwIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  resolveTurnAdmissionDisplay,
  turnAdmissionMetaOf,
  type TurnAdmissionWait,
} from "@/lib/chat/turn-admission"
import { cancelQueuedChatTurn, isChatTurnQueued } from "@/lib/execution/chat-lease"
import { retryChatTurn } from "@/hooks/chat/chat-send-bridge"
import { dispatchComposerAppend } from "@/components/chat/composer"
import { useChatStore, useSessionStatus } from "@/stores/chat"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"

/** Leg kinds with a noun of their own; anything else reads as "other work". */
const HOLDER_KINDS = new Set([
  "chat",
  "workflow-step",
  "scheduled",
  "connector",
  "subagent",
  "goal",
  "team",
])

export function TurnAdmissionBadge({
  message,
  sessionId,
}: {
  message: UIMessage
  sessionId: string | null
}) {
  const t = useTranslations("chat.turnAdmission")
  const tDiagnostics = useTranslations("diagnostics")
  const status = useSessionStatus(sessionId)
  // Retry re-issues the session's LAST user turn, so it is only offered on
  // that row — on an older one it would regenerate a different message.
  const isLastUserTurn = useChatStore((state) => {
    const messages = sessionId ? state.sessions[sessionId]?.messages : undefined
    if (!messages) return false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") return messages[index].id === message.id
    }
    return false
  })

  const meta = turnAdmissionMetaOf(message.metadata)
  if (!meta || !sessionId || message.role !== "user") return null

  const display = resolveTurnAdmissionDisplay(meta, { stillQueued: isChatTurnQueued(sessionId) })
  const idle = status === "idle" || status === "error"
  const canRetry = display !== "queued" && idle && isLastUserTurn

  const describeWait = (wait: TurnAdmissionWait): string => {
    if (wait.reason === "capacity") return t("waiting.capacity")
    if (wait.reason === "provider") return t("waiting.provider")
    const kind = wait.holderKind && HOLDER_KINDS.has(wait.holderKind) ? wait.holderKind : "other"
    const holder = t(`holderKind.${kind}`)
    return wait.holderLabel
      ? t("waiting.slotNamed", { holder, label: wait.holderLabel })
      : t("waiting.slot", { holder })
  }

  const failureLabel = (code: string): string => {
    const key = `code.${code}.label`
    return tDiagnostics.has(key) ? tDiagnostics(key) : t("failedGeneric")
  }
  const failureHint = (code: string): string | undefined => {
    const key = `code.${code}.hint`
    return tDiagnostics.has(key) ? tDiagnostics(key) : undefined
  }

  let text: string
  let title: string | undefined
  if (meta.state === "queued" && display === "queued") {
    text = t("queued", { reason: describeWait(meta.waitingFor) })
    title = t("queuedHint")
  } else if (display === "interrupted") {
    text = t("interrupted")
    title = t("interruptedHint")
  } else if (meta.state === "failed") {
    text = t("failed", { reason: failureLabel(meta.code) })
    title = [failureHint(meta.code), meta.detail ? t("detail", { detail: meta.detail }) : null]
      .filter(Boolean)
      .join("\n")
  } else {
    return null
  }

  const failedTone = display !== "queued"
  const Icon = failedTone ? TriangleAlertIcon : ClockIcon

  return (
    <div
      className={cn(
        "mt-1 flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-[11px]",
        failedTone ? "text-destructive" : "text-muted-foreground"
      )}
      role="status"
      data-testid="turn-admission-badge"
      data-state={display}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span title={title} data-testid="turn-admission-text">
        {text}
      </span>
      {display === "queued" && (
        <button
          type="button"
          onClick={() => {
            // Back into the composer first: withdrawing must never lose what
            // the user typed.
            dispatchComposerAppend({
              text: extractPlainText(stripPromptPreambleFromParts(message.parts)),
              sessionId,
            })
            cancelQueuedChatTurn(sessionId)
          }}
          aria-label={t("ariaCancel")}
          className="flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
          data-testid="turn-admission-cancel"
        >
          <Undo2Icon className="size-3" aria-hidden />
          {t("cancel")}
        </button>
      )}
      {canRetry && (
        <button
          type="button"
          onClick={() => retryChatTurn(sessionId)}
          aria-label={t("ariaRetry")}
          className="flex items-center gap-0.5 underline-offset-2 hover:underline"
          data-testid="turn-admission-retry"
        >
          <RotateCcwIcon className="size-3" aria-hidden />
          {t("retry")}
        </button>
      )}
    </div>
  )
}
