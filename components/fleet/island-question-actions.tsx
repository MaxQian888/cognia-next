"use client"

/**
 * IslandQuestionActions — the answerable AskUserQuestion card. Renders each
 * parked question with selectable options (single- or multi-select) and a
 * Submit control, plus a live countdown of the island's answer window. On
 * submit the user's per-question option selections are posted to
 * `fleet_question_respond`; the Rust side turns them into the hook's `allow` +
 * `updatedInput.answers` decision so the agent resolves without touching the
 * terminal. After the window lapses the Rust side fails open (the agent's own
 * terminal picker takes over), so the card disables rather than lie.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon } from "lucide-react"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { fleetQuestionRespond } from "@/lib/tauri/fleet"
import { truncateLine } from "@/lib/fleet/format"
import {
  FLEET_PERMISSION_WAIT_MS,
  type PendingQuestion,
  type PendingQuestionRequest,
} from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

export function IslandQuestionActions({
  request,
  questions,
  className,
}: {
  request: PendingQuestionRequest
  questions: PendingQuestion[]
  className?: string
}) {
  const t = useTranslations("fleet")
  // Countdown ticks off the shared fleet ticker (one interval for the whole
  // island) rather than a per-card `setInterval`.
  const nowMs = useNowTicker()
  const [selections, setSelections] = useState<number[][]>(() => questions.map(() => []))
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const remainingSec = useMemo(() => {
    const deadline = request.requestedAt + FLEET_PERMISSION_WAIT_MS
    return Math.max(0, Math.ceil((deadline - nowMs) / 1000))
  }, [request.requestedAt, nowMs])
  const expired = remainingSec <= 0
  const remainingFraction = Math.min(
    1,
    Math.max(0, (remainingSec * 1000) / FLEET_PERMISSION_WAIT_MS)
  )

  const locked = submitting || submitted || expired

  // `selections` is keyed to the request (island-row remounts on a new
  // requestId) and questions are stable within a request, so `selections[qi]`
  // always exists for a rendered question — no nullish guards needed.
  const isSelected = (qi: number, oi: number) => selections[qi].includes(oi)

  // Option buttons are `disabled` while locked, so this only fires on a live
  // card.
  const toggle = (qi: number, oi: number) => {
    setSelections((prev) => {
      const next = prev.map((a) => [...a])
      if (questions[qi].multiSelect) {
        const at = next[qi].indexOf(oi)
        if (at >= 0) next[qi].splice(at, 1)
        else next[qi].push(oi)
      } else {
        // Single-select: the click becomes the sole answer.
        next[qi] = [oi]
      }
      return next
    })
  }

  // Every question needs at least one selected option before we can answer.
  const allAnswered = questions.every((_, qi) => selections[qi].length > 0)

  // The Submit button is `disabled` unless answered and idle, so no re-guard.
  const submit = async () => {
    setSubmitting(true)
    try {
      const ok = await fleetQuestionRespond(request.requestId, selections)
      if (ok) setSubmitted(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      data-testid="island-question-actions"
      className={cn(
        "space-y-1.5 rounded-lg border border-amber-400/25 bg-amber-500/10 px-2 py-1.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200",
        className
      )}
    >
      {questions.map((q, qi) => (
        <div key={qi} className="space-y-1" data-testid={`question-${qi}`}>
          <p className="text-[11px] leading-snug text-amber-100/90">
            {q.header ? (
              <span className="mr-1.5 rounded bg-amber-400/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-200">
                {q.header}
              </span>
            ) : null}
            {q.multiSelect ? (
              <span
                data-testid={`question-multiselect-${qi}`}
                className="mr-1.5 rounded bg-amber-400/15 px-1 py-px text-[9px] font-medium text-amber-200/80"
              >
                {t("row.multiSelect")}
              </span>
            ) : null}
            {truncateLine(q.question, 200)}
          </p>
          {q.options.length > 0 ? (
            <div className="flex flex-wrap gap-1" data-testid={`question-options-${qi}`}>
              {q.options.map((option, oi) => {
                const selected = isSelected(qi, oi)
                return (
                  <button
                    key={oi}
                    type="button"
                    data-testid={`question-option-${qi}-${oi}`}
                    aria-pressed={selected}
                    disabled={locked}
                    onClick={() => toggle(qi, oi)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-60",
                      selected
                        ? "bg-amber-400/90 font-semibold text-slate-900"
                        : "bg-white/10 text-white/75 hover:bg-white/20"
                    )}
                  >
                    {selected ? <CheckIcon className="size-2.5" aria-hidden /> : null}
                    {truncateLine(option, 40)}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      ))}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        {submitted ? (
          <span className="text-[11px] text-white/60" data-testid="question-submitted">
            {t("question.submitted")}
          </span>
        ) : expired ? (
          <span className="text-[11px] text-white/40" data-testid="question-expired">
            {t("question.expired")}
          </span>
        ) : (
          <>
            <span
              className="text-[10px] tabular-nums text-white/40"
              data-testid="question-countdown"
            >
              {t("permission.countdown", { seconds: remainingSec })}
            </span>
            <button
              type="button"
              data-testid="question-submit"
              disabled={submitting || !allAnswered}
              onClick={() => void submit()}
              className="rounded-md bg-amber-500/90 px-2 py-0.5 text-[11px] font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-50"
            >
              {t("question.submit")}
            </button>
          </>
        )}
      </div>

      {!submitted && !expired ? (
        <div
          className="h-0.5 w-full overflow-hidden rounded-full bg-white/10"
          data-testid="question-progress-track"
          aria-hidden
        >
          <div
            data-testid="question-progress"
            className={cn(
              "h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
              remainingSec <= 5 ? "bg-red-400" : "bg-amber-400"
            )}
            style={{ width: `${remainingFraction * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export default IslandQuestionActions
