"use client"

import { useTranslations } from "next-intl"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type PairStep = "discover" | "pair" | "paired"

const ORDER: readonly PairStep[] = ["discover", "pair", "paired"] as const

export interface PairStepperProps {
  current: PairStep
  className?: string
}

export function PairStepper({ current, className }: PairStepperProps) {
  const t = useTranslations("mobile.pair.step")
  const currentIdx = ORDER.indexOf(current)
  return (
    <ol
      role="list"
      aria-label={t("ariaLabel")}
      className={cn("flex items-center gap-2 rounded-full bg-muted/40 p-1.5 text-xs", className)}
      data-testid="pair-stepper"
    >
      {ORDER.map((step, idx) => {
        const status: "done" | "current" | "todo" =
          idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo"
        return (
          <li
            key={step}
            className="flex flex-1 items-center gap-2"
            aria-current={status === "current" ? "step" : undefined}
            data-status={status}
          >
            <span
              className={cn(
                "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                status === "done" && "bg-primary text-primary-foreground",
                status === "current" && "bg-primary text-primary-foreground ring-2 ring-primary/25",
                status === "todo" && "bg-background text-muted-foreground border border-border"
              )}
            >
              {status === "done" ? <CheckIcon className="size-3.5" aria-hidden="true" /> : idx + 1}
            </span>
            <span
              className={cn(
                "truncate text-xs font-medium",
                status === "current" ? "text-foreground" : "text-muted-foreground",
                idx === ORDER.length - 1 && "pr-1"
              )}
            >
              {t(step)}
            </span>
            {idx < ORDER.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px flex-1 transition-colors",
                  idx < currentIdx ? "bg-primary/60" : "bg-border"
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
