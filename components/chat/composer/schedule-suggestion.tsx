"use client"

/**
 * "Turn this into a scheduled task?" — the missing consumer for the chat
 * intent classifier.
 *
 * `lib/scheduler/conversational-task-intent.ts` has been able to read
 * "每天早上提醒我看 PR" / "remind me every morning to triage PRs" out of a
 * composer line since the scheduler landed, and
 * `conversational-task-authoring.ts` turns that into a real
 * `CreateScheduledTaskInput`. ADR-0002 §6 describes the intended flow —
 * "intent-classifier flows can produce a partial draft for the user to finish
 * in the form" — but nothing ever called the classifier, so both modules were
 * unreachable.
 *
 * Design rules this row follows, because a proactive suggestion that gets them
 * wrong is worse than no suggestion:
 *
 *   - **Never intercepts the turn.** Enter still sends the message. This is one
 *     quiet row with one button; the scheduler is a detour the user chooses.
 *   - **Dismissible, and stays dismissed** for the text that produced it, so
 *     editing around a false positive does not make it flicker back.
 *   - **Debounced**, so the classifier does not run on every keystroke.
 *   - Only ever a draft: `detectConversationalSchedulerDraft` defaults to a
 *     daily 09:00 cron, which is a starting point, not a guess at the user's
 *     real cadence. The form is where it gets finished.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { CalendarClock, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import type { ConversationalTaskDraft } from "@/lib/scheduler/conversational-task-authoring"
import { detectConversationalSchedulerDraft } from "@/lib/scheduler/conversational-task-intent"
import { stageScheduledTaskDraft } from "@/lib/scheduler/task-draft-handoff"

/** Shortest line worth classifying — "每天" alone is not an intent. */
export const MIN_SUGGESTION_LENGTH = 8

/** Quiet period after the last keystroke before the classifier runs. */
export const SUGGESTION_DEBOUNCE_MS = 500

/**
 * How many dismissals to remember.
 *
 * Bounded on purpose: the entries are whole composer drafts (paragraphs, in a
 * long message), and an unbounded set kept one per dismissal for the life of
 * the pane. The behaviour this exists for — "editing around a false positive
 * does not make it flicker back" — only ever needs the recent few, because the
 * only value ever looked up is the one currently on screen.
 */
export const DISMISS_MEMORY = 8

export interface ScheduleSuggestionProps {
  /** Live composer text. */
  value: string
  /** Session the draft should bind to, when there is one. */
  sessionId?: string
  /**
   * Chat mode, used only to bias the draft toward an `agent` or a `chat` task.
   * Anything the classifier does not know is treated as `chat`.
   */
  mode?: "chat" | "agent" | "research" | "learning" | "plan"
  className?: string
  /** Test seam: skip the debounce timer. */
  debounceMs?: number
}

export function ScheduleSuggestion({
  value,
  sessionId,
  mode = "chat",
  className,
  debounceMs = SUGGESTION_DEBOUNCE_MS,
}: ScheduleSuggestionProps) {
  const t = useTranslations("chat.composer.scheduleSuggestion")
  const router = useRouter()
  const trimmed = value.trim()
  const [settledValue, setSettledValue] = useState("")
  // Dismissals are keyed by the text that produced them, so backspacing one
  // character does not resurrect a suggestion the user just waved away. State,
  // not a ref: the render below reads it. Newest first and capped at
  // {@link DISMISS_MEMORY} — see that constant for why it is bounded.
  const [dismissed, setDismissed] = useState<readonly string[]>([])
  const dismiss = useCallback((text: string) => {
    setDismissed((prev) => [text, ...prev.filter((seen) => seen !== text)].slice(0, DISMISS_MEMORY))
  }, [])

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
    } catch {
      return undefined
    }
  }, [])

  useEffect(() => {
    if (trimmed.length < MIN_SUGGESTION_LENGTH) return
    const timer = setTimeout(() => setSettledValue(trimmed), debounceMs)
    return () => clearTimeout(timer)
  }, [trimmed, debounceMs])

  const draft: ConversationalTaskDraft | null = useMemo(() => {
    // The settled value is only trusted while it still matches what is on
    // screen. That single guard is what makes the row vanish the instant the
    // line changes and reappear once typing settles — no clearing effect, and
    // no stale suggestion for text the user already edited away.
    if (!settledValue || settledValue !== trimmed) return null
    if (trimmed.length < MIN_SUGGESTION_LENGTH) return null
    // A slash command, a bare mention, or a shell line is being composed for
    // something else entirely — never read those as scheduling intent.
    if (/^[/!#@]/.test(settledValue)) return null
    if (dismissed.includes(settledValue)) return null
    return detectConversationalSchedulerDraft(settledValue, {
      mode,
      sessionId,
      timezone,
    })
  }, [settledValue, trimmed, dismissed, mode, sessionId, timezone])

  if (!draft) return null

  return (
    <Surface
      layer="raised"
      radius="control"
      className={cn(
        "mt-1 flex items-center gap-2 border border-dashed px-2.5 py-1.5 text-xs",
        className
      )}
      data-testid="composer-schedule-suggestion"
      role="status"
    >
      <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{t("prompt")}</span>
      <Button
        type="button"
        size="xs"
        variant="secondary"
        className="h-6 shrink-0 px-2 text-[11px]"
        data-testid="composer-schedule-suggestion-accept"
        onClick={() => {
          stageScheduledTaskDraft(draft.input, { summary: draft.summary })
          // Dismiss too: coming back to this conversation should not re-offer
          // a schedule the user has already gone off to create.
          dismiss(settledValue)
          router.push("/scheduler")
        }}
      >
        {t("accept")}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label={t("dismiss")}
        data-testid="composer-schedule-suggestion-dismiss"
        onClick={() => dismiss(settledValue)}
      >
        <X className="size-3" aria-hidden="true" />
      </Button>
    </Surface>
  )
}
