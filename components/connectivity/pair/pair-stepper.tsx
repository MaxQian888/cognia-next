"use client"

import { useTranslations } from "next-intl"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type PairStep = "discover" | "pair" | "paired"

const ORDER: readonly PairStep[] = ["discover", "pair", "paired"] as const

export interface PairStepperProps {
  current: PairStep
  /** Subset of steps to render (defaults to all three). The web pair flow
   *  has no LAN discovery step, so it passes `["pair", "paired"]`. */
  steps?: readonly PairStep[]
  className?: string
}

/**
 * Where you are, as a compact row inside the narrative panel.
 *
 * It used to be a full-width `rounded-full bg-muted/40` pill sitting under the
 * page title, with `flex-1` connectors between the labels. In the web flow —
 * two steps across a `max-w-4xl` header — that made the connector the widest
 * element on the screen: a progress bar that never moves, drawn at the size of
 * a hero. The row now sizes to its own content and the connector is a fixed
 * hairline, because its job is to say "these are in sequence", not to fill
 * whatever space the layout happens to have.
 */
export function PairStepper({ current, steps = ORDER, className }: PairStepperProps) {
  const t = useTranslations("mobile.pair.step")
  const currentIdx = steps.indexOf(current)
  return (
    <ol
      role="list"
      aria-label={t("ariaLabel")}
      className={cn("flex items-center gap-2 text-xs", className)}
      data-testid="pair-stepper"
    >
      {steps.map((step, idx) => {
        const status: "done" | "current" | "todo" =
          idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo"
        return (
          <li
            key={step}
            className="flex min-w-0 items-center gap-2"
            aria-current={status === "current" ? "step" : undefined}
            data-status={status}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ring-1 transition-colors",
                status === "done" && "bg-brand-action/15 text-foreground ring-brand-action",
                status === "current" && "bg-background text-foreground ring-foreground",
                status === "todo" && "text-muted-foreground ring-border"
              )}
            >
              {status === "done" ? <CheckIcon className="size-3" aria-hidden="true" /> : idx + 1}
            </span>
            <span
              className={cn(
                "truncate font-medium",
                status === "current" ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {t(step)}
            </span>
            {idx < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "ml-1 h-px w-5 shrink-0 transition-colors",
                  idx < currentIdx ? "bg-brand-action/60" : "bg-border"
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
