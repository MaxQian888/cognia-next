"use client"

/**
 * The recorded steps, virtualized.
 *
 * Virtualized because the cap is 500 steps and the review pass is exactly when
 * a user scrolls the whole thing. Rows are fixed-height, so unlike the chat
 * message list this needs no `measureElement` — which also means no
 * ResizeObserver per row, and no measurement thrash while the list is still
 * receiving steps.
 *
 * Excluded steps stay in the list rather than disappearing. Removing them would
 * make the timeline stop matching what the user remembers doing, and "restore"
 * would have nothing to point at.
 */

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AlertCircle, EyeOff, Image as ImageIcon, Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Item } from "@/components/ui/item"
import { cn } from "@/lib/utils"
import type { RecordedStepView } from "@/lib/skills/recording/step-model"

const ROW_HEIGHT = 56
const OVERSCAN = 8

interface Props {
  steps: readonly RecordedStepView[]
  selectedSeq: number | null
  onSelect: (seq: number) => void
  onToggleExclude: (seq: number, excluded: boolean) => void
}

/** One line of prose for a step, from whatever the recorder managed to learn. */
export type StepTranslator = (key: never, values?: never) => string

export function describeStepRow(step: RecordedStepView, translate: StepTranslator): string {
  const t = translate as unknown as (key: string, values?: Record<string, unknown>) => string
  if (step.intent) return step.intent
  const captured = step.captured
  if (!captured) return t("stepKind.manual")
  const target = captured.element?.name ?? captured.element?.automationId ?? captured.ocrHint ?? ""
  if (captured.kind === "type" && captured.text) {
    if (captured.text.kind === "sensitive") return t("review.sensitive")
    if (captured.text.kind === "keys") return captured.text.chord
    return captured.text.value
  }
  return target || t(`stepKind.${captured.kind}`)
}

export function ReviewTimeline({ steps, selectedSeq, onSelect, onToggleExclude }: Props) {
  const t = useTranslations("skills.recorder")
  const scrollRef = useRef<HTMLDivElement>(null)

  // The React Compiler cannot analyse @tanstack/react-virtual; same bail-out as
  // `memory-console.tsx`.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: steps.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  })

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label={t("review.timelineAria")}
      className="h-full overflow-y-auto"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const step = steps[item.index]
          const selected = step.seq === selectedSeq
          return (
            <div
              key={step.seq}
              className="absolute inset-x-0 top-0"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <Item
                role="option"
                aria-selected={selected}
                tabIndex={0}
                onClick={() => onSelect(step.seq)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    onSelect(step.seq)
                  }
                }}
                className={cn(
                  "h-[52px] cursor-pointer gap-2 rounded-none border-l-2 px-2 py-0 text-sm",
                  selected
                    ? "border-l-primary bg-accent/40"
                    : "border-l-transparent hover:bg-accent/20",
                  step.excluded && "opacity-50",
                  "focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                <span
                  aria-hidden
                  className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                >
                  {item.index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{describeStepRow(step, t)}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {step.manual ? t("review.manualBadge") : null}
                    {step.needsIntent ? (
                      <span className="flex items-center gap-0.5 text-destructive">
                        <AlertCircle className="size-3" aria-hidden />
                        {t("review.needsIntent")}
                      </span>
                    ) : null}
                    {step.screenshotSelected ? (
                      <ImageIcon className="size-3" aria-label={t("review.screenshotSelect")} />
                    ) : null}
                    {step.excluded ? t("review.excluded") : null}
                  </span>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  aria-label={step.excluded ? t("review.restore") : t("review.exclude")}
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleExclude(step.seq, !step.excluded)
                  }}
                >
                  {step.excluded ? (
                    <Undo2 className="size-3.5" aria-hidden />
                  ) : (
                    <EyeOff className="size-3.5" aria-hidden />
                  )}
                </Button>
              </Item>
            </div>
          )
        })}
      </div>
    </div>
  )
}
