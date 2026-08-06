"use client"

/**
 * Mobile counterpart to the island's `IslandQuestionActions` — pick options for
 * a parked AskUserQuestion and send the answer over the companion transport.
 *
 * Without this a question stranded anyone who wasn't sitting at the desktop
 * island: the phone could already *see* the question in the fleet snapshot, but
 * `fleet_question_respond` had no RPC arm, so the only outcome was the hook
 * timing out and falling back to the agent's own terminal picker.
 *
 * Answers are option **indices**, in question order — not labels. The snapshot
 * truncates long option text for display, so a label-keyed answer would fail to
 * match the agent's real options; the Rust side rebuilds the payload from these
 * indices for exactly that reason.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import {
  fleetRemoteQuestionReject,
  fleetRemoteQuestionRespond,
  isControlForbidden,
} from "@/lib/fleet/fleet-remote-actions"
import {
  FLEET_PERMISSION_WAIT_MS,
  type PendingQuestion,
  type PendingQuestionRequest,
} from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

export function MobileFleetQuestionActions({
  request,
  questions,
}: {
  request: PendingQuestionRequest
  questions: PendingQuestion[]
}) {
  const t = useTranslations("mobile.fleet.question")
  const nowMs = useNowTicker()
  const [answering, setAnswering] = useState(false)
  const [answered, setAnswered] = useState(false)
  const [rejected, setRejected] = useState(false)
  // One selection set per question; multi-select questions keep several.
  const [selected, setSelected] = useState<ReadonlySet<number>[]>(() => questions.map(() => new Set()))

  // The answer window is the same budget the permission long-poll uses — both
  // ride the one hook timeout ladder (island 20s < curl 25s < hook 30s).
  const remainingSec = useMemo(
    () => Math.max(0, Math.ceil((request.requestedAt + FLEET_PERMISSION_WAIT_MS - nowMs) / 1000)),
    [request.requestedAt, nowMs]
  )
  const expired = remainingSec <= 0
  const complete = selected.every((set) => set.size > 0)

  const toggle = (qIndex: number, optionIndex: number, multi: boolean) => {
    setSelected((prev) =>
      prev.map((set, i) => {
        if (i !== qIndex) return set
        if (!multi) return new Set([optionIndex])
        const next = new Set(set)
        if (next.has(optionIndex)) next.delete(optionIndex)
        else next.add(optionIndex)
        return next
      })
    )
  }

  const submit = async () => {
    if (answering || answered || rejected || expired || !complete) return
    setAnswering(true)
    try {
      const ok = await fleetRemoteQuestionRespond(
        request.requestId,
        selected.map((set) => [...set].sort((a, b) => a - b))
      )
      if (ok) setAnswered(true)
      else toast.error(t("expired"))
    } catch (err) {
      toast.error(isControlForbidden(err) ? t("controlLost") : t("failed"))
    } finally {
      setAnswering(false)
    }
  }

  const reject = async () => {
    if (answering || answered || rejected || expired) return
    setAnswering(true)
    try {
      const ok = await fleetRemoteQuestionReject(request.requestId)
      if (ok) setRejected(true)
      else toast.error(t("expired"))
    } catch (err) {
      toast.error(isControlForbidden(err) ? t("controlLost") : t("failed"))
    } finally {
      setAnswering(false)
    }
  }

  if (answered) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="mobile-question-answered">
        {t("answered")}
      </p>
    )
  }
  if (rejected) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="mobile-question-rejected">
        {t("rejected")}
      </p>
    )
  }
  if (expired) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="mobile-question-expired">
        {t("expired")}
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="mobile-fleet-question">
      {questions.map((question, qIndex) => (
        <div key={`${qIndex}-${question.question}`} className="space-y-1">
          <p className="text-xs font-medium">
            {question.header ? (
              <span className="mr-1.5 rounded bg-amber-500/15 px-1 py-px text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-300">
                {question.header}
              </span>
            ) : null}
            {question.question}
          </p>
          <div className="flex flex-wrap gap-1.5" data-testid={`mobile-question-options-${qIndex}`}>
            {question.options.map((option, optionIndex) => {
              const active = selected[qIndex]?.has(optionIndex) ?? false
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  data-testid={`mobile-question-option-${qIndex}-${optionIndex}`}
                  onClick={() => toggle(qIndex, optionIndex, question.multiSelect)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-accent"
                  )}
                >
                  {option}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span
          className="text-[11px] tabular-nums text-muted-foreground"
          data-testid="mobile-question-countdown"
        >
          {t("countdown", { seconds: remainingSec })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={answering}
          onClick={() => void reject()}
          data-testid="mobile-question-reject"
        >
          {t("reject")}
        </Button>
        <Button
          size="sm"
          disabled={answering || !complete}
          onClick={() => void submit()}
          data-testid="mobile-question-submit"
        >
          {t("submit")}
        </Button>
      </div>
    </div>
  )
}

export default MobileFleetQuestionActions
