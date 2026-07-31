"use client"

/**
 * Clarify step for the auto-compose dialog.
 *
 * When the engine's `clarifyObjective` pre-stage returns 1–3 questions for a
 * vague objective, this renders them with answer inputs. It is purely
 * controlled — the dialog owns the `answers` array (parallel to `questions`)
 * and the Skip / Continue actions in its footer; this component only collects
 * the text. Answering is optional: blank answers are simply dropped before the
 * answers are folded back into the objective.
 */

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface AutoComposeClarifyStepProps {
  questions: string[]
  /** Parallel to `questions`; the dialog owns this array. */
  answers: string[]
  onAnswerChange: (index: number, value: string) => void
}

export function AutoComposeClarifyStep({
  questions,
  answers,
  onAnswerChange,
}: AutoComposeClarifyStepProps) {
  const t = useTranslations("agentTeamsWorkspace.autoCompose")

  return (
    <div className="space-y-3" data-testid="auto-compose-clarify">
      <div className="flex items-start gap-2 rounded-md border bg-muted/20 p-3">
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t("clarifyTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("clarifyDescription")}</p>
        </div>
      </div>

      <div className="space-y-3">
        {questions.map((q, i) => (
          <div key={i} className="space-y-1">
            <Label className="text-xs" htmlFor={`auto-compose-clarify-${i}`}>
              {q}
            </Label>
            <Input
              id={`auto-compose-clarify-${i}`}
              value={answers[i] ?? ""}
              onChange={(e) => onAnswerChange(i, e.target.value)}
              placeholder={t("answerPlaceholder")}
              className="text-sm"
              data-testid={`auto-compose-clarify-answer-${i}`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
