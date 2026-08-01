"use client"

/**
 * The fixed five-step header.
 *
 * Stages are shown as progress, not as navigation: the user cannot jump to
 * "Save" before there is anything to save, and offering it would be a lie about
 * what the flow can do. Completed stages *are* reachable — going back to review
 * after generating is a normal thing to want.
 */

import { useTranslations } from "next-intl"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { STAGES, type RecorderStage } from "@/lib/skills/recording/state-machine"

interface Props {
  current: RecorderStage
  /** Stages the flow has already been through. */
  reached: readonly RecorderStage[]
  onSelect?: (stage: RecorderStage) => void
}

export function RecorderStageHeader({ current, reached, onSelect }: Props) {
  const t = useTranslations("skills.recorder")
  const currentIndex = STAGES.indexOf(current)

  return (
    <ol
      className="flex items-center gap-1 overflow-x-auto px-1 py-2"
      aria-label={t("stages.stepOf", {
        current: currentIndex + 1,
        total: STAGES.length,
      })}
    >
      {STAGES.map((stage, index) => {
        const isCurrent = stage === current
        const isDone = reached.includes(stage) && index < currentIndex
        const canSelect = isDone && Boolean(onSelect)
        return (
          <li key={stage} className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={!canSelect}
              onClick={canSelect ? () => onSelect?.(stage) : undefined}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                isCurrent && "bg-accent text-accent-foreground font-medium",
                !isCurrent && isDone && "text-muted-foreground hover:bg-accent/50",
                !isCurrent && !isDone && "text-muted-foreground/50",
                canSelect ? "cursor-pointer" : "cursor-default"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border text-[10px] leading-none",
                  isCurrent && "border-current",
                  isDone && "border-transparent bg-primary text-primary-foreground"
                )}
              >
                {isDone ? <Check className="size-2.5" /> : index + 1}
              </span>
              {t(`stages.${stage}`)}
            </button>
            {index < STAGES.length - 1 ? (
              <span aria-hidden className="text-muted-foreground/30">
                /
              </span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
